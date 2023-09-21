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

// ref: [FxAccounts.sys.mjs](https://searchfox.org/mozilla-central/rev/82828dba9e290914eddd294a0871533875b3a0b5/services/fxaccounts/FxAccounts.sys.mjs#910)
export type FxALoginRequest = {
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
};

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

// Suffix to ensure each message has a unique messageId.
// Every send increments the suffix by 1.
// A module variable is used instead of an instance variable because
// more than one channel can exist. Using an instance variable,
// it's possible for two messages on two channels to have the same
// messageId, if both channels send a message in the same millisecond.
// This might not cause any harm in reality, but this avoids
// that possibility.
let messageIdSuffix = 0;

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
    messageId: string
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
    const messageId = this.makeMessageId();
    const detail = this.formatEventDetail(command, data, messageId);
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
      const messageId = this.makeMessageId();
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

  makeMessageId(): string {
    // If two messages are created within the same millisecond, Date.now()
    // returns the same value. Append a suffix that ensures uniqueness
    return `${Date.now()}${++messageIdSuffix}`;
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

  fxaLogin(options: FxALoginRequest) {
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
const firefox = canUseEventTarget
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
