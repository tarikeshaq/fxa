/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** A general type that holds PII data. */
export type PiiData = Record<string, any> | string | undefined | null;

/** A general interface for running a filter action on PII Data */
export interface IFilterAction {
  /**
   * Filters a value for PII
   * @param val - the value to filter
   */
  execute<T extends PiiData>(val: T, depth?: number): T;
}

/** A general interface for top level classes that filter PII data */
export interface IFilter {
  filter(event: PiiData): PiiData;
}

/** Things to check for when scrubbing for PII. */
export type CheckOnly = 'keys' | 'values' | 'both';
