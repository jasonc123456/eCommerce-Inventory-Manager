'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext, hasStepUp } from '../../lib/session';
import { field, trimmedField } from '../../lib/forms';

/**
 * Actions on the caller's own account and sessions.
 *
 * Each one loads the session itself rather than taking a user id from the form.
 * There is no parameter here that says who is acting, which is what makes it
 * impossible for a request to act as somebody else by editing one.
 */

export async function switchBusinessAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  const businessId = field(form, 'businessId');

  // Membership is verified inside the service, because the business id came
  // from the browser and a switcher that trusted it would be a way to put a
  // business the user cannot see into the place the UI reads from.
  await identity().sessions.switchBusiness(db, context.session.id, businessId);

  revalidatePath('/', 'layout');
}

export async function revokeSessionAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  const sessionId = field(form, 'sessionId');

  // Scoped to the caller's own sessions. Without the ownership check this would
  // be a way to sign anybody out by guessing an identifier.
  const own = await identity().sessions.listForUser(db, context.user.id);

  if (!own.some((session) => session.id === sessionId)) {
    return;
  }

  await identity().sessions.revoke(db, sessionId, 'user_signed_out');

  await context.audit.record(db, {
    action: 'auth.session.revoked',
    result: 'success',
    targetType: 'session',
    targetId: sessionId,
  });

  revalidatePath('/account/sessions');
}

export type SecurityFormState =
  | { readonly status: 'idle' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'enrolling'; readonly otpauthUri: string; readonly manualEntryKey: string }
  | { readonly status: 'codes'; readonly codes: readonly string[] }
  | { readonly status: 'done'; readonly message: string };

export async function beginTotpEnrollmentAction(
  _previous: SecurityFormState,
  form: FormData,
): Promise<SecurityFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  // Section 20 requires authentication within the previous ten minutes before a
  // security change. Adding a factor is one.
  if (!hasStepUp(context)) {
    return { status: 'error', message: STEP_UP_REQUIRED };
  }

  const enrollment = await identity().twoFactor.beginTotpEnrollment(db, {
    userId: context.user.id,
    accountLabel: context.user.email,
    issuer: identity().productName,
  });

  return {
    status: 'enrolling',
    otpauthUri: enrollment.otpauthUri,
    manualEntryKey: enrollment.manualEntryKey,
  };
}

export async function activateTotpAction(
  _previous: SecurityFormState,
  form: FormData,
): Promise<SecurityFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  if (!hasStepUp(context)) {
    return { status: 'error', message: STEP_UP_REQUIRED };
  }

  const code = trimmedField(form, 'code');
  const result = await identity().twoFactor.activateTotp(db, context.user.id, code);

  if (result.outcome !== 'accepted') {
    return { status: 'error', message: 'That code is not valid. Try the next one.' };
  }

  await context.audit.record(db, {
    action: 'auth.totp.enabled',
    result: 'success',
    severity: 'notice',
  });

  // Issued immediately rather than offered later. A second factor with no way
  // around it is a lockout waiting for a lost phone, and a user who has to go
  // looking for recovery codes generally does not.
  const codes = await identity().twoFactor.issueRecoveryCodes(db, context.user.id);

  await context.audit.record(db, {
    action: 'auth.recovery_codes.regenerated',
    result: 'success',
    detail: { count: codes.length },
  });

  revalidatePath('/account/security');

  return { status: 'codes', codes };
}

export async function regenerateRecoveryCodesAction(
  _previous: SecurityFormState,
  form: FormData,
): Promise<SecurityFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  if (!hasStepUp(context)) {
    return { status: 'error', message: STEP_UP_REQUIRED };
  }

  const codes = await identity().twoFactor.issueRecoveryCodes(db, context.user.id);

  await context.audit.record(db, {
    action: 'auth.recovery_codes.regenerated',
    result: 'success',
    severity: 'notice',
    detail: { count: codes.length },
  });

  revalidatePath('/account/security');

  return { status: 'codes', codes };
}

export async function disableTotpAction(
  _previous: SecurityFormState,
  form: FormData,
): Promise<SecurityFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  if (!hasStepUp(context)) {
    return { status: 'error', message: STEP_UP_REQUIRED };
  }

  // Section 20: disabling requires recent authentication **plus** a current
  // second factor or a recovery code. Recent authentication alone would let
  // somebody who found an unlocked laptop remove the factor protecting it.
  const proof = trimmedField(form, 'proof');
  const { twoFactor } = identity();

  const proved =
    (await twoFactor.verifyTotp(db, context.user.id, proof)).outcome === 'accepted' ||
    (await twoFactor.consumeRecoveryCode(db, context.user.id, proof));

  if (!proved) {
    return {
      status: 'error',
      message: 'Enter a current authenticator code or an unused recovery code to turn this off.',
    };
  }

  await twoFactor.disableTotp(db, context.user.id);

  await context.audit.record(db, {
    action: 'auth.totp.disabled',
    result: 'success',
    severity: 'warning',
  });

  revalidatePath('/account/security');

  return { status: 'done', message: 'Two-factor authentication is off.' };
}

export async function removePasskeyAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  if (!hasStepUp(context)) {
    return;
  }

  const credentialId = field(form, 'credentialId');

  // Scoped to the owner. Section 20: only the user may remove their passkeys,
  // and an administrator cannot replace another user's authenticator.
  const removed = await identity().passkeys.remove(db, context.user.id, credentialId);

  if (removed) {
    await context.audit.record(db, {
      action: 'auth.passkey.removed',
      result: 'success',
      severity: 'notice',
    });
  }

  revalidatePath('/account/security');
}

const STEP_UP_REQUIRED =
  'Sign in again before changing security settings. This step is required within ten minutes ' +
  'of authenticating.';
