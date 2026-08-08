'use server';

import { cancelOperation, confirmOperation } from '@eim/listings';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { field } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * Confirming and withdrawing reviewed operations, from the browser (sections
 * 11, 13, 14, 20, 30).
 *
 * These two actions carry the whole of section 30's AC-09 and AC-10 into the
 * web tier, and what is notable is how little they do. They do not decide
 * whether the values are still current, whether the permission is held, or
 * whether the session authenticated recently enough — `confirmOperation` decides
 * all of that, from the row, in one transaction, and writes down each refusal.
 * The action's job is to hand it the fingerprint the browser sent back and to
 * report the answer.
 *
 * The fingerprint is the important parameter. It comes from a hidden field
 * rendered with the preview, so what returns is an assertion about which screen
 * was read, not a copy of the values themselves. A browser that alters it gets a
 * refusal; a browser that alters the values it displays gets nothing at all,
 * because the values are never sent.
 *
 * There is no action here that proposes an operation, and none that executes
 * one. Proposing needs a provider read, and executing needs a provider write;
 * both belong with the connection that owns the credentials rather than with a
 * form submission.
 */

export interface OperationFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
  /** Set when a confirmation was refused, so the screen can explain which rule. */
  readonly reason?: string;
}

export async function confirmOperationAction(
  _previous: OperationFormState,
  form: FormData,
): Promise<OperationFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const operationId = field(form, 'operationId');
  const fingerprint = field(form, 'fingerprint');

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { reason: 'not_a_member', operationId },
    });

    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  // Whether this session authenticated inside the step-up window. Read from the
  // session rather than sent by the form, for the obvious reason.
  const hasRecentAuthentication = identity().sessions.hasRecentAuthentication(context.session);

  const outcome = await confirmOperation(db, {
    businessId,
    operationId,
    subject,
    fingerprint,
    hasRecentAuthentication,
  });

  if (!outcome.confirmed) {
    await context.audit.record(db, {
      action: 'listing.operation.refused',
      result: 'denied',
      businessId,
      targetType: 'reviewed_operation',
      targetId: operationId,
      detail: { reason: outcome.reason },
    });

    return { status: 'error', message: outcome.detail, reason: outcome.reason };
  }

  await context.audit.record(db, {
    action: 'listing.operation.confirmed',
    result: 'success',
    businessId,
    targetType: 'reviewed_operation',
    targetId: operationId,
    detail: { kind: outcome.operation.kind, permission: outcome.operation.requiredPermission },
  });

  revalidatePath('/operations');

  return {
    status: 'done',
    // Deliberately not "done": confirming authorizes the work, and the work
    // happens against a provider afterwards. Saying it is finished would be a
    // claim about a shop this action has not contacted.
    message: 'Confirmed. This will be carried out against the channel.',
  };
}

export async function cancelOperationAction(
  _previous: OperationFormState,
  form: FormData,
): Promise<OperationFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const operationId = field(form, 'operationId');

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  // Withdrawing a proposal needs no permission beyond membership. Nothing
  // happens as a result, the subject is freed for a fresh proposal, and a
  // control that only some members can use would leave abandoned proposals
  // holding their subjects until they expired.
  const cancelled = await cancelOperation(db, { businessId, operationId });

  if (!cancelled) {
    return { status: 'error', message: 'That proposal has already been decided.' };
  }

  await context.audit.record(db, {
    action: 'listing.operation.cancelled',
    result: 'success',
    businessId,
    targetType: 'reviewed_operation',
    targetId: operationId,
    detail: {},
  });

  revalidatePath('/operations');

  return { status: 'done', message: 'Withdrawn.' };
}
