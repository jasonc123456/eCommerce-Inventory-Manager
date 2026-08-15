'use server';

import { authorize, type BusinessPermission } from '@eim/authz';
import { saveRetentionSettings } from '@eim/retention';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * Business settings (sections 9, 13, 37).
 *
 * Two things a business could not change before this existed. Its own name and
 * clock, which mattered because creating something you can never rename is half
 * a feature — and because quiet hours and the nightly reconciliation window are
 * computed in that clock (D-136), so a business created in the wrong zone sent
 * alerts at night until somebody edited the database.
 *
 * And retention. Section 37 gives the owner a choice about how long history is
 * kept, M8 built the table and the sweep that enforces it, and nothing exposed
 * it — so every installation ran on the defaults whether or not they suited it.
 */

export interface SettingsFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
}

async function authorizedFor(
  form: FormData,
  permission: BusinessPermission,
): Promise<
  | { readonly ok: true; readonly businessId: string }
  | { readonly ok: false; readonly state: SettingsFormState }
> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = trimmedField(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return {
      ok: false,
      state: { status: 'error', message: 'You are not a member of that business.' },
    };
  }

  if (!authorize(subject, permission).allowed) {
    return {
      ok: false,
      state: { status: 'error', message: 'You do not have permission to change this.' },
    };
  }

  assertCsrf(form, context.session);

  return { ok: true, businessId };
}

export async function saveBusinessDetailsAction(
  _previous: SettingsFormState,
  form: FormData,
): Promise<SettingsFormState> {
  const caller = await authorizedFor(form, 'manage_business_settings');

  if (!caller.ok) {
    return caller.state;
  }

  const { db } = runtime();
  const result = await identity().memberships.updateBusiness(db, {
    businessId: caller.businessId,
    name: trimmedField(form, 'name'),
    timezone: trimmedField(form, 'timezone'),
  });

  if (result.outcome === 'invalid') {
    return { status: 'error', message: result.reason };
  }

  if (result.outcome === 'unknown_business') {
    return { status: 'error', message: 'That business no longer exists.' };
  }

  revalidatePath('/', 'layout');

  return { status: 'done', message: 'Saved.' };
}

/**
 * Section 37's bounds, restated here.
 *
 * History may be kept forever — zero means keep — and a raw provider body may
 * not, because it holds buyer data section 13 obliges this application to be
 * able to erase. The database refuses a raw window outside one to ninety days;
 * this refuses it too, so the operator gets a sentence rather than a constraint
 * violation.
 */
export async function saveRetentionAction(
  _previous: SettingsFormState,
  form: FormData,
): Promise<SettingsFormState> {
  const caller = await authorizedFor(form, 'manage_retention_settings');

  if (!caller.ok) {
    return caller.state;
  }

  const historyDays = Number(trimmedField(form, 'historyDays'));
  const rawEventDays = Number(trimmedField(form, 'rawEventDays'));

  if (!Number.isInteger(historyDays) || historyDays < 0 || historyDays > 3650) {
    return {
      status: 'error',
      message: 'History is a whole number of days between 0 and 3650. Zero means keep it.',
    };
  }

  if (!Number.isInteger(rawEventDays) || rawEventDays < 1 || rawEventDays > 90) {
    return {
      status: 'error',
      message:
        'Raw provider bodies hold buyer data and must expire: between 1 and 90 days, never zero.',
    };
  }

  const { db } = runtime();
  await saveRetentionSettings(db, caller.businessId, { historyDays, rawEventDays });

  revalidatePath('/settings');

  return { status: 'done', message: 'Saved. The nightly sweep applies it.' };
}
