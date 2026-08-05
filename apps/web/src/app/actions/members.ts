'use server';

import { authorize } from '@eim/authz';
import { businesses, memberships, users } from '@eim/db';
import { renderInvitation } from '@eim/mail';
import { INVITATION_PER_BUSINESS, consume } from '@eim/ratelimit';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext, hasStepUp } from '../../lib/session';
import { field, trimmedField } from '../../lib/forms';

/**
 * Member management (sections 5 and 20).
 *
 * Every action here does the same four things in the same order: resolve the
 * session, resolve the subject in the business being acted on, ask
 * `authorize`, and only then act. The order is the point. `manage_members` is
 * also a step-up permission, so recent authentication is checked alongside it.
 *
 * The business id comes from the form, and is never trusted: the subject is
 * loaded for that business and the check is made against it, so naming a
 * business you are not a member of produces a subject of null and a denial.
 */

export interface MemberFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
}

async function requireMemberManagement(businessId: string) {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { permission: 'manage_members', reason: 'not_a_member' },
    });

    return { context, denied: 'You are not a member of that business.' as const };
  }

  const decision = authorize(subject, 'manage_members');

  if (!decision.allowed) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { permission: 'manage_members', reason: decision.reason },
    });

    return { context, denied: 'You cannot manage members in this business.' as const };
  }

  if (!hasStepUp(context)) {
    return {
      context,
      denied: 'Sign in again before changing who has access. This needs a recent sign-in.' as const,
    };
  }

  return { context, denied: null };
}

export async function inviteMemberAction(
  _previous: MemberFormState,
  form: FormData,
): Promise<MemberFormState> {
  const { db, config } = runtime();
  const { memberships: service, mailer, productName, rateLimitCache } = identity();

  const businessId = field(form, 'businessId');
  const email = trimmedField(form, 'email');
  const role = field(form, 'role') || 'viewer';

  const { context, denied } = await requireMemberManagement(businessId);

  if (denied !== null) {
    return { status: 'error', message: denied };
  }

  assertCsrf(form, context.session);

  if (!isRole(role)) {
    return { status: 'error', message: 'Choose a role.' };
  }

  const budget = await consume(db, INVITATION_PER_BUSINESS, businessId, {
    cache: rateLimitCache,
  });

  if (!budget.allowed) {
    return {
      status: 'error',
      message: 'This business has sent too many invitations recently. Try again later.',
    };
  }

  const result = await service.invite(db, {
    businessId,
    email,
    role,
    invitedByUserId: context.user.id,
  });

  if (result.outcome !== 'invited') {
    return { status: 'error', message: describeInviteFailure(result.outcome) };
  }

  const [business] = await db
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, businessId));

  const message = renderInvitation({
    productName,
    publicUrl: config.EIM_PUBLIC_URL,
    token: result.token,
    businessName: business?.name ?? 'a business',
    expiresInHours: 72,
    ...(context.user.displayName === null ? {} : { invitedByName: context.user.displayName }),
  });

  const delivery = await mailer.send({ ...message, to: email });

  await context.audit.record(db, {
    action: 'member.invited',
    result: 'success',
    businessId,
    targetType: 'invitation',
    targetId: result.invitationId,
    detail: { role, delivered: delivery.delivered },
  });

  revalidatePath('/members');

  return {
    status: 'done',
    message: delivery.delivered
      ? `Invitation sent to ${email}.`
      : `Invitation created, but the message could not be sent. Check the mail settings.`,
  };
}

export async function cancelInvitationAction(form: FormData): Promise<void> {
  const { db } = runtime();

  const businessId = field(form, 'businessId');
  const invitationId = field(form, 'invitationId');

  const { context, denied } = await requireMemberManagement(businessId);

  if (denied !== null) {
    return;
  }

  assertCsrf(form, context.session);

  const cancelled = await identity().memberships.cancelInvitation(
    db,
    invitationId,
    context.user.id,
  );

  if (cancelled) {
    await context.audit.record(db, {
      action: 'member.invitation_cancelled',
      result: 'success',
      businessId,
      targetType: 'invitation',
      targetId: invitationId,
    });
  }

  revalidatePath('/members');
}

