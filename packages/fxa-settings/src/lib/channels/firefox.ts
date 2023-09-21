/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export enum FirefoxCommand {
  AccountDeleted = 'fxaccounts:delete',
  ProfileChanged = 'profile:change',
  PasswordChanged = 'fxaccounts:change_password',
  FxAStatus = 'fxaccounts:fxa_status',
  Login = 'fxaccounts:login',
  Logout = 'fxaccounts:logout',
  Loaded = 'fxaccounts:loaded',
  Error = 'fxError',
  OAuthLogin = 'fxaccounts:oauth_login',
  CanLinkAccount = 'fxaccounts:can_link_account',
}

const DEFAULT_SEND_TIMEOUT_LENGTH_MS: number = 5 * 1000; // 5 seconds in milliseconds

export interface FirefoxMessageDetail {
  id: string;
  message?: FirefoxMessage;
}

export interface FirefoxMessage {
  command: FirefoxCommand;
  data: Record<string, any> & {
    error?: {
      message: string;
      stack: string;
    };
  };
  messageId: string;
  error?: string;
}

export interface FirefoxMessageError {
  error?: string;
  stack?: string;
}

interface ProfileUid {
  uid: hexstring;
}

interface ProfileMetricsEnabled {
  metricsEnabled: boolean;
}

type Profile = ProfileUid | ProfileMetricsEnabled;
type FirefoxEvent = CustomEvent<FirefoxMessageDetail | string>;

// This is defined in the Firefox source code:
// https://searchfox.org/mozilla-central/source/services/fxaccounts/tests/xpcshell/test_web_channel.js#348
type FxAStatusRequest = {
  service?: string; // ex. 'sync'
  context?: string; // ex. 'fx_desktop_v3'
};

export type FxAStatusResponse = {
  capabilities: {
    engines: string[];
    multiService: boolean;
    pairing: boolean;
    choose_what_to_sync?: boolean;
  };
  clientId?: string;
  signedInUser?: SignedInUser;
};

export type SignedInUser = {
  email: string;
  sessionToken: string;
  uid: string;
  verified: boolean;
};

export type FxALoginRequest = {
  email: string;
  keyFetchToken: hexstring;
  sessionToken: hexstring;
  uid: hexstring;
  unwrapBKey: string;
  verified: boolean;
  services?: {
    sync: {
      offeredEngines: string[];
      declinedEngines: string[];
    };
  };
};

// ref: [FxAccounts.sys.mjs](https://searchfox.org/mozilla-central/rev/82828dba9e290914eddd294a0871533875b3a0b5/services/fxaccounts/FxAccounts.sys.mjs#910)
export type FxALoginSignedInUserRequest = {
  authAt: number;
  email: string;
  keyFetchToken: hexstring;
  sessionToken: hexstring;
  uid: hexstring;
  unwrapBKey: string;
  verified: boolean;
};

export type FxAOAuthLogin = {
  action: string;
  code: string;
  redirect: string;
  state: string;
  // For sync mobile
  declinedSyncEngines?: string[];
  offeredSyncEngines?: string[];
};

// ref: https://searchfox.org/mozilla-central/rev/82828dba9e290914eddd294a0871533875b3a0b5/services/fxaccounts/FxAccountsWebChannel.sys.mjs#230
export type FxACanLinkAccount = {
  email: string;
};

let messageIdSuffix = 0;
/**
 * Create a messageId for a given command/data combination.
 *
 * messageId is sent to the relier who is expected to respond
 * with the same messageId. Used to keep track of outstanding requests
 * and is required in at least Firefox iOS to send back a response.
 * */
function createMessageId() {
  // If two messages are created within the same millisecond, Date.now()
  // returns the same value. Append a suffix that ensures uniqueness.
  return `${Date.now()}${++messageIdSuffix}`;
}

interface WebChannelRequest {
  command: FirefoxCommand;
  messageId: string;
  timeoutId?: number;
  reject(reason?: any): void;
  resolve(value?: any): void;
}

interface OutstandingRequestOptions {
  window: Window;
  sendTimeoutLength?: number;
}

