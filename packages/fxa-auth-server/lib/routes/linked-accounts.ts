/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { AuthLogger, AuthRequest, ProfileClient } from '../types';
import { ConfigType } from '../../config';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import * as uuid from 'uuid';
import * as random from '../crypto/random';
import * as jose from 'jose';
import validators from './validators';
import Joi from 'joi';
import {
  Provider,
  PROVIDER_NAME,
} from 'fxa-shared/db/models/auth/linked-account';
import THIRD_PARTY_AUTH_DOCS from '../../docs/swagger/third-party-auth-api';

const METRICS_CONTEXT_SCHEMA = require('../metrics/context').schema;

const error = require('../error');

const MS_ONE_HOUR = 1000 * 60 * 60;

const appleAud = 'https://appleid.apple.com';

export class LinkedAccountHandler {
  private googleAuthClient?: OAuth2Client;
  private tokenCodeLifetime: number;

  constructor(
    private log: AuthLogger,
    private db: any,
    private config: ConfigType,
    private mailer: any,
    private profile: ProfileClient,
  ) {
    const tokenCodeConfig = config.signinConfirmation.tokenVerificationCode;
    this.tokenCodeLifetime =
      (tokenCodeConfig?.codeLifetime as unknown as number) ?? MS_ONE_HOUR;

    if (config.googleAuthConfig && config.googleAuthConfig.clientId) {
      this.googleAuthClient = new OAuth2Client(
        config.googleAuthConfig.clientId
      );
    }
  }

  // As generated tokens expire after 6 months (180 days) per Apple documentation,
  // generate JWT for client secret on each request instead
  async generateAppleClientSecret(
    clientId: string,
    keyId: string,
    privateKey: string,
    teamId: string
  ) {
    const ecPrivateKey = await jose.importPKCS8(privateKey, 'ES256');

    const jwt = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuedAt()
      .setIssuer(teamId)
      .setAudience(appleAud)
      .setExpirationTime('1m')
      .setSubject(clientId)
      .sign(ecPrivateKey);

    return jwt;
  }

