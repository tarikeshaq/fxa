/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const path = require('path');

const buf = require('buf').hex;
const hex = require('buf').to.hex;
const mysql = require('mysql');
const MysqlPatcher = require('mysql-patcher');

const encrypt = require('../../encrypt');
const P = require('../../../promise');
const ScopeSet = require('../../../../../fxa-shared').oauth.scopes;
const unique = require('../../unique');
const AccessToken = require('../accessToken');
const patch = require('./patch');

const REQUIRED_SQL_MODES = ['STRICT_ALL_TABLES', 'NO_ENGINE_SUBSTITUTION'];
const REQUIRED_CHARSET = 'UTF8MB4_UNICODE_CI';

// logger is not const to support mocking in the unit tests
var logger = require('../../logging')('db.mysql');

function MysqlStore(options) {
  if (options.charset && options.charset !== REQUIRED_CHARSET) {
    logger.warn('createDatabase.invalidCharset', { charset: options.charset });
    throw new Error('You cannot use any charset besides ' + REQUIRED_CHARSET);
  } else {
    options.charset = REQUIRED_CHARSET;
  }
  options.typeCast = function(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      return field.string() === '1';
    }
    return next();
  };
  logger.info('pool.create', { options: options });
  var pool = (this._pool = mysql.createPool(options));
  pool.on('enqueue', function() {
    logger.info('pool.enqueue', {
      queueLength: pool._connectionQueue && pool._connectionQueue.length,
    });
  });
}

// Apply patches up to the current patch level.
// This will also create the DB if it is missing.

function updateDbSchema(patcher) {
  logger.verbose('updateDbSchema', patcher.options);

  var d = P.defer();
  patcher.patch(function(err) {
    if (err) {
      logger.error('updateDbSchema', err);
      return d.reject(err);
    }
    d.resolve();
  });

  return d.promise;
}

// Sanity-check that we're working with a compatible patch level.

function checkDbPatchLevel(patcher) {
  logger.verbose('checkDbPatchLevel', patcher.options);

  var d = P.defer();

  patcher.readDbPatchLevel(function(err) {
    if (err) {
      return d.reject(err);
    }

    // We can run if we're at or above some patch level.  Should be
    // equal at initial deployment, and may be one or more higher
    // later on, due to database changes in preparation for the next
    // release.
    if (patcher.currentPatchLevel >= patch.level) {
      return d.resolve();
    }

    err = 'unexpected db patch level: ' + patcher.currentPatchLevel;
    return d.reject(new Error(err));
  });

  return d.promise;
}

MysqlStore.connect = function mysqlConnect(options) {
  if (options.logger) {
    logger = options.logger;
  }

  options.createDatabase = options.createSchema;
  options.dir = path.join(__dirname, 'patches');
  options.metaTable = 'dbMetadata';
  options.patchKey = 'schema-patch-level';
  options.patchLevel = patch.level;
  options.mysql = mysql;
  var patcher = new MysqlPatcher(options);

  return P.promisify(patcher.connect, { context: patcher })()
    .then(function() {
      if (options.createSchema) {
        return updateDbSchema(patcher);
      }
    })
    .then(function() {
      return checkDbPatchLevel(patcher);
    })
    .catch(function(error) {
      logger.error('checkDbPatchLevel', error);
      throw error;
    })
    .finally(function() {
      return P.promisify(patcher.end, { context: patcher })();
    })
    .then(function() {
      return new MysqlStore(options);
    });
};

const QUERY_GET_LOCK = 'SELECT GET_LOCK(?, ?) AS acquired';
const QUERY_CLIENT_REGISTER =
  'INSERT INTO clients ' +
  '(id, name, imageUri, hashedSecret, hashedSecretPrevious, redirectUri,' +
  'trusted, allowedScopes, canGrant, publicClient) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);';
const QUERY_CLIENT_DEVELOPER_INSERT =
  'INSERT INTO clientDevelopers ' +
  '(rowId, developerId, clientId) ' +
  'VALUES (?, ?, ?);';
const QUERY_CLIENT_DEVELOPER_LIST_BY_CLIENT_ID =
  'SELECT developers.email, developers.createdAt ' +
  'FROM clientDevelopers, developers ' +
  'WHERE clientDevelopers.developerId = developers.developerId ' +
  'AND clientDevelopers.clientId=?;';