/**
 * OutstandingRequests manages all Firefox WebChannel requests that
 * the web application is waiting for a response for.
 *
 * This is particularly useful for the fxastatus request, where the the
 * web application is requesting the signed in user data from the browser.
 */
class OutstandingRequests {
  private window_: Window;
  private sendTimeoutLength: number;
  private requests: { [key: string]: WebChannelRequest };
  constructor(options: OutstandingRequestOptions) {
    this.window_ = options.window;
    this.requests = {};
    this.sendTimeoutLength =
      options.sendTimeoutLength || DEFAULT_SEND_TIMEOUT_LENGTH_MS;
  }

  add(messageId: string, request: WebChannelRequest) {
    this.remove(messageId);
    request.timeoutId = this.window_.setTimeout(() => {
      request.reject();
      this.remove(messageId);
    }, this.sendTimeoutLength);
    this.requests[messageId] = request;
  }

  resolve(message: FirefoxMessage) {
    const outstanding = this.requests[message.messageId];
    if (outstanding) {
      outstanding.resolve(message.data);
      this.remove(message.messageId);
    }
  }

  reject(messageId: string, error: FirefoxMessageError) {
    const outstanding = this.requests[messageId];
    if (outstanding) {
      outstanding.reject(error);
      this.remove(messageId);
    }
  }

  remove(messageId: string) {
    const outstanding = this.requests[messageId];
    if (outstanding) {
      this.window_.clearTimeout(outstanding.timeoutId);
      delete this.requests[messageId];
    }
  }
}

