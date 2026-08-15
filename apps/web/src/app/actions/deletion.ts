'use server';

import { businesses, memberships, users } from '@eim/db';
import { magicLinkUrl, renderDeletionConfirmation } from '@eim/mail';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext, hasStepUp } from '../../lib/session';

/**
 * Asking to delete a business, and stopping it (sections 5, 13, 19).
 *
 * Four gates stand between a click and a deleted shop, and each one closes a
 * different hole.
 *
 * **Ownership**, checked in the service against the membership row rather than
 * against a permission. Owners hold `delete_business` implicitly, so checking
 * the permission would also admit a manager somebody granted it to.
 *
 * **A recent authentication.** The session may have been open all day; this
 * asks the person to prove they are still there, exactly as it does before
 * changing who can see the shop.
 *
 * **The name, typed.** Every screen here acts on whichever business the
 * switcher points at, so deleting the wrong one is a click away. This is the
 * one confirmation muscle memory cannot satisfy.
 *
 * **An email to the owner.** The first three all live inside a session, so a
 * stolen cookie satisfies all of them. The mailbox does not.
 *
 * Cancelling deliberately passes none of these but membership, because
 * cancelling is the safe direction and a manager who sees a request they did
 * not expect should be able to stop it immediately.
 */

export interface DeletionFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
}

export async function requestDeletionAction(
  _previous: DeletionFormState,
  form: FormData,
): Promise<DeletionFormState> {
  const { db, config } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = trimmedField(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  if (!hasStepUp(context)) {
    return {
      status: 'error',
      message: 'Sign in again before deleting a business — this session is too old to be sure.',
    };
  }

  const result = await identity().deletion.request(db, {
    businessId,
    actorUserId: context.user.id,
    typedName: trimmedField(form, 'confirmName'),
    ...(trimmedField(form, 'reason') === '' ? {} : { reason: trimmedField(form, 'reason') }),
  });

  if (result.outcome !== 'requested') {
    await context.audit.record(db, {
      action: 'business.deletion_requested',
      result: 'denied',
      businessId,
      detail: { reason: result.outcome },
    });

    return { status: 'error', message: describeRequestFailure(result.outcome) };
  }

  const [business] = await db
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, businessId));

  // Sent to every owner, not only to whoever asked. Section 5 allows several,
  // and a shop being deleted is the business of all of them — it is also the
  // only way a co-owner finds out in time to cancel it.
  const owners = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.businessId, businessId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    );

  const message = renderDeletionConfirmation({
    productName: config.EIM_MAIL_FROM_NAME,
    publicUrl: config.EIM_PUBLIC_URL,
    businessName: business?.name ?? 'a business',
    requestedByEmail: context.user.email,
    requestedAt: new Date(),
    expiresAt: result.expiresAt,
    url: magicLinkUrl({
      publicUrl: config.EIM_PUBLIC_URL,
      token: result.token,
      path: '/businesses/delete',
      // Deliberately the query carrier rather than the fragment. The fragment
      // never reaches the server, and this link is opened by a server-rendered
      // page rather than by a script that could read one — and section 19's
      // reason for preferring the fragment, keeping tokens out of logs, is
      // handled here by the token being single-use and hour-long.
      tokenCarrier: 'query',
    }),
  });

  const { mailer } = identity();
  let delivered = 0;

  for (const owner of owners) {
    const outcome = await mailer.send({ ...message, to: owner.email });
    delivered += outcome.delivered ? 1 : 0;
  }

  await context.audit.record(db, {
    action: 'business.deletion_requested',
    result: 'success',
    businessId,
    detail: { owners: owners.length, delivered, expiresAt: result.expiresAt.toISOString() },
  });

  revalidatePath('/settings');

  return {
    status: 'done',
    message:
      delivered === 0
        ? 'Requested, but the confirmation email could not be sent. Check the mail settings — nothing has been deleted.'
        : `Check your email. The link works once and expires in an hour. Nothing has been deleted yet.`,
  };
}

export async function cancelDeletionAction(
  _previous: DeletionFormState,
  form: FormData,
): Promise<DeletionFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = trimmedField(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  const cancelled = await identity().deletion.cancel(db, businessId, context.user.id);

  if (cancelled) {
    await context.audit.record(db, {
      action: 'business.deletion_cancelled',
      result: 'success',
      businessId,
      detail: {},
    });
  }

  revalidatePath('/settings');

  return cancelled
    ? { status: 'done', message: 'Cancelled. The emailed link no longer works.' }
    : { status: 'error', message: 'There was no outstanding request.' };
}

function describeRequestFailure(outcome: string): string {
  switch (outcome) {
    case 'not_an_owner':
      return 'Only an owner can delete a business.';
    case 'name_mismatch':
      return 'That is not the name of this business. Type it exactly as it appears above.';
    case 'already_requested':
      return 'A deletion has already been requested. Cancel it first, or wait for it to expire.';
    default:
      return 'That business no longer exists.';
  }
}