const QUERY_DEVELOPER_OWNS_CLIENT =
  'SELECT clientDevelopers.rowId ' +
  'FROM clientDevelopers, developers ' +
  'WHERE developers.developerId = clientDevelopers.developerId ' +
  'AND developers.email =? AND clientDevelopers.clientId =?;';
const QUERY_DEVELOPER_INSERT =
  'INSERT INTO developers ' + '(developerId, email) ' + 'VALUES (?, ?);';
const QUERY_CLIENT_GET = 'SELECT * FROM clients WHERE id=?';
const QUERY_CLIENT_LIST =
  'SELECT id, name, redirectUri, imageUri, ' +
  'canGrant, publicClient, trusted ' +
  'FROM clients, clientDevelopers, developers ' +
  'WHERE clients.id = clientDevelopers.clientId AND ' +
  'developers.developerId = clientDevelopers.developerId AND ' +
  'developers.email =?;';
const QUERY_CLIENT_UPDATE =
  'UPDATE clients SET ' +
  'name=COALESCE(?, name), imageUri=COALESCE(?, imageUri), ' +
  'hashedSecret=COALESCE(?, hashedSecret), ' +
  'hashedSecretPrevious=COALESCE(?, hashedSecretPrevious), ' +
  'redirectUri=COALESCE(?, redirectUri), ' +
  'trusted=COALESCE(?, trusted), allowedScopes=COALESCE(?, allowedScopes), ' +
  'canGrant=COALESCE(?, canGrant) ' +
  'WHERE id=?';
// This query deletes everything related to the client, and is thus quite expensive!
// Don't worry, it's not exposed to any production-facing routes.
const QUERY_CLIENT_DELETE =
  'DELETE clients, codes, tokens, refreshTokens, clientDevelopers ' +
  'FROM clients ' +
  'LEFT JOIN codes ON clients.id = codes.clientId ' +
  'LEFT JOIN tokens ON clients.id = tokens.clientId ' +
  'LEFT JOIN refreshTokens ON clients.id = refreshTokens.clientId ' +
  'LEFT JOIN clientDevelopers ON clients.id = clientDevelopers.clientId ' +
  'WHERE clients.id=?';
const QUERY_CODE_INSERT =
  'INSERT INTO codes (clientId, userId, email, scope, authAt, amr, aal, offline, code, codeChallengeMethod, codeChallenge, keysJwe, profileChangedAt, sessionTokenId) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const QUERY_ACCESS_TOKEN_INSERT =
  'INSERT INTO tokens (clientId, userId, email, scope, type, expiresAt, ' +
  'token, profileChangedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const QUERY_REFRESH_TOKEN_INSERT =
  'INSERT INTO refreshTokens (clientId, userId, email, scope, token, profileChangedAt) VALUES ' +
  '(?, ?, ?, ?, ?, ?)';
// Access token storage in redis annotates each token with client metadata,
// so we do the same when reading from MySQL, for consistency.
// Note that the `token` field stores the hash of the token rather than the raw token,
// and hence would more properly be called `tokenId`.
const QUERY_ACCESS_TOKEN_FIND =
  'SELECT tokens.token AS tokenId, tokens.clientId, tokens.createdAt, ' +
  '  tokens.userId, tokens.email, tokens.scope, ' +
  '  tokens.createdAt, tokens.expiresAt, tokens.profileChangedAt, ' +
  '  clients.name as clientName, clients.canGrant AS clientCanGrant, ' +
  '  clients.publicClient ' +
  'FROM tokens LEFT OUTER JOIN clients ON clients.id = tokens.clientId ' +
  'WHERE tokens.token=?';
const QUERY_REFRESH_TOKEN_FIND = 'SELECT * FROM refreshTokens where token=?';
const QUERY_REFRESH_TOKEN_LAST_USED_UPDATE =
  'UPDATE refreshTokens SET lastUsedAt=? WHERE token=?';
