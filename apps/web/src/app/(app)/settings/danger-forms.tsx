'use client';

import { useActionState } from 'react';

import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';
import {
  cancelDeletionAction,
  requestDeletionAction,
  type DeletionFormState,
} from '../../actions/deletion';

const IDLE: DeletionFormState = { status: 'idle' };

function Message({ state }: { state: DeletionFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'success'}>{state.message}</Notice>;
}

/**
 * Asking to delete, and the name field that guards it.
 *
 * The name is not a password and is not secret — it is printed directly above
 * the input. That is the point: it costs nothing to somebody who means it, and
 * it cannot be satisfied by a reflex on the wrong business, which is the actual
 * failure this guards against. Every screen in this application acts on
 * whichever business the switcher happens to be pointing at.
 */
export function RequestDeletionForm({
  csrf,
  businessId,
  businessName,
}: {
  csrf: string;
  businessId: string;
  businessName: string;
}) {
  const [state, submit, pending] = useActionState(requestDeletionAction, IDLE);

  return (
    <form action={submit} className="flex max-w-md flex-col gap-4">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <Field
        label={`Type ${businessName} to continue`}
        hint="Nothing is deleted by this form. It sends a confirmation email to every owner."
      >
        <TextInput name="confirmName" required autoComplete="off" placeholder={businessName} />
      </Field>

      <Field label="Why (optional)" hint="Kept on the record for whoever asks about it later.">
        <TextInput name="reason" maxLength={200} />
      </Field>

      <div>
        <Button type="submit" variant="danger" disabled={pending}>
          Email me a confirmation link
        </Button>
      </div>
    </form>
  );
}

export function CancelDeletionForm({ csrf, businessId }: { csrf: string; businessId: string }) {
  const [state, submit, pending] = useActionState(cancelDeletionAction, IDLE);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <div>
        <Button type="submit" disabled={pending}>
          Cancel the deletion
        </Button>
      </div>
    </form>
  );
}
