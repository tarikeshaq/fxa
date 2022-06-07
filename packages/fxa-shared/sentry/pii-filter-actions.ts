/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CheckOnly, IFilterAction, PiiData } from './models/pii';

/** Default replacement value */
export const FILTERED = '[Filtered]';
export const TRUNCATED = '[Truncated]';

/**
 * A filter that truncates anything over maxDepth. This is a good first action.
 */
export class DepthFilter implements IFilterAction {
  /**
   * Maximum Depth
   * @param maxDepth
   */
  constructor(protected readonly maxDepth = 3) {}

  execute<T extends PiiData>(val: T, depth = 1): T {
    if (depth >= this.maxDepth && val != null && typeof val === 'object') {
      Object.keys(val)?.forEach((x) => {
        val[x] = TRUNCATED;
      });
    }
    return val;
  }
}

/**
 * A base class for other PiiFilters. Supports checking keys and values
 */
export abstract class PiiFilter implements IFilterAction {
  /** Flag determining if object values should be checked. */
  protected get checkValues() {
    return this.checkOnly === 'values' || this.checkOnly === 'both';
  }

  /** Flag determining if object keys should be checked. */
  protected get checkKeys() {
    return this.checkOnly === 'keys' || this.checkOnly === 'both';
  }

  /**
   * Creates a new regex filter action
   * @param checkOnly - Optional directive indicating what to check, a value, an object key, or both.
   * @param replaceWith - Optional value indicating what to replace a matched value with.
   */
  constructor(
    public readonly checkOnly: CheckOnly = 'values',
    public readonly replaceWith = FILTERED
  ) {}

  /**
   * Runs the filter
   * @param val - value to filter on.
   * @returns a filtered value
   */
  public execute<T extends PiiData>(val: T) {
    if (val == null) {
      return val;
    }

    // A string, just update the value.
    if (typeof val === 'string') {
      return this.replaceValues(val) as T;
    } else if (typeof val === 'object') {
      // Mutate and drill down into object
      for (const key of Object.keys(val)) {
        if (this.filterKey(key)) {
          val[key] = this.replaceWith;
        } else if (this.filterValue(val[key])) {
          val[key] = this.replaceValues(val[key]);
        }
      }
    }
    return val;
  }

  /**
   * Indicates if value should be filtered
   * @param val
   * @returns
   */
  protected filterValue(val: any) {
    return this.checkValues && typeof val === 'string';
  }

  /**
   * Let the sub classes determine how to replace values.
   * @param val
   */
  protected abstract replaceValues(val: string): string;

  /**
   * Let subclasses determine when an object's key should be filtered out.
   * @param key
   */
  protected abstract filterKey(key: string): boolean;
}

/**
 * Uses a regular expression to scrub PII
 */
export class PiiRegexFilter extends PiiFilter implements IFilterAction {
  /**
   * Creates a new regex filter action
   * @param regex - regular expression to use for filter
   * @param checkOnly - Optional directive indicating what to check, a value, an object key, or both.
   * @param replaceWith - Optional value indicating what to replace a matched value with.
   */
  constructor(
    public readonly regex: RegExp,
    public readonly checkOnly: CheckOnly = 'values',
    public readonly replaceWith = FILTERED
  ) {
    super(checkOnly, replaceWith);
  }

  protected override replaceValues(val: string): string {
    return val.replace(this.regex, this.replaceWith);
  }

  protected override filterKey(key: string): boolean {
    const result = this.checkKeys && this.regex.test(key);

    // Tricky edge case. The regex maybe sticky. If so, we need to reset its lastIndex so it does not
    // affect a subsequent operation.
    if (this.regex.sticky) {
      this.regex.lastIndex = 0;
    }
    return result;
  }
}

/**
 * Makes sure that if value is a URL it doesn't have identifying info like the username or password portion of the url.
 */
export class UrlUsernamePasswordFilter extends PiiFilter {
  constructor(replaceWith = FILTERED) {
    super('values', replaceWith);
  }

  protected override replaceValues(val: string) {
    const url = tryParseUrl(val);
    if (url) {
      if (url.username) {
        url.username = this.replaceWith;
      }
      if (url.password) {
        url.password = this.replaceWith;
      }
      val = decodeURI(url.toString());
    }
    return val;
  }

  protected override filterKey(): boolean {
    return false;
  }
}

/**
 * Strips emails from data.
 */
export class EmailFilter extends PiiRegexFilter {
  constructor(checkOnly: CheckOnly = 'values', replaceWith = FILTERED) {
    super(
      // RFC 5322 generalized email regex, ~ 99.99% accurate.
      /(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/gim,
      checkOnly,
      replaceWith
    );
  }

  protected override replaceValues(val: string) {
    const url = tryParseUrl(val);
    if (url) {
      if (url.search) {
        url.search = url.search.replace(this.regex, this.replaceWith);
      }
      if (url.pathname) {
        url.pathname = url.pathname.replace(this.regex, this.replaceWith);
      }
      val = decodeURI(url.toString());
    }

    return val.replace(this.regex, this.replaceWith);
  }

  protected filterKey(key: string): boolean {
    return false;
  }
}

/** Auxillary method for safely parsing a url. If it can't be parsed returns null. */
function tryParseUrl(val: string) {
  try {
    return new URL(val);
  } catch (_) {
    return null;
  }
}

/**
 * Some common PII scrubbing actions
 */
export const CommonPiiActions = {
  /**
   * Limits objects to 5 levels of depth
   */
  depthFilter: new DepthFilter(5),

  /**
   * Makes sure the user name / password is stripped out of the url.
   */
  urlUsernamePassword: new UrlUsernamePasswordFilter(),

  /**
   * Makes sure emails are stripped from data. Uses RFC 5322 generalized email regex, ~ 99.99% accurate.
   */
  emailValues: new EmailFilter(),

  /**
   * Matches IP V6 values
   */
  ipV6Values: new PiiRegexFilter(
    /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/gim
  ),

  /**
   * Matches IPV4 values
   */
  ipV4Values: new PiiRegexFilter(
    /(\b25[0-5]|\b2[0-4][0-9]|\b[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}/gim
  ),

  /**
   * Looks for keys that commonly contain PII
   */
  piiKeys: new PiiRegexFilter(
    /^oidc-.*|^remote-groups$|^uid$|^email_?|^ip_?|^user$|^user_?(id|name)$/i,
    'keys'
  ),

  /**
   * Matches uid, session, oauth and other common tokens which we would prefer not to include in Sentry reports.
   */
  tokenValues: new PiiRegexFilter(/[a-fA-F0-9]{32,}/gim),
};