const QUERY_CODE_FIND = 'SELECT * FROM codes WHERE code=?';
const QUERY_CODE_DELETE = 'DELETE FROM codes WHERE code=?';
const QUERY_ACCESS_TOKEN_DELETE = 'DELETE FROM tokens WHERE token=?';
const QUERY_REFRESH_TOKEN_DELETE = 'DELETE FROM refreshTokens WHERE token=?';
const QUERY_ACCESS_TOKEN_DELETE_USER = 'DELETE FROM tokens WHERE userId=?';
// These next two queries can be very expensive if MySQL
// tries to filter by clientId before userId, so we add
// an explicit index hint to help ensure this doesn't happen.
const QUERY_DELETE_ACCESS_TOKEN_FOR_PUBLIC_CLIENTS =
  'DELETE tokens ' +
  'FROM tokens FORCE INDEX (tokens_user_id)' +
  'INNER JOIN clients ON tokens.clientId = clients.id ' +
  'WHERE tokens.userId=? AND (clients.publicClient = 1 OR clients.canGrant = 1)';
const QUERY_DELETE_REFRESH_TOKEN_FOR_PUBLIC_CLIENTS =
  'DELETE refreshTokens ' +
  'FROM refreshTokens FORCE INDEX (tokens_user_id)' +
  'INNER JOIN clients ON refreshTokens.clientId = clients.id ' +
  'WHERE refreshTokens.userId=? AND (clients.publicClient = 1 OR clients.canGrant = 1)';
const QUERY_REFRESH_TOKEN_DELETE_USER =
  'DELETE FROM refreshTokens WHERE userId=?';
const QUERY_CODE_DELETE_USER = 'DELETE FROM codes WHERE userId=?';
const QUERY_DEVELOPER = 'SELECT * FROM developers WHERE email=?';
const QUERY_DEVELOPER_DELETE =
  'DELETE developers, clientDevelopers ' +
  'FROM developers ' +
  'LEFT JOIN clientDevelopers ON developers.developerId = clientDevelopers.developerId ' +
  'WHERE developers.email=?';
// When listing access tokens, we deliberately do not exclude tokens that have expired.
// Such tokens will be cleaned up by a background job, except for those belonging to Pocket, which might
// one day come back to life as refresh tokens. (ref https://bugzilla.mozilla.org/show_bug.cgi?id=1547902).
// There's minimal downside to showing tokens in the brief period between when they expire and when
// they get deleted from the db.
const QUERY_LIST_ACCESS_TOKENS_BY_UID =
  'SELECT tokens.token AS tokenId, tokens.clientId, tokens.createdAt, ' +
  '  tokens.userId, tokens.email, tokens.scope, ' +
  '  tokens.createdAt, tokens.expiresAt, tokens.profileChangedAt, ' +
  '  clients.name as clientName, clients.canGrant AS clientCanGrant, ' +
  '  clients.publicClient ' +
  'FROM tokens LEFT OUTER JOIN clients ON clients.id = tokens.clientId ' +
  'WHERE tokens.userId=?';
const QUERY_LIST_REFRESH_TOKENS_BY_UID =
  'SELECT refreshTokens.token AS refreshTokenId, refreshTokens.clientId, refreshTokens.createdAt, refreshTokens.lastUsedAt, ' +
  '  refreshTokens.scope, clients.name as clientName, clients.canGrant AS clientCanGrant ' +
  'FROM refreshTokens LEFT OUTER JOIN clients ON clients.id = refreshTokens.clientId ' +
  'WHERE refreshTokens.userId=?';
const QUERY_LIST_REFRESH_TOKENS_BY_CLIENT_ID =
  'SELECT refreshTokens.createdAt, refreshTokens.userId FROM refreshTokens WHERE refreshTokens.clientId=?';
const DELETE_ACTIVE_CODES_BY_CLIENT_AND_UID =
  'DELETE FROM codes WHERE clientId=? AND userId=?';
const DELETE_ACTIVE_TOKENS_BY_CLIENT_AND_UID =
  'DELETE FROM tokens WHERE clientId=? AND userId=?';
const DELETE_ACTIVE_REFRESH_TOKENS_BY_CLIENT_AND_UID =
  'DELETE FROM refreshTokens WHERE clientId=? AND userId=?';
