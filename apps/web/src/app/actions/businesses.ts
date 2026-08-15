'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * Creating a business (sections 2, 5).
 *
 * Section 2 includes "multiple business workspaces in one installation", and
 * until this existed there was no way to make the first one: bootstrap creates
 * an owner account and nothing else, so a clean install signed you in to an
 * application where every screen said you were not a member of anything.
 *
 * Who is allowed to.
 *
 * Any signed-in user, and they become the owner. There is no permission for it
 * because permissions are held *within* a business and this is the act that
 * creates one — the first grant has to come from somewhere.
 *
 * That is safe here for a reason specific to this product: accounts do not
 * self-register. A user exists only because bootstrap created the first owner or
 * because somebody invited them, so every account is already trusted by someone.
 * Requiring installation administration instead would mean a business owner
 * could not create a second workspace for themselves, which is the thing section
 * 2 promises.
 *
 * It is recorded either way. `business.created` names the actor, so an
 * installation administrator reading the audit log can see every workspace that
 * appeared and who made it.
 */

export interface BusinessFormState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
}

export async function createBusinessAction(
  _previous: BusinessFormState,
  form: FormData,
): Promise<BusinessFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  const name = trimmedField(form, 'name');
  const timezone = trimmedField(form, 'timezone');

  const result = await identity().memberships.createBusiness(db, {
    name,
    ownerUserId: context.user.id,
    ...(timezone === '' ? {} : { timezone }),
  });

  if (result.outcome === 'invalid') {
    return { status: 'error', message: result.reason };
  }

  await context.audit.record(db, {
    action: 'business.created',
    result: 'success',
    businessId: result.businessId,
    detail: { name, slug: result.slug, timezone: timezone === '' ? 'UTC' : timezone },
  });

  // Made active immediately. Creating a workspace and then having to find it in
  // a switcher is a step with no decision in it.
  await identity().sessions.switchBusiness(db, context.session.id, result.businessId);

  revalidatePath('/', 'layout');
  redirect('/');
}