  async loginOrCreateAccount(request: AuthRequest) {
    const requestPayload = request.payload as any;

    const provider = requestPayload.provider as Provider;

    // Currently, FxA supports creating a linked account via the oauth authorization flow
    // This flow returns an `id_token` which is used create/get FxA account.
    let idToken: any;
    const code = requestPayload.code;

    switch (provider) {
      case 'google': {
        if (!this.googleAuthClient) {
          throw error.thirdPartyAccountError();
        }

        const { clientId, clientSecret, redirectUri } =
          this.config.googleAuthConfig;
        let rawIdToken;
        if (code) {
          const data = {
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          };

          try {
            const res = await axios.post(
              this.config.googleAuthConfig.tokenEndpoint,
              data
            );
            // We currently only use the `id_token` after completing the
            // authorization code exchange. In the future we could store a
            // refresh token to do other things like revoking sessions.
            //
            // See https://developers.google.com/identity/protocols/oauth2/openid-connect#exchangecode
            rawIdToken = res.data['id_token'];

            const verifiedToken = await this.googleAuthClient.verifyIdToken({
              idToken: rawIdToken,
              audience: clientId,
            });

            idToken = verifiedToken.getPayload();
          } catch (err) {
            this.log.error('linked_account.code_exchange_error', err);
            throw error.thirdPartyAccountError();
          }
        }
        break;
      }
      case 'apple': {
        const { clientId, keyId, privateKey, teamId } =
          this.config.appleAuthConfig;

        if (!clientId || !keyId || !privateKey || !teamId) {
          throw error.thirdPartyAccountError();
        }

        let rawIdToken;
        const clientSecret = await this.generateAppleClientSecret(
          clientId,
          keyId,
          privateKey,
          teamId
        );
        const code = requestPayload.code;
        if (code) {
          const data = {
            code,
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
          };

          try {
            const res = await axios.post(
              this.config.appleAuthConfig.tokenEndpoint,
              new URLSearchParams(data).toString()
            );
            rawIdToken = res.data['id_token'];
            idToken = jose.decodeJwt(rawIdToken);

          } catch (err) {
            this.log.error('linked_account.code_exchange_error', err);
            throw error.thirdPartyAccountError();
          }
        }
        break;
      }
    }

    if (!idToken) {
      throw error.thirdPartyAccountError();
    }

    const userid = idToken.sub;
    const email = idToken.email;
    const name = idToken.name;
    const avatarUrl = idToken.picture;

    let accountRecord;
    let linkedAccountRecord = await this.db.getLinkedAccount(userid, provider);

    if (!linkedAccountRecord) {
      try {
        // This is a new third party account linking an existing FxA account
        accountRecord = await this.db.accountRecord(email);
        await this.db.createLinkedAccount(accountRecord.uid, userid, provider);
        if (name) {
          await this.profile.updateDisplayName(accountRecord.uid, name);
        }
        if (avatarUrl){
          await this.profile.updateAvatarWithUrl(accountRecord.uid, avatarUrl);
        }

        const geoData = request.app.geo;
        const ip = request.app.clientAddress;
        const { deviceId, flowId, flowBeginTime } = await request.app
          .metricsContext;
        const emailOptions = {
          acceptLanguage: request.app.acceptLanguage,
          deviceId,
          flowId,
          flowBeginTime,
          ip,
          location: geoData.location,
          providerName: PROVIDER_NAME[provider],
          timeZone: geoData.timeZone,
          uaBrowser: request.app.ua.browser,
          uaBrowserVersion: request.app.ua.browserVersion,
          uaOS: request.app.ua.os,
          uaOSVersion: request.app.ua.osVersion,
          uaDeviceType: request.app.ua.deviceType,
          uid: accountRecord.uid,
        };
        await this.mailer.sendPostAddLinkedAccountEmail(
          accountRecord.emails,
          accountRecord,
          emailOptions
        );
        request.setMetricsFlowCompleteSignal('account.login', 'login');
        await request.emitMetricsEvent('account.login', {
          uid: accountRecord.uid,
        });
      } catch (err) {
        this.log.trace(
          'Account.login.sendPostAddLinkedAccountNotification.error',
          {
            error: err,
          }
        );

        if (err.errno !== error.ERRNO.ACCOUNT_UNKNOWN) {
          throw err;
        }
        // This is a new user creating a new FxA account, we
        // create the FxA account with random password and mark email
        // verified
        const emailCode = await random.hex(16);
        const authSalt = await random.hex(32);
        const [kA, wrapWrapKb] = await random.hex(32, 32);
        accountRecord = await this.db.createAccount({
          uid: uuid.v4({}, Buffer.alloc(16)).toString('hex'),
          createdAt: Date.now(),
          email,
          emailCode,
          emailVerified: true,
          kA,
          wrapWrapKb,
          authSalt,
          verifierVersion: this.config.verifierVersion,
          verifyHash: Buffer.alloc(32).toString('hex'),
          verifierSetAt: 0,
          locale: request.app.acceptLanguage,
        });
        await this.db.createLinkedAccount(accountRecord.uid, userid, provider);
        if (name) {
          await this.profile.updateDisplayName(accountRecord.uid, name);
        }

        if (avatarUrl) {
          await this.profile.updateAvatarWithUrl(accountRecord.uid, avatarUrl);
        }

        // Currently, we treat accounts created from a linked account as a new
        // registration and emit the correspond event. Note that depending on
        // where might not be a top of funnel for this completion event.
        request.setMetricsFlowCompleteSignal(
          'account.verified',
          'registration'
        );
        await request.emitMetricsEvent('account.verified', {
          uid: accountRecord.uid,
        });
      }
    } else {
      // This is an existing user and existing FxA user
      accountRecord = await this.db.account(linkedAccountRecord.uid);
      request.setMetricsFlowCompleteSignal('account.login', 'login');
      await request.emitMetricsEvent('account.login', {
        uid: accountRecord.uid,
      });
    }

    const sessionTokenOptions = {
      uid: accountRecord.uid,
      email: accountRecord.primaryEmail.email,
      emailCode: accountRecord.primaryEmail.emailCode,
      emailVerified: accountRecord.primaryEmail.isVerified,
      verifierSetAt: accountRecord.verifierSetAt,
      mustVerify: false,
      tokenVerificationCodeExpiresAt: Date.now() + this.tokenCodeLifetime,
      uaBrowser: request.app.ua.browser,
      uaBrowserVersion: request.app.ua.browserVersion,
      uaOS: request.app.ua.os,
      uaOSVersion: request.app.ua.osVersion,
      uaDeviceType: request.app.ua.deviceType,
      uaFormFactor: request.app.ua.formFactor,
    };

    const sessionToken = await this.db.createSessionToken(sessionTokenOptions);

    return {
      uid: sessionToken.uid,
      sessionToken: sessionToken.data,
      providerUid: userid,
    };
  }

  async unlinkAccount(request: AuthRequest) {
    if (!this.googleAuthClient) {
      throw error.thirdPartyAccountError();
    }
    const uid = request.auth.credentials.uid;
    const provider = (request.payload as any).provider.toLowerCase();
    // TODO: here we'll also delete any session tokens created via a google login
    await this.db.deleteLinkedAccount(uid, provider);
    return {
      success: true,
    };
  }
}

export const linkedAccountRoutes = (
  log: AuthLogger,
  db: any,
  config: ConfigType,
  mailer: any,
  profile: ProfileClient,
) => {
  const handler = new LinkedAccountHandler(log, db, config, mailer, profile);

  return [
    {
      method: 'POST',
      path: '/linked_account/login',
      options: {
        ...THIRD_PARTY_AUTH_DOCS.LINKED_ACCOUNT_LOGIN_POST,
        validate: {
          payload: Joi.object({
            idToken: validators.thirdPartyIdToken,
            provider: validators.thirdPartyProvider,
            code: validators.thirdPartyOAuthCode,
            metricsContext: METRICS_CONTEXT_SCHEMA,
          }),
        },
      },
      handler: async (request: AuthRequest) =>
        handler.loginOrCreateAccount(request),
    },
    {
      method: 'POST',
      path: '/linked_account/unlink',
      options: {
        ...THIRD_PARTY_AUTH_DOCS.LINKED_ACCOUNT_UNLINK_POST,
        auth: {
          strategy: 'sessionToken',
        },
        validate: {
          payload: Joi.object({
            provider: validators.thirdPartyProvider,
          }),
        },
      },
      handler: (request: AuthRequest) => handler.unlinkAccount(request),
    },
  ];
};

module.exports = {
  linkedAccountRoutes,
  LinkedAccountHandler,
};