const DELETE_REFRESH_TOKEN_WITH_CLIENT_AND_UID =
  'DELETE FROM refreshTokens WHERE token=? AND clientId=? AND userId=?';

// Scope queries
const QUERY_SCOPE_FIND = 'SELECT * ' + 'FROM scopes ' + 'WHERE scopes.scope=?;';
const QUERY_SCOPES_INSERT =
  'INSERT INTO scopes (scope, hasScopedKeys) ' + 'VALUES (?, ?);';

function firstRow(rows) {
  return rows[0];
}

function releaseConn(connection) {
  connection.release();
}

MysqlStore.prototype = {
  ping: function ping() {
    logger.debug('ping');
    // see bluebird.using():
    // https://github.com/petkaantonov/bluebird/blob/master/API.md#resource-management
    return P.using(this._getConnection(), function(conn) {
      return new P(function(resolve, reject) {
        conn.ping(function(err) {
          if (err) {
            logger.error('ping:', err);
            reject(err);
          } else {
            resolve({});
          }
        });
      });
    });
  },

  getLock: function getLock(lockName, timeout = 3) {
    // returns `acquired: 1` on success
    logger.debug('getLock');
    return this._readOne(QUERY_GET_LOCK, [lockName, timeout]);
  },

  // createdAt is DEFAULT NOW() in the schema.sql
  registerClient: function registerClient(client) {
    var id;
    if (client.id) {
      id = buf(client.id);
    } else {
      id = unique.id();
    }
    logger.debug('registerClient', { name: client.name, id: hex(id) });
    return this._write(QUERY_CLIENT_REGISTER, [
      id,
      client.name,
      client.imageUri || '',
      buf(client.hashedSecret),
      client.hashedSecretPrevious ? buf(client.hashedSecretPrevious) : null,
      client.redirectUri,
      !!client.trusted,
      client.allowedScopes ? client.allowedScopes : null,
      !!client.canGrant,
      !!client.publicClient,
    ]).then(function() {
      logger.debug('registerClient.success', { id: hex(id) });
      client.id = id;
      return client;
    });
  },
  registerClientDeveloper: function regClientDeveloper(developerId, clientId) {
    if (!developerId || !clientId) {
      var err = new Error('Owner registration requires user and developer id');
      return P.reject(err);
    }

    var rowId = unique.id();

    logger.debug('registerClientDeveloper', {
      rowId: rowId,
      developerId: developerId,
      clientId: clientId,
    });

    return this._write(QUERY_CLIENT_DEVELOPER_INSERT, [
      buf(rowId),
      buf(developerId),
      buf(clientId),
    ]);
  },
  getClientDevelopers: function getClientDevelopers(clientId) {
    if (!clientId) {
      return P.reject(new Error('Client id is required'));
    }
    return this._read(QUERY_CLIENT_DEVELOPER_LIST_BY_CLIENT_ID, [
      buf(clientId),
    ]);
  },
  activateDeveloper: function activateDeveloper(email) {
    if (!email) {
      return P.reject(new Error('Email is required'));
    }

    var developerId = unique.developerId();
    logger.debug('activateDeveloper', { developerId: developerId });
    return this._write(QUERY_DEVELOPER_INSERT, [developerId, email]).then(
      function() {
        return this.getDeveloper(email);
      }.bind(this)
    );
  },
  getDeveloper: function(email) {
    if (!email) {
      return P.reject(new Error('Email is required'));
    }

    return this._readOne(QUERY_DEVELOPER, [email]);
  },
  removeDeveloper: function(email) {
    if (!email) {
      return P.reject(new Error('Email is required'));
    }

    return this._write(QUERY_DEVELOPER_DELETE, [email]);
  },
  developerOwnsClient: function devOwnsClient(developerEmail, clientId) {
    return this._readOne(QUERY_DEVELOPER_OWNS_CLIENT, [
      developerEmail,
      buf(clientId),
    ]).then(function(result) {
      if (result) {
        return P.resolve(true);
      } else {
        return P.reject(false);
      }
    });
  },
  updateClient: function updateClient(client) {
    if (!client.id) {
      return P.reject(new Error('Update client needs an id'));
    }
    var secret = client.hashedSecret;
    if (secret) {
      secret = buf(secret);
    }

    var secretPrevious = client.hashedSecretPrevious;
    if (secretPrevious) {
      secretPrevious = buf(secretPrevious);
    }
    return this._write(QUERY_CLIENT_UPDATE, [
      // VALUES
      client.name,
      client.imageUri,
      secret,
      secretPrevious,
      client.redirectUri,
      client.trusted,
      client.allowedScopes,
      client.canGrant,

      // WHERE
      buf(client.id),
    ]);
  },

  getClient: function getClient(id) {
    return this._readOne(QUERY_CLIENT_GET, [buf(id)]);
  },
  getClients: function getClients(email) {
    return this._read(QUERY_CLIENT_LIST, [email]);
  },
  removeClient: function removeClient(id) {
    return this._write(QUERY_CLIENT_DELETE, [buf(id)]);
  },
  generateCode: function generateCode(codeObj) {
    var code = unique.code();
    var hash = encrypt.hash(code);
    return this._write(QUERY_CODE_INSERT, [
      codeObj.clientId,
      codeObj.userId,
      codeObj.email,
      codeObj.scope.toString(),
      codeObj.authAt,
      codeObj.amr ? codeObj.amr.join(',') : null,
      codeObj.aal || null,
      !!codeObj.offline,
      hash,
      codeObj.codeChallengeMethod,
      codeObj.codeChallenge,
      codeObj.keysJwe,
      codeObj.profileChangedAt,
      codeObj.sessionTokenId,
    ]).then(function() {
      return code;
    });
  },
  getCode: function getCode(code) {
    var hash = encrypt.hash(code);
    return this._readOne(QUERY_CODE_FIND, [hash]).then(function(code) {
      if (code) {
        code.scope = ScopeSet.fromString(code.scope);
        if (code.amr !== null) {
          code.amr = code.amr.split(',');
        }
      }
      return code;
    });
  },
  removeCode: function removeCode(code) {
    var hash = encrypt.hash(code);
    return this._write(QUERY_CODE_DELETE, [hash]);
  },

  _generateAccessToken: function _generateAccessToken(accessToken) {
    return this._write(QUERY_ACCESS_TOKEN_INSERT, [
      accessToken.clientId,
      accessToken.userId,
      accessToken.email,
      accessToken.scope.toString(),
      accessToken.type,
      accessToken.expiresAt,
      accessToken.tokenId,
      accessToken.profileChangedAt,
    ]);
  },

  /**
   * Get an access token by token id
   * @param id Token Id
   * @returns {*}
   */
  _getAccessToken: function _getAccessToken(id) {
    return this._readOne(QUERY_ACCESS_TOKEN_FIND, [buf(id)]).then(function(t) {
      if (t) {
        t = AccessToken.fromMySQL(t);
      }
      return t;
    });
  },

  /**
   * Remove token by token id
   * @param id
   * @returns {*}
   */
  _removeAccessToken: function _removeAccessToken(id) {
    return this._write(QUERY_ACCESS_TOKEN_DELETE, [buf(id)]);
  },

  /**
   * Get all access tokens for a given user.
   * @param {String} uid User ID as hex
   * @returns {Promise}
   */
  _getAccessTokensByUid: async function _getAccessTokensByUid(uid) {
    const accessTokens = await this._read(QUERY_LIST_ACCESS_TOKENS_BY_UID, [
      buf(uid),
    ]);
    return accessTokens.map(t => {
      return AccessToken.fromMySQL(t);
    });
  },

  /**
   * Get all refresh tokens for a given user.
   * @param {String} uid User ID as hex
   * @returns {Promise}
   */
  getRefreshTokensByUid: async function getRefreshTokensByUid(uid) {
    const refreshTokens = await this._read(QUERY_LIST_REFRESH_TOKENS_BY_UID, [
      buf(uid),
    ]);
    refreshTokens.forEach(t => {
      t.scope = ScopeSet.fromString(t.scope);
    });
    return refreshTokens;
  },

  /**
   * Get all refresh tokens for all users for a given clientId.
   * @param {String} clientId
   * @param {String} uid
   * @returns {Promise}
   */
  getRefreshTokensByClientId: async function getRefreshTokensByClientId(
    clientId
  ) {
    return this._read(QUERY_LIST_REFRESH_TOKENS_BY_CLIENT_ID, [buf(clientId)]);
  },

  /**
   * Delete all authorization grants for some clientId and uid.
   *
   * @param {String} clientId Client ID
   * @param {String} uid User Id as Hex
   * @returns {Promise}
   */
  _deleteClientAuthorization: function _deleteClientAuthorization(
    clientId,
    uid
  ) {
    const deleteCodes = this._write(DELETE_ACTIVE_CODES_BY_CLIENT_AND_UID, [
      buf(clientId),
      buf(uid),
    ]);

    const deleteTokens = this._write(DELETE_ACTIVE_TOKENS_BY_CLIENT_AND_UID, [
      buf(clientId),
      buf(uid),
    ]);

    const deleteRefreshTokens = this._write(
      DELETE_ACTIVE_REFRESH_TOKENS_BY_CLIENT_AND_UID,
      [buf(clientId), buf(uid)]
    );

    return P.all([deleteCodes, deleteTokens, deleteRefreshTokens]);
  },

  /**
   * Delete a specific refresh token, for some clientId and uid.
   * Also deletes *all* access tokens for the clientId and uid combination,
   * otherwise the refresh token is deleted but none of the access tokens
   * created from that refresh token are, leaving ghost access tokens
   * to appear in the users devices & apps list. See:
   *
   * https://github.com/mozilla/fxa/issues/1249
   * https://github.com/mozilla/fxa/issues/3017
   *
   * If a user has multiple refresh tokens for a given client_id, clients
   * will use their active refresh tokens to get new access tokens.
   *
   * @param {String} refreshTokenid Refresh Token ID as Hex
   * @param {String} clientId Client ID as Hex
   * @param {String} uid User Id as Hex
   * @returns {Promise} `true` if the token was found and deleted, `false` otherwise
   */
  _deleteClientRefreshToken: async function _deleteClientRefreshToken(
    refreshTokenId,
    clientId,
    uid
  ) {
    const deleteRefreshTokenRes = await this._write(
      DELETE_REFRESH_TOKEN_WITH_CLIENT_AND_UID,
      [buf(refreshTokenId), buf(clientId), buf(uid)]
    );

    // only delete access tokens if deleting the refresh
    // tokens has succeeded.
    if (deleteRefreshTokenRes.affectedRows) {
      await this._write(DELETE_ACTIVE_TOKENS_BY_CLIENT_AND_UID, [
        buf(clientId),
        buf(uid),
      ]);
      return true;
    }

    return false;
  },

  generateRefreshToken: function generateRefreshToken(vals) {
    var t = {
      clientId: vals.clientId,
      userId: vals.userId,
      email: vals.email,
      scope: vals.scope,
      profileChangedAt: vals.profileChangedAt,
    };
    var token = unique.token();
    var hash = encrypt.hash(token);
    return this._write(QUERY_REFRESH_TOKEN_INSERT, [
      t.clientId,
      t.userId,
      t.email,
      t.scope.toString(),
      hash,
      t.profileChangedAt,
    ]).then(function() {
      t.token = token;
      return t;
    });
  },

  getRefreshToken: function getRefreshToken(token) {
    return this._readOne(QUERY_REFRESH_TOKEN_FIND, [buf(token)]).then(function(
      t
    ) {
      if (t) {
        t.scope = ScopeSet.fromString(t.scope);
      }
      return t;
    });
  },

  usedRefreshToken: function usedRefreshToken(token) {
    var now = new Date();
    return this._write(QUERY_REFRESH_TOKEN_LAST_USED_UPDATE, [
      now,
      // WHERE
      token,
    ]);
  },

  removeRefreshToken: function removeRefreshToken(id) {
    return this._write(QUERY_REFRESH_TOKEN_DELETE, [buf(id)]);
  },

  getEncodingInfo: function getEncodingInfo() {
    var info = {};

    var self = this;
    var qry = 'SHOW VARIABLES LIKE "%character\\_set\\_%"';
    return this._read(qry).then(function(rows) {
      rows.forEach(function(row) {
        info[row.Variable_name] = row.Value;
      });

      qry = 'SHOW VARIABLES LIKE "%collation\\_%"';
      return self._read(qry).then(function(rows) {
        rows.forEach(function(row) {
          info[row.Variable_name] = row.Value;
        });
        return info;
      });
    });
  },

  _removeUser: function _removeUser(userId) {
    // TODO this should be a transaction or stored procedure
    var id = buf(userId);
    return this._write(QUERY_ACCESS_TOKEN_DELETE_USER, [id])
      .then(this._write.bind(this, QUERY_REFRESH_TOKEN_DELETE_USER, [id]))
      .then(this._write.bind(this, QUERY_CODE_DELETE_USER, [id]));
  },

  /**
   * Removes user's tokens and refreshTokens for canGrant and publicClient clients
   *
   * @param {Buffer | string} userId
   * @returns {Promise}
   */
  _removePublicAndCanGrantTokens: function _removePublicAndCanGrantTokens(
    userId
  ) {
    const uid = buf(userId);

    return this._write(QUERY_DELETE_ACCESS_TOKEN_FOR_PUBLIC_CLIENTS, [
      uid,
    ]).then(() =>
      this._write(QUERY_DELETE_REFRESH_TOKEN_FOR_PUBLIC_CLIENTS, [uid])
    );
  },

  getScope: async function getScope(scope) {
    // We currently only have database entries for URL-format scopes,
    // so don't bother hitting the db for common scopes like 'profile'.
    if (!scope.startsWith('https://')) {
      return null;
    }
    return (await this._readOne(QUERY_SCOPE_FIND, [scope])) || null;
  },

  registerScope: function registerScope(scope) {
    return this._write(QUERY_SCOPES_INSERT, [scope.scope, scope.hasScopedKeys]);
  },

  _write: function _write(sql, params) {
    return this._query(sql, params);
  },

  _read: function _read(sql, params) {
    return this._query(sql, params);
  },

  _readOne: function _readOne(sql, params) {
    return this._read(sql, params).then(firstRow);
  },

  _getConnection: function _getConnection() {
    // see bluebird.using()/disposer():
    // https://github.com/petkaantonov/bluebird/blob/master/API.md#resource-management
    //
    // tl;dr: using() and disposer() ensures that the dispose method will
    // ALWAYS be called at the end of the promise stack, regardless of
    // various errors thrown. So this should ALWAYS release the connection.
    var pool = this._pool;
    return new P(function(resolve, reject) {
      pool.getConnection(function(err, conn) {
        if (err) {
          return reject(err);
        }

        if (conn._fxa_initialized) {
          return resolve(conn);
        }

        // Enforce sane defaults on every new connection.
        // These *should* be set by the database by default, but it's nice
        // to have an additional layer of protection here.
        const query = P.promisify(conn.query, { context: conn });
        return resolve(
          (async () => {
            // Always communicate timestamps in UTC.
            await query("SET time_zone = '+00:00'");
            // Always use full 4-byte UTF-8 for communicating unicode.
            await query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;');
            // Always have certain modes active. The complexity here is to
            // preserve any extra modes active by default on the server.
            // We also try to preserve the order of the existing mode flags,
            // just in case the order has some obscure effect we don't know about.
            const rows = await query('SELECT @@sql_mode AS mode');
            const modes = rows[0]['mode'].split(',');
            let needToSetMode = false;
            for (const requiredMode of REQUIRED_SQL_MODES) {
              if (modes.indexOf(requiredMode) === -1) {
                modes.push(requiredMode);
                needToSetMode = true;
              }
            }
            if (needToSetMode) {
              const mode = modes.join(',');
              await query("SET SESSION sql_mode = '" + mode + "'");
            }
            // Avoid repeating all that work for existing connections.
            conn._fxa_initialized = true;
            return conn;
          })()
        );
      });
    }).disposer(releaseConn);
  },

  _query: function _query(sql, params) {
    return P.using(this._getConnection(), function(conn) {
      return new P(function(resolve, reject) {
        conn.query(sql, params || [], function(err, results) {
          if (err) {
            reject(err);
          } else {
            resolve(results);
          }
        });
      });
    });
  },
};

module.exports = MysqlStore;
