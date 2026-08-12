'use server';

import { authorize } from '@eim/authz';
import type { EmailSeverityFloor } from '@eim/db';
import {
  acknowledgeAlert,
  savePreference,
  saveBusinessSettings,
  snoozeAlert,
} from '@eim/notifications';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { field, trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * Dealing with an alert from a browser (section 22).
 *
 * Four actions, and the one that is missing is the point: nothing here resolves
 * an alert. Section 22 auto-resolves "only when a fresh check proves recovery",
 * so a resolution is something the world does and a check observes — never
 * something a person asserts by clicking. What a person can do is say they have
 * seen it, or say not now.
 *
 * That is a real constraint rather than a philosophical one. A button that
 * closed an oversell alert would let somebody make the shop look healthy while
 * it was still selling stock it did not have.
 */

export interface AlertFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
}

export async function acknowledgeAlertAction(
  _previous: AlertFormState,
  form: FormData,
): Promise<AlertFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  const done = await acknowledgeAlert(db, {
    businessId,
    alertId: field(form, 'alertId'),
    actorUserId: context.user.id,
    ...(trimmedField(form, 'note') === '' ? {} : { note: trimmedField(form, 'note') }),
  });

  revalidatePath('/alerts');

  return done
    ? { status: 'done', message: 'Acknowledged. It stays on the list until a check clears it.' }
    : {
        status: 'error',
        message: 'That alert has already been resolved or is no longer outstanding.',
      };
}

export async function snoozeAlertAction(
  _previous: AlertFormState,
  form: FormData,
): Promise<AlertFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  // Whole hours, chosen from a fixed list on the screen. A free-text instant
  // would let somebody snooze an oversell alert until next year, which is a
  // resolution wearing a snooze's clothes.
  const hours = Number(field(form, 'hours'));

  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    return { status: 'error', message: 'Choose between one and twenty-four hours.' };
  }

  const done = await snoozeAlert(db, {
    businessId,
    alertId: field(form, 'alertId'),
    actorUserId: context.user.id,
    until: new Date(Date.now() + hours * 3_600_000),
  });

  revalidatePath('/alerts');

  return done
    ? { status: 'done', message: `Quiet for ${String(hours)} hours, then it speaks up again.` }
    : { status: 'error', message: 'That alert is no longer outstanding.' };
}

export async function savePreferenceAction(
  _previous: AlertFormState,
  form: FormData,
): Promise<AlertFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  // No permission check, deliberately. This is a person's own inbox, and the
  // permission catalogue already decides what may reach it; needing a grant to
  // ask for less mail would be a permission to be left alone.
  await savePreference(db, businessId, context.user.id, {
    emailMinSeverity: field(form, 'emailMinSeverity') as EmailSeverityFloor,
    emailOptedInKinds: form.getAll('optIn').map(String),
    emailMutedKinds: form.getAll('mute').map(String),
  });

  revalidatePath('/alerts');
  return { status: 'done', message: 'Saved.' };
}

export async function saveQuietHoursAction(
  _previous: AlertFormState,
  form: FormData,
): Promise<AlertFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  // Quiet hours are the shop's, not this person's, so this one does need a
  // grant: it changes when everybody else hears about things.
  if (!authorize(subject, 'manage_notifications').allowed) {
    return { status: 'error', message: 'You do not have permission to change this.' };
  }

  assertCsrf(form, context.session);

  const start = trimmedField(form, 'quietHoursStart');
  const end = trimmedField(form, 'quietHoursEnd');

  if ((start === '') !== (end === '')) {
    return {
      status: 'error',
      message: 'Give both a start and an end, or leave both blank for no quiet hours.',
    };
  }

  if (start !== '' && start === end) {
    return {
      status: 'error',
      message: 'A window that starts and ends at the same time is not one.',
    };
  }

  await saveBusinessSettings(db, businessId, {
    quietHoursStart: start === '' ? null : start,
    quietHoursEnd: end === '' ? null : end,
  });

  revalidatePath('/alerts');
  return { status: 'done', message: 'Saved.' };
}
