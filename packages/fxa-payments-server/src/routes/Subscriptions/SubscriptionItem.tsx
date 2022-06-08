/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// React looks unused here, but we need it for Storybook.
import React, { useContext } from 'react';
import { Localized } from '@fluent/react';
import { Plan, Customer } from '../../store/types';
import { SelectorReturns } from '../../store/selectors';
import { SubscriptionsProps } from './index';

import Modal from 'fxa-react/components/Modal';
import AppContext from '../../lib/AppContext';

import CancelSubscriptionPanel from './Cancel/CancelSubscriptionPanel';
import ReactivateSubscriptionPanel from './Reactivate/ManagementPanel';
import { PaymentProvider } from 'fxa-payments-server/src/lib/PaymentProvider';
import { WebSubscription } from 'fxa-shared/subscriptions/types';
import { SubsequentInvoicePreview } from 'fxa-shared/dto/auth/payments/invoice';

export type SubscriptionItemProps = {
  customerSubscription: WebSubscription;
  plan: Plan | null;
  cancelSubscription: SubscriptionsProps['cancelSubscription'];
  reactivateSubscription: SubscriptionsProps['reactivateSubscription'];
  customer: Customer;
  cancelSubscriptionStatus: SelectorReturns['cancelSubscriptionStatus'];
  subsequentInvoice: SubsequentInvoicePreview | undefined;
};

export const SubscriptionItem = ({
  cancelSubscription,
  cancelSubscriptionStatus,
  reactivateSubscription,
  customer,
  plan,
  customerSubscription,
  subsequentInvoice,
}: SubscriptionItemProps) => {
  const { locationReload } = useContext(AppContext);
  const total = subsequentInvoice && subsequentInvoice.total;
  const period_start = subsequentInvoice && subsequentInvoice.period_start;

  const paymentProvider: PaymentProvider | undefined =
    customer?.payment_provider;
  const promotionCode = customerSubscription.promotion_code;

  if (!plan) {
    // TODO: This really shouldn't happen, would mean the user has a
    // subscription to a plan that no longer exists in API results.
    return (
      <Modal className="dialog-error" onDismiss={locationReload}>
        <Localized id="product-plan-not-found">
          <h4 data-testid="error-subhub-missing-plan">Plan not found</h4>
        </Localized>
        <Localized id="sub-item-no-such-plan">
          <p>No such plan for this subscription.</p>
        </Localized>
      </Modal>
    );
  }

  if (
    customerSubscription.cancel_at_period_end === false &&
    !((total || total === 0) && period_start)
  ) {
    return (
      <Modal className="dialog-error" onDismiss={locationReload}>
        <Localized id="invoice-not-found">
          <h4 data-testid="error-subhub-missing-subsequent-invoice">
            Subsequent invoice not found
          </h4>
        </Localized>
        <Localized id="sub-item-no-such-subsequent-invoice">
          <p>Subsequent invoice not found for this subscription.</p>
        </Localized>
      </Modal>
    );
  }

  return (
    <div className="settings-unit">
      <div className="subscription" data-testid="subscription-item">
        <header>
          <h2>{plan.product_name}</h2>
        </header>

        {!customerSubscription.cancel_at_period_end &&
        (total || total === 0) &&
        period_start ? (
          <CancelSubscriptionPanel
            {...{
              cancelSubscription,
              cancelSubscriptionStatus,
              customerSubscription,
              plan,
              paymentProvider,
              promotionCode,
              subsequentInvoiceAmount: total,
              subsequentInvoiceDate: period_start,
            }}
          />
        ) : (
          <>
            <ReactivateSubscriptionPanel
              {...{
                plan,
                customer,
                customerSubscription,
                reactivateSubscription,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default SubscriptionItem;
