'use client';

import { useActionState } from 'react';

import { Button, Notice } from '../../../../components/form';
import { CSRF_FIELD } from '../../../../lib/csrf-field';
import { confirmDeletionAction, type DeletionFormState } from '../../../actions/confirm-deletion';

const IDLE: DeletionFormState = { status: 'idle' };

/**
 * The last button.
 *
 * A form rather than the link itself, and that is not a preference. Mail
 * security products follow links: Office 365 Safe Links rewrites every URL in a
 * message and fetches it to check what is there, and this installation already
 * has to work around it elsewhere. A deletion that happened on GET would
 * therefore be performed by Microsoft's scanner, before the owner had read the
 * sentence explaining what they were confirming.
 *
 * So opening the link only shows this page. Deleting takes a POST that a
 * scanner does not make, carrying a CSRF token bound to the reader's session.
 */
export function ConfirmDeletionForm({ csrf, token }: { csrf: string; token: string }) {
  const [state, submit, pending] = useActionState(confirmDeletionAction, IDLE);

  return (
    <form action={submit} className="flex flex-col gap-4">
      {state.message === undefined ? null : (
        <Notice tone={state.status === 'error' ? 'error' : 'success'}>{state.message}</Notice>
      )}

      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="token" value={token} />

      <div>
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? 'Deleting…' : 'Delete this business permanently'}
        </Button>
      </div>
    </form>
  );
}
