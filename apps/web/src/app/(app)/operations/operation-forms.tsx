'use client';

import { useActionState } from 'react';

import {
  cancelOperationAction,
  confirmOperationAction,
  type OperationFormState,
} from '../../actions/listings';
import { Button, Notice } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * Confirming or withdrawing one operation (sections 20, 30).
 *
 * The fingerprint travels in a hidden field, and the values it stands for do
 * not. That asymmetry is the design: what returns from the browser is an
 * assertion about which screen was read, so a tampered field produces a refusal
 * rather than a change nobody agreed to, and the numbers themselves are never
 * round-tripped through anything a person could edit.
 *
 * The confirm button is drawn only when the permission and the step-up are both
 * satisfied — but that is a courtesy, not a control. `confirmOperation` asks
 * both questions again on the server, and a request that arrives without them is
 * refused there and written down.
 */

const IDLE: OperationFormState = { status: 'idle' };

function Message({ state }: { state: OperationFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

export function OperationControls({
  csrf,
  businessId,
  operationId,
  fingerprint,
  mayConfirm,
  stepUpSatisfied,
  confirmLabel,
}: {
  csrf: string;
  businessId: string;
  operationId: string;
  fingerprint: string;
  mayConfirm: boolean;
  stepUpSatisfied: boolean;
  confirmLabel: string;
}) {
  const [confirmState, confirm, confirming] = useActionState(confirmOperationAction, IDLE);
  const [cancelState, cancel, cancelling] = useActionState(cancelOperationAction, IDLE);

  return (
    <div className="flex flex-col gap-3">
      <Message state={confirmState} />
      <Message state={cancelState} />

      {mayConfirm && !stepUpSatisfied ? (
        <Notice tone="info">
          This action needs a recent sign-in. Authenticate again to confirm it.
        </Notice>
      ) : null}

      {!mayConfirm ? (
        <Notice tone="info">
          You do not have the permission this action requires. Somebody who does can confirm it.
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {mayConfirm && stepUpSatisfied ? (
          <form action={confirm}>
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="operationId" value={operationId} />
            {/* What was read, not what it said. */}
            <input type="hidden" name="fingerprint" value={fingerprint} />
            <Button disabled={confirming}>{confirmLabel}</Button>
          </form>
        ) : null}

        <form action={cancel}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="operationId" value={operationId} />
          <Button disabled={cancelling}>Withdraw</Button>
        </form>
      </div>
    </div>
  );
}
