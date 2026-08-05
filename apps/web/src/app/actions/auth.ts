'use server';

import { renderSecurityNotice } from '@eim/mail';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { identity } from '../../lib/identity';
import {
  clearChallengeCookie,
  clearPendingAuthentication,
  readChallengeCookie,
  readPendingAuthentication,
  setChallengeCookie,
  setPendingAuthentication,
} from '../../lib/pending';
import { safeRedirect } from '../../lib/redirects';
import { runtime } from '../../lib/runtime';
import {
  clearSessionCookie,
  currentContext,
  requestMetadata,
  setSessionCookie,
} from '../../lib/session';
import { describeDevice, requestSignIn, verifySignIn } from '../../lib/sign-in';
import { field, trimmedField } from '../../lib/forms';

/**
 * The sign-in and sign-out actions.
 *
 * Each one is thin on purpose: the ordering that matters lives in
 * `lib/sign-in.ts`, and these translate between a form and that flow. Anything
 * with a decision in it belongs there, where it is shared by the link path and
 * the code path rather than written twice.
 */

export interface SignInFormState {
  readonly status: 'idle' | 'sent' | 'error';
  readonly message?: string;
  /** Echoed so the form does not lose what the user typed. */
  readonly email?: string;
  readonly method?: 'magic_link' | 'email_code';
}

export async function requestSignInAction(
  _previous: SignInFormState,
  form: FormData,
): Promise<SignInFormState> {
  const email = trimmedField(form, 'email');
  const method = form.get('method') === 'email_code' ? 'email_code' : 'magic_link';
  const redirectPath = safeRedirect(field(form, 'redirect'));

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { status: 'error', message: 'Enter an email address.', email, method };
  }

  const result = await requestSignIn({ email, method, redirectPath });

  if (result.outcome === 'rate_limited' || result.outcome === 'cooldown') {
    return {
      status: 'error',
      message: `Too many attempts. Try again in ${describeWait(result.retryAfterSeconds)}.`,
      email,
      method,
    };
  }

  if (result.browserBinding !== null) {
    await setChallengeCookie(result.browserBinding);
  }

  if (method === 'email_code') {
    redirect(`/sign-in/code?redirect=${encodeURIComponent(redirectPath)}`);
  }

  // The same words whether or not the address exists. Section 20: responses
  // never reveal whether an account exists.
  return {
    status: 'sent',
    message: 'If that address has an account, a sign-in link is on its way.',
    email,
    method,
  };
}

export interface VerifyFormState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
}

/** Completes an eight-digit code, submitted with the browser-binding cookie. */
export async function verifyCodeAction(
  _previous: VerifyFormState,
  form: FormData,
): Promise<VerifyFormState> {
  const code = field(form, 'code').replace(/\s/g, '');
  const email = trimmedField(form, 'email');
  const redirectPath = safeRedirect(field(form, 'redirect'));

  return await complete(code, redirectPath, {
    browserBinding: await readChallengeCookie(),
    ...(email.length > 0 ? { email } : {}),
  });
}

/**
 * Completes a magic link.
 *
 * Reached only by an explicit POST from the confirmation page. Section 20 is
 * specific that the initial GET must not authenticate or consume the token,
 * which is what stops a mail scanner or a link preview from spending it before
 * the recipient has clicked anything.
 */
export async function verifyLinkAction(
  _previous: VerifyFormState,
  form: FormData,
): Promise<VerifyFormState> {
  const token = trimmedField(form, 'token');
  const redirectPath = safeRedirect(field(form, 'redirect'));

  return await complete(token, redirectPath, {});
}

async function complete(
  presented: string,
  redirectPath: string,
  options: { browserBinding?: string | undefined; email?: string | undefined },
): Promise<VerifyFormState> {
  if (presented.length === 0) {
    return { status: 'error', message: GENERIC_FAILURE };
  }

  const result = await verifySignIn({ presented, ...options });

  if (result.outcome === 'rate_limited') {
    return {
      status: 'error',
      message: `Too many attempts. Try again in ${describeWait(result.retryAfterSeconds)}.`,
    };
  }

  if (result.outcome === 'invalid') {
    return { status: 'error', message: GENERIC_FAILURE };
  }

  await clearChallengeCookie();

  if (result.outcome === 'second_factor_required') {
    await setPendingAuthentication({
      userId: result.userId,
      redirectPath: result.redirectPath || redirectPath,
      rememberDevice: false,
    });

    redirect('/sign-in/two-factor');
  }

  await establishSession(result.userId, false);
  redirect(result.redirectPath || redirectPath);
}