export async function changeRoleAction(form: FormData): Promise<void> {
  const { db } = runtime();

  const businessId = field(form, 'businessId');
  const membershipId = field(form, 'membershipId');
  const role = field(form, 'role');

  const { context, denied } = await requireMemberManagement(businessId);

  if (denied !== null || !isRole(role)) {
    return;
  }

  assertCsrf(form, context.session);

  // Scoped to the named business as well as the membership, so a membership id
  // from another business cannot be changed by naming a business you do manage.
  const [membership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)));

  if (membership === undefined) {
    return;
  }

  await identity().memberships.changeRole(db, businessId, membershipId, role);

  await context.audit.record(db, {
    action: 'member.role_changed',
    result: 'success',
    businessId,
    targetType: 'membership',
    targetId: membershipId,
    detail: { before: { role: membership.role }, after: { role } },
  });

  revalidatePath('/members');
}

export async function setMembershipStatusAction(form: FormData): Promise<void> {
  const { db } = runtime();

  const businessId = field(form, 'businessId');
  const membershipId = field(form, 'membershipId');
  const suspend = form.get('intent') === 'suspend';

  const { context, denied } = await requireMemberManagement(businessId);

  if (denied !== null) {
    return;
  }

  assertCsrf(form, context.session);

  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)));

  if (membership === undefined) {
    return;
  }

  if (suspend) {
    await identity().memberships.suspend(db, membershipId);
  } else {
    await identity().memberships.reinstate(db, membershipId);
  }

  await context.audit.record(db, {
    action: suspend ? 'member.suspended' : 'member.reinstated',
    result: 'success',
    severity: 'notice',
    businessId,
    targetType: 'membership',
    targetId: membershipId,
  });

  revalidatePath('/members');
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const { db } = runtime();

  const businessId = field(form, 'businessId');
  const membershipId = field(form, 'membershipId');

  const { context, denied } = await requireMemberManagement(businessId);

  if (denied !== null) {
    return;
  }

  assertCsrf(form, context.session);

  const [membership] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)));

  if (membership === undefined) {
    return;
  }

  try {
    await identity().memberships.remove(db, membershipId);
  } catch {
    // The final-owner trigger. A business that lost its last owner would be
    // locked out of its own settings with no way back in, so the database
    // refuses and the screen simply does not change.
    return;
  }

  // The removed member's sessions survive — they may belong to other businesses
  // — but the switcher must stop pointing at one they can no longer reach.
  const { clearActiveBusiness } = await import('@eim/identity');
  await clearActiveBusiness(db, membership.userId, businessId);

  await context.audit.record(db, {
    action: 'member.removed',
    result: 'success',
    severity: 'notice',
    businessId,
    targetType: 'membership',
    targetId: membershipId,
  });

  revalidatePath('/members');
}

function isRole(value: string): value is 'owner' | 'manager' | 'operator' | 'viewer' {
  return value === 'owner' || value === 'manager' || value === 'operator' || value === 'viewer';
}

function describeInviteFailure(outcome: string): string {
  switch (outcome) {
    case 'already_a_member':
      return 'That person is already a member of this business.';
    case 'already_invited':
      return 'There is already an outstanding invitation for that address.';
    case 'domain_not_allowed':
      return 'This business only accepts invitations to approved email domains.';
    default:
      return 'The invitation could not be created.';
  }
}

/** Re-exported for the page, which lists members and their addresses. */
export async function listMembers(businessId: string) {
  const { db } = runtime();

  return await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: memberships.role,
      status: memberships.status,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.businessId, businessId))
    .orderBy(memberships.createdAt);
}
