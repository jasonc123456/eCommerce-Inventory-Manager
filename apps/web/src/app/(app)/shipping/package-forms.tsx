'use client';

import { useActionState } from 'react';

import {
  cancelPackageAction,
  markShippedAction,
  type ShippingFormState,
} from '../../actions/shipping';
import { Button, Notice } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * The two things a browser decides about a parcel (sections 14, 21).
 *
 * Marking shipped is drawn only for a labelled package, and withdrawing only for
 * one that has not been labelled — which is not tidiness but the rule itself:
 * section 14 makes shipping a person's explicit act on a parcel that has a label
 * on it, and a labelled package holds a purchase that cost money and cannot
 * simply be made to disappear.
 *
 * Both buttons are courtesies. The server asks the same questions again and
 * refuses there, so hiding a control is never the control.
 */

const IDLE: ShippingFormState = { status: 'idle' };

function Message({ state }: { state: ShippingFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

export function PackageControls({
  csrf,
  businessId,
  packageId,
  status,
  mayMarkShipped,
}: {
  csrf: string;
  businessId: string;
  packageId: string;
  status: string;
  mayMarkShipped: boolean;
}) {
  const [shipState, ship, shipping] = useActionState(markShippedAction, IDLE);
  const [cancelState, cancel, cancelling] = useActionState(cancelPackageAction, IDLE);

  return (
    <div className="flex flex-col gap-3">
      <Message state={shipState} />
      <Message state={cancelState} />

      {status === 'labelled' && !mayMarkShipped ? (
        <Notice tone="info">
          This parcel has a label and is waiting to be marked shipped. That needs the
          <code className="px-1">mark_shipped</code> permission.
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {status === 'labelled' && mayMarkShipped ? (
          <form action={ship}>
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="packageId" value={packageId} />
            <Button disabled={shipping}>Mark shipped</Button>
          </form>
        ) : null}

        {status === 'draft' ? (
          <form action={cancel}>
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="packageId" value={packageId} />
            <Button disabled={cancelling}>Withdraw</Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
