/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import * as Sentry from '@sentry/node';
import { SQS } from 'aws-sdk';
import { Request } from 'express';

import { CommonPiiActions } from '../../sentry/pii-filter-actions';
import { SentryPiiFilter, SqsMessageFilter } from '../../sentry/pii-filters';
const piiFilter = new SentryPiiFilter([
  CommonPiiActions.depthFilter,
  CommonPiiActions.piiKeys,
  CommonPiiActions.emailValues,
  CommonPiiActions.tokenValues,
  CommonPiiActions.ipV4Values,
  CommonPiiActions.ipV6Values,
  CommonPiiActions.urlUsernamePassword,
]);

const sqsMessageFilter = new SqsMessageFilter([
  CommonPiiActions.emailValues,
  CommonPiiActions.tokenValues,
]);

export interface ExtraContext {
  name: string;
  fieldData: Record<string, string>;
}

/**
 * Filters all of an objects string properties to remove tokens.
 *
 * @param obj Object to filter values on
 */
export function filterObject(obj: Record<string, any>) {
  return piiFilter.filter(obj);
}

/**
 * Filter potential PII from a sentry event.
 *
 * - Limits depth data beyond 5 levels
 * - Filters out pii keys, See CommonPiiActions.piiKeys for more details
 * - Filters out strings that look like emails addresses
 * - Filters out strings that look like tokens value (32 char length alphanumeric values)
 * - Filters out strings that look like ip addresses (v4/v6)
 * - Filters out urls with user name / password data
 * @param event A sentry event
 * @returns a sanitized sentry event
 */
export function filterSentryEvent(event: Sentry.Event, _hint: unknown) {
  return piiFilter.filter(event);
}

/**
 * Capture a SQS Error to Sentry with additional context.
 *
 * @param err Error object to capture.
 * @param message SQS Message to include with error.
 */
export function captureSqsError(err: Error, message?: SQS.Message): void {
  Sentry.withScope((scope) => {
    if (message?.Body) {
      message = sqsMessageFilter.filter(message);
      scope.setContext('SQS Message', message as Record<string, unknown>);
    }
    Sentry.captureException(err);
  });
}

/**
 * Report an exception with request and additional optional context objects.
 *
 * @param exception
 * @param excContexts List of additional exception context objects to capture.
 * @param request A request object if available.
 */
export function reportRequestException(
  exception: Error & { reported?: boolean; status?: number; response?: any },
  excContexts: ExtraContext[] = [],
  request?: Request
) {
  // Don't report already reported exceptions
  if (exception.reported) {
    return;
  }
  Sentry.withScope((scope: Sentry.Scope) => {
    scope.addEventProcessor((event: Sentry.Event) => {
      if (request) {
        const sentryEvent = Sentry.Handlers.parseRequest(event, request);
        sentryEvent.level = Sentry.Severity.Error;
        return sentryEvent;
      }
      return null;
    });
    for (const ctx of excContexts) {
      scope.setContext(ctx.name, ctx.fieldData);
    }
    Sentry.captureException(exception);
    exception.reported = true;
  });
}

export function processException(context: ExecutionContext, exception: Error) {
  // First determine what type of a request this is
  let requestType: 'http' | 'graphql' | undefined;
  let request: Request | undefined;
  let gqlExec: GqlExecutionContext | undefined;
  if (context.getType() === 'http') {
    requestType = 'http';
    request = context.switchToHttp().getRequest();
  } else if (context.getType<GqlContextType>() === 'graphql') {
    requestType = 'graphql';
    gqlExec = GqlExecutionContext.create(context);
    request = gqlExec.getContext().req;
  }
  let excContexts: ExtraContext[] = [];
  if (gqlExec) {
    const info = gqlExec.getInfo();
    excContexts.push({
      name: 'graphql',
      fieldData: { fieldName: info.fieldName, path: info.path },
    });
  }

  reportRequestException(exception, excContexts, request);
}
