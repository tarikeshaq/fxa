/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/**
 * Apollo-Server plugin for Sentry
 *
 * Modeled after:
 *   https://blog.sentry.io/2020/07/22/handling-graphql-errors-using-sentry
 *
 * This makes the following assumptions about the Apollo Server setup:
 *   1. The request object to Apollo's context as `.req`.
 *   2. `SentryPlugin` is passed in the `plugins` option.
 */
import { ApolloError } from 'apollo-server';
import * as Sentry from '@sentry/node';
import '@sentry/tracing';
import { Transaction } from '@sentry/types';

import { ExtraContext, reportRequestException } from './reporting';
import { ApolloServerPlugin, BaseContext } from 'apollo-server-plugin-base';

interface Context extends BaseContext {
  transaction: Transaction;
}

export async function createContext(ctx: any): Promise<Context> {
  const transaction = Sentry.startTransaction({
    op: 'gql',
    name: 'GraphQLTransaction',
  });
  return { transaction };
}

export const SentryPlugin: ApolloServerPlugin<Context> = {
  requestDidStart({ request, context }) {
    // Set the transacion name if request has an operation name defined
    if (!!request.operationName) {
      context.transaction.setName('GQL ' + request.operationName!);
    }

    return {
      willSendResponse({ context }) {
        // Finalizes transactionand sends it off to Sentry
        context.transaction.finish();
      },
      executionDidStart() {
        return {
          // Create child span for each field resolved
          willResolveField({ context, info }) {
            const span = context.transaction.startChild({
              op: 'resolver',
              description: `${info.parentType.name}.${info.fieldName}`,
            });
            return () => {
              span.finish();
            };
          },
        };
      },
      didEncounterErrors({ context, errors, operation }) {
        // If we couldn't parse the operation, don't
        // do anything here
        if (!operation) {
          return;
        }
        for (const err of errors) {
          // Only report internal server errors,
          // all errors extending ApolloError should be user-facing
          if (
            err instanceof ApolloError ||
            err.originalError instanceof ApolloError
          ) {
            continue;
          }
          // Skip errors with a status already set or already reported
          if ((err.originalError as any)?.status) {
            continue;
          }
          const excContexts: ExtraContext[] = [];
          if (err.path?.join) {
            excContexts.push({
              name: 'graphql',
              fieldData: {
                path: err.path.join(' > '),
              },
            });
          }
          reportRequestException(
            err.originalError ?? err,
            excContexts,
            context.req
          );
        }
      },
    };
  },
};