/** Completes the second factor and finishes the sign-in. */
export async function verifySecondFactorAction(
  _previous: VerifyFormState,
  form: FormData,
): Promise<VerifyFormState> {
  const { db } = runtime();
  const { twoFactor } = identity();

  const pending = await readPendingAuthentication();

  if (pending === null) {
    redirect('/sign-in');
  }

  const code = trimmedField(form, 'code');
  const usingRecoveryCode = form.get('kind') === 'recovery';

  const accepted = usingRecoveryCode
    ? await twoFactor.consumeRecoveryCode(db, pending.userId, code)
    : (await twoFactor.verifyTotp(db, pending.userId, code)).outcome === 'accepted';

  if (!accepted) {
    return {
      status: 'error',
      message: usingRecoveryCode ? 'That recovery code is not usable.' : 'That code is not valid.',
    };
  }

  if (usingRecoveryCode) {
    // Section 20 notifies on account recovery, and a consumed recovery code is
    // exactly that: somebody signed in without the factor the user set up.
    await notifySecurityChange(
      pending.userId,
      'A recovery code was used to sign in to your account.',
    );
  }

  await clearPendingAuthentication();
  await establishSession(pending.userId, pending.rememberDevice);

  redirect(pending.redirectPath || '/');
}

export async function signOutAction(form: FormData): Promise<never> {
  const { db } = runtime();
  const context = await currentContext();

  if (context !== null) {
    assertCsrf(form, context.session);

    await identity().sessions.revoke(db, context.session.id, 'user_signed_out');
    await context.audit.record(db, { action: 'auth.logout', result: 'success' });
  }

  await clearSessionCookie();
  redirect('/sign-in');
}

export async function signOutEverywhereAction(form: FormData): Promise<never> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  assertCsrf(form, context.session);

  const count = await identity().sessions.revokeAllForUser(db, context.user.id, 'global_sign_out');

  await context.audit.record(db, {
    action: 'auth.session.revoked_all',
    result: 'success',
    detail: { count },
  });

  await notifySecurityChange(
    context.user.id,
    'You were signed out of every device on your account.',
  );

  await clearSessionCookie();
  redirect('/sign-in');
}

/**
 * Creates the session and writes the cookie.
 *
 * Section 20 rotates the session after authentication. There is nothing to
 * rotate on a fresh sign-in — a session is being created rather than upgraded —
 * and the fixation this defends against is defeated the same way: the token the
 * browser ends up with is minted here, after the factors passed, and was never
 * in anybody else's hands.
 */
async function establishSession(userId: string, rememberDevice: boolean): Promise<void> {
  const { db } = runtime();
  const metadata = await requestMetadata();

  const issued = await identity().sessions.create(db, {
    userId,
    rememberDevice,
    requestIp: metadata.clientAddress,
    requestUserAgent: metadata.userAgent,
    deviceLabel: metadata.userAgent === null ? null : describeDevice(metadata.userAgent),
  });

  await setSessionCookie(issued.token, issued.maxAgeMs);

  const { createAuditRecorder } = await import('@eim/audit');

  await createAuditRecorder({
    actor: { userId, kind: 'user' },
    requestIp: metadata.clientAddress,
    requestUserAgent: metadata.userAgent,
  }).record(db, {
    action: 'auth.login.succeeded',
    result: 'success',
    targetType: 'session',
    targetId: issued.session.id,
  });
}

/**
 * Sends the security notification section 20 requires for a change like this.
 *
 * Failure to deliver is logged and does not fail the action: the change has
 * already happened, and refusing it now would leave the account in a state the
 * user did not ask for because a mail server was busy.
 */
async function notifySecurityChange(userId: string, summary: string): Promise<void> {
  const { db, config, logger } = runtime();
  const { mailer, productName } = identity();
  const metadata = await requestMetadata();

  const { users } = await import('@eim/db');
  const { eq } = await import('drizzle-orm');

  const [user] = await db.select().from(users).where(eq(users.id, userId));

  if (user === undefined) {
    return;
  }

  const message = renderSecurityNotice({
    productName,
    publicUrl: config.EIM_PUBLIC_URL,
    summary,
    occurredAt: new Date(),
    ...(metadata.userAgent === null ? {} : { requestedFrom: describeDevice(metadata.userAgent) }),
  });

  const delivery = await mailer.send({ ...message, to: user.emailDisplay ?? user.email });

  if (!delivery.delivered) {
    logger.warn(
      { event: 'security_notice_failed', reason: delivery.failure.kind },
      delivery.failure.summary,
    );
  }
}

/**
 * The one thing a failed verification is allowed to say.
 *
 * Section 20: used, expired, invalid, and unknown tokens produce the same
 * generic recovery screen. Distinguishing them would say whether the address
 * has an account and whether the link had already been clicked.
 */
const GENERIC_FAILURE =
  'That sign-in link or code is no longer usable. Request a new one and try again.';

function describeWait(seconds: number): string {
  if (seconds < 60) {
    return `${String(seconds)} seconds`;
  }

  const minutes = Math.ceil(seconds / 60);

  return minutes === 1 ? 'a minute' : `${String(minutes)} minutes`;
}
