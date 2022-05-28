/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as Sentry from '@sentry/node';
import { SQS } from 'aws-sdk';
import { expect } from 'chai';
import sinon from 'sinon';
import { ILogger } from '../../log';
import { IAction, PiiData } from '../../sentry/models/pii';
import {
  CommonPiiActions,
  FILTERED,
  PiiRegexFilter,
} from '../../sentry/pii-filter-actions';
import {
  FilterBase,
  SentryPiiFilter,
  SqsMessageFilter,
} from '../../sentry/pii-filters';

describe('pii-filters', () => {
  describe('SentryMessageFilter', () => {
    const sentryFilter = new SentryPiiFilter([
      CommonPiiActions.depthFilter,
      CommonPiiActions.urlUsernamePassword,
      CommonPiiActions.emailValues,
      CommonPiiActions.piiKeys,
      CommonPiiActions.tokenValues,
      CommonPiiActions.ipV4Values,
      CommonPiiActions.ipV6Values,
      new PiiRegexFilter(/foo/gi),
    ]);

    it('filters empty event', () => {
      let event: Sentry.Event = {};
      event = sentryFilter.filter(event);
      expect(event).to.deep.equal({});
    });

    it('filters event', () => {
      let event: Sentry.Event = {
        message: 'A foo message.',
        breadcrumbs: [
          {
            message: 'A foo breadcrumb',
            data: {
              first_name: 'foo',
              last_name: 'bar',
            },
          },
          {
            message: 'A fine message',
          },
        ],
        request: {
          url: 'http://me:123@foo.bar/?email=foxkey@mozilla.com&uid=12345678123456781234567812345678',
          query_string: {
            email: 'foo',
            uid: 'bar',
          },
          cookies: {
            user: 'foo:bar',
          },
          env: {
            key: '--foo',
          },
          headers: {
            foo: 'a foo header',
            bar: 'a foo bar bar header',
            'oidc-claim': 'claim1',
          },
          data: {
            info: {
              email: 'foxkeh@mozilla.com',
              uid: '12345678123456781234567812345678',
            },
            time: new Date(0).getTime(),
          },
        },
        exception: {
          values: [
            {
              value:
                'Foo bar! A user with email foxkeh@mozilla.clom and ip 127.0.0.1 encountered an err.',
            },
          ],
        },
        extra: {
          meta: {
            email: 'foo@bar.com',
          },
          l1: {
            l2: {
              l3: {
                l4: {
                  l5: {
                    l6: {
                      l7: {
                        l8: {
                          l9: {
                            l10: 'bar',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        user: {
          meta: {
            email: 'foo@bar.com',
          },
          id: 'foo123',
          ip_address: '127.0.0.1',
          email: 'foo@bar.com',
          username: 'foo.bar',
        },
        type: 'transaction',
        spans: undefined, // Not testing, let's be careful not put PII in spans,
        measurements: undefined, // NA, just numbers
        debug_meta: undefined, // NA, image data
        sdkProcessingMetadata: undefined, // NA, not used
      };

      event = sentryFilter.filter(event);

      expect(event).to.deep.equal({
        message: 'A [Filtered] message.',
        breadcrumbs: [
          {
            message: 'A [Filtered] breadcrumb',
            data: {
              first_name: '[Filtered]',
              last_name: 'bar',
            },
          },
          {
            message: 'A fine message',
          },
        ],
        request: {
          url: 'http://[Filtered]:[Filtered]@[Filtered].bar/?[Filtered]&uid=[Filtered]',
          query_string: {
            email: '[Filtered]',
            uid: '[Filtered]',
          },
          cookies: {
            user: '[Filtered]',
          },
          env: {
            key: '--[Filtered]',
          },
          headers: {
            foo: 'a [Filtered] header',
            bar: 'a [Filtered] bar bar header',
            'oidc-claim': '[Filtered]',
          },
          data: {
            info: {
              email: '[Filtered]',
              uid: '[Filtered]',
            },
            time: new Date(0).getTime(),
          },
        },
        exception: {
          values: [
            {
              value:
                '[Filtered] bar! A user with email [Filtered] and ip [Filtered] encountered an err.',
            },
          ],
        },
        extra: {
          meta: {
            email: '[Filtered]',
          },
          l1: {
            l2: {
              l3: {
                l4: {
                  l5: '[Truncated]',
                },
              },
            },
          },
        },
        user: {
          meta: {
            email: '[Filtered]',
          },
          id: '[Filtered]123',
          ip_address: '[Filtered]',
          email: '[Filtered]',
          username: '[Filtered]',
        },
        type: 'transaction',
        spans: undefined, // Not testing, let's be careful not put PII in spans,
        measurements: undefined, // NA, just numbers
        debug_meta: undefined, // NA, image data
        sdkProcessingMetadata: undefined, // NA, not used
      });
    });
  });

  describe('SqsMessageFilter', () => {
    const sqsFilter = new SqsMessageFilter([new PiiRegexFilter(/foo/gi)]);

    it('filters body', () => {
      let msg = { Body: 'A message with foo in it.' } as SQS.Message;
      msg = sqsFilter.filter(msg);

      expect(msg).to.deep.equal({
        Body: `A message with ${FILTERED} in it.`,
      });
    });
  });

  describe('Deals with Bad Filter', () => {
    let mockLogger = <ILogger>{
      error: () => {},
    };
    let sandbox = sinon.createSandbox();

    afterEach(() => {
      sandbox.restore();
    });

    class BadAction implements IAction {
      execute<T extends PiiData>(val: T, depth?: number): T {
        throw new Error('Boom');
      }
    }

    class BadFilter extends FilterBase {
      constructor(logger: ILogger) {
        super([new BadAction()], logger);
      }

      filter(data: any): any {
        return this.applyFilters(data);
      }
    }

    it('handles errors and logs them', () => {
      const errorStub = sandbox.stub(mockLogger, 'error');
      const badFilter = new BadFilter(mockLogger);
      badFilter.filter({ foo: 'bar' });
      expect(errorStub.called).to.be.true;
    });
  });
});
