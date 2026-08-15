'use server';

import { clearActiveBusiness } from '@eim/identity';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * The second authorization (sections 5, 13).
 *
 * Kept in its own module because the confirmation page is a client component
 * and importing the request actions would drag the mail templates into its
 * bundle graph for no reason.
 *
 * The service re-reads ownership before doing anything, so this action does not
 * need to and deliberately does not duplicate the check: two copies of an
 * authorization rule is two places for it to be relaxed, and the one that has
 * to be right is the one next to the deletion.
 */

export interface DeletionFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
}

export async function confirmDeletionAction(
  _previous: DeletionFormState,
  form: FormData,
): Promise<DeletionFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  const result = await identity().deletion.confirm(db, {
    token: trimmedField(form, 'token'),
    actorUserId: context.user.id,
  });

  if (result.outcome !== 'deleted') {
    await context.audit.record(db, {
      action: 'business.deleted',
      result: 'denied',
      detail: { reason: result.outcome },
    });

    return { status: 'error', message: describeFailure(result.outcome) };
  }

  // Recorded against the business that no longer exists, which is exactly why
  // `audit_events` carries no foreign key to `businesses`: the record of a
  // deletion cannot live inside the thing deleted.
  await context.audit.record(db, {
    action: 'business.deleted',
    result: 'success',
    businessId: result.businessId,
    detail: { secretsErased: result.secretsErased },
  });

  // Every session of this user that was pointing at it, not only the current
  // one. Somebody with the shop open in another tab should not keep operating a
  // business that no longer exists.
  await clearActiveBusiness(db, context.user.id, result.businessId);

  revalidatePath('/', 'layout');
  redirect('/');
}

function describeFailure(outcome: string): string {
  switch (outcome) {
    case 'expired':
      return 'That link has expired. Request the deletion again from business settings.';
    case 'settled':
      return 'That link has already been used or the request was cancelled.';
    case 'not_an_owner':
      return 'Only an owner can confirm this, and you are not one of this business’s owners.';
    default:
      return 'That link is not valid.';
  }
}