export class Firefox extends EventTarget {
  private broadcastChannel?: BroadcastChannel;
  private outstandingRequests: OutstandingRequests;
  readonly id: string;
  constructor() {
    super();
    this.id = 'account_updates';
    this.outstandingRequests = new OutstandingRequests({ window });

    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel('firefox_accounts');
      this.broadcastChannel.addEventListener('message', (event) =>
        this.handleBroadcastEvent(event)
      );
    }
    window.addEventListener('WebChannelMessageToContent', (event) =>
      this.handleFirefoxEvent(event as FirefoxEvent)
    );
  }

  private handleBroadcastEvent(event: MessageEvent) {
    console.debug('broadcast', event);
    const envelope = JSON.parse(event.data);
    this.dispatchEvent(
      new CustomEvent(envelope.name, { detail: envelope.data })
    );
  }

  private handleFirefoxEvent(event: FirefoxEvent) {
    console.debug('webchannel', event);
    try {
      const detail =
        typeof event.detail === 'string'
          ? (JSON.parse(event.detail) as FirefoxMessageDetail)
          : event.detail;
      if (detail.id !== this.id) {
        return;
      }
      const message = detail.message;
      if (message) {
        if (message.error || message.data.error) {
          const error = {
            message: message.error || message.data.error?.message,
            stack: message.data.error?.stack,
          };
          this.outstandingRequests.reject(message.messageId, error);
          this.dispatchEvent(
            new CustomEvent(FirefoxCommand.Error, { detail: error })
          );
        } else {
          this.outstandingRequests.resolve(message);
          this.dispatchEvent(
            new CustomEvent(message.command, { detail: message.data })
          );
        }
      }
    } catch (e) {
      // TODO: log and ignore
    }
  }

  private formatEventDetail(
    command: FirefoxCommand,
    data: any,
    messageId: string = createMessageId()
  ) {
    const detail = {
      id: this.id,
      message: {
        command,
        data,
        messageId,
      },
    };

    // Firefox Desktop and Fennec >= 50 expect the detail to be
    // sent as a string and fxios as an object.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=1275616 and
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1238128
    if (navigator.userAgent.toLowerCase().includes('fxios')) {
      return detail;
    }
    return JSON.stringify(detail);
  }

  // Send a message to the browser chrome
  // does not wait for a response
  send(command: FirefoxCommand, data: any) {
    const detail = this.formatEventDetail(command, data);
    window.dispatchEvent(
      new CustomEvent('WebChannelMessageToChrome', {
        detail,
      })
    );
  }

  // Request a message from the browser chrome
  // returns a promise that resolves when a response arrives
  // rejects if an error is received from the browser, or
  // if the request times out.
  request<T>(command: FirefoxCommand, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const messageId = createMessageId();
      const detail = this.formatEventDetail(command, data, messageId);
      this.outstandingRequests.add(messageId, {
        command,
        messageId,
        resolve,
        reject,
      });
      window.dispatchEvent(
        new CustomEvent('WebChannelMessageToChrome', {
          detail,
        })
      );
    });
  }

  // broadcast a message to other tabs
  broadcast(name: FirefoxCommand, data: any) {
    this.broadcastChannel?.postMessage(JSON.stringify({ name, data }));
  }

  accountDeleted(uid: hexstring) {
    this.send(FirefoxCommand.AccountDeleted, { uid });
    this.broadcast(FirefoxCommand.AccountDeleted, { uid });
  }

  passwordChanged(
    email: string,
    uid: hexstring,
    sessionToken: hexstring,
    verified: boolean,
    keyFetchToken?: hexstring,
    unwrapBKey?: hexstring
  ) {
    this.send(FirefoxCommand.PasswordChanged, {
      email,
      uid,
      sessionToken,
      verified,
      keyFetchToken,
      unwrapBKey,
    });
    this.broadcast(FirefoxCommand.PasswordChanged, {
      uid,
    });
  }

  profileChanged(profile: Profile) {
    this.send(FirefoxCommand.ProfileChanged, profile);
    this.broadcast(FirefoxCommand.ProfileChanged, profile);
  }

  fxaStatus(options: FxAStatusRequest): Promise<FxAStatusResponse> {
    return this.request(FirefoxCommand.FxAStatus, options);
  }

  async fxaLogin(options: FxALoginRequest): Promise<void> {
    this.send(FirefoxCommand.Login, options);

    // In Playwright, we need to wait for the browser to send a web channel message
    // in response to the fxaLogin command. Without this we navigate the user before
    // the login completes, resulting in an "Invalid token" error on the next page.
    // This does not appear to be a problem otherwise, so we only listen for a response
    // if the `automatedBrowser` param is present, else we resolve immediately.
    return new Promise((resolve) => {
      const eventHandler = (event: Event) => {
        const firefoxEvent = event as FirefoxEvent;
        // we don't need to call this.handleFirefoxEvent here because it's
        // handled in the constructor. We just want to resolve the promise
        // if the event is what we expect.
        const detail =
          typeof firefoxEvent.detail === 'string'
            ? (JSON.parse(firefoxEvent.detail) as FirefoxMessage)
            : firefoxEvent.detail;
        if (detail.id !== this.id) {
          return;
        }

        window.removeEventListener('WebChannelMessageToContent', eventHandler);
        resolve();
      };

      if (new URLSearchParams(window.location.search).get('automatedBrowser')) {
        window.addEventListener('WebChannelMessageToContent', eventHandler);
      } else {
        resolve();
      }
    });
  }

  fxaLoginSignedInUser(options: FxALoginSignedInUserRequest) {
    this.send(FirefoxCommand.Login, options);
  }

  fxaLogout(options: { uid: string }) {
    this.send(FirefoxCommand.Logout, options);
  }

  fxaLoaded(options: any) {
    this.send(FirefoxCommand.Loaded, options);
  }

  fxaOAuthLogin(options: FxAOAuthLogin) {
    this.send(FirefoxCommand.OAuthLogin, options);
  }

  fxaCanLinkAccount(options: FxACanLinkAccount) {
    this.send(FirefoxCommand.Login, options);
  }
}

// Some non-firefox legacy browsers can't extend EventTarget.
// For those we can safely return a mock instance that
// implements the interface but does nothing because
// this functionality is only meant for firefox.
let canUseEventTarget = true;
try {
  new EventTarget();
} catch (e) {
  canUseEventTarget = false;
}
function noop() {}
export const firefox = canUseEventTarget
  ? new Firefox()
  : // otherwise a mock
    (Object.fromEntries(
      Object.getOwnPropertyNames(Firefox.prototype)
        .map((name) => [name, noop])
        .concat([
          ['addEventListener', noop],
          ['removeEventListener', noop],
          ['dispatchEvent', noop],
        ])
    ) as unknown as Firefox);

export default firefox;
