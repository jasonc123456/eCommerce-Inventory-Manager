import { renderEmailCode, renderMagicLink } from '@eim/mail';
import {
  CHALLENGE_VERIFICATION_PER_EMAIL,
  CHALLENGE_VERIFICATION_PER_IP,
  EMAIL_CHALLENGE_PER_EMAIL,
  EMAIL_CHALLENGE_PER_IP,
  AUTHENTICATION_MAIL_BUDGET,
  clearPressure,
  consume,
  recordFailure,
  remainingDelaySeconds,
  type RateLimitRule,
} from '@eim/ratelimit';

import { identity } from './identity';
import { safeRedirect } from './redirects';
import { runtime } from './runtime';
import { anonymousContext } from './session';

/**
 * The sign-in flow (section 20).
 *
 * Everything that must happen on every attempt lives here rather than in a
 * route handler, so the ordering is written once and cannot drift between the
 * link path and the code path. That ordering matters: limits before work,
 * pressure before verification, audit on every outcome, and a response that
 * does not vary with whether the account exists.
 */

export type RequestSignInOutcome =
  /**
   * The generic answer, returned whether or not the address is known, whether
   * or not a message was sent. Section 20: "Login and request responses never
   * reveal whether an account or invitation exists."
   */
  | { readonly outcome: 'accepted'; readonly browserBinding: string | null }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'cooldown'; readonly retryAfterSeconds: number };

export interface RequestSignInInput {
  readonly email: string;
  readonly method: 'magic_link' | 'email_code';
  readonly redirectPath?: string | null;
}

export async function requestSignIn(input: RequestSignInInput): Promise<RequestSignInOutcome> {
  const { db, config } = runtime();
  const { challenges, mailer, rateLimitCache, productName } = identity();
  const { clientAddress, userAgent, audit } = await anonymousContext();

  const fingerprint = challenges.fingerprintOf(input.email);

  // Limits first, so an attacker's cost is paid before ours. Each is checked
  // rather than short-circuited on the first failure, because both counters
  // should reflect the attempt that was made.
  const limits = await Promise.all([
    check(EMAIL_CHALLENGE_PER_EMAIL, fingerprint),
    ...(clientAddress === null ? [] : [check(EMAIL_CHALLENGE_PER_IP, clientAddress)]),
    check(AUTHENTICATION_MAIL_BUDGET, 'installation'),
  ]);

  const blocked = limits.find((decision) => !decision.allowed);

  if (blocked !== undefined) {
    await audit.record(db, {
      action: 'auth.rate_limited',
      result: 'denied',
      detail: { stage: 'request', method: input.method },
    });

    return { outcome: 'rate_limited', retryAfterSeconds: blocked.retryAfterSeconds };
  }

  const issued = await challenges.issue(db, {
    email: input.email,
    method: input.method,
    redirectPath: safeRedirect(input.redirectPath),
    requestIp: clientAddress,
    requestUserAgent: userAgent,
  });

  if (issued.outcome === 'cooldown') {
    return { outcome: 'cooldown', retryAfterSeconds: issued.retryAfterSeconds };
  }

  await audit.record(db, {
    action: 'auth.challenge.issued',
    result: 'success',
    detail: {
      method: input.method,
      // The fingerprint rather than the address (section 19), and never the
      // secret. `recipientExists` is deliberately absent: an audit row that
      // recorded it would answer the question the response refuses to.
      emailFingerprint: fingerprint.slice(0, 16),
      resendCount: issued.resendCount,
    },
  });

  if (issued.recipientExists) {
    const expiresInMinutes = Math.round((issued.expiresAt.getTime() - Date.now()) / 60_000);

    const message =
      input.method === 'magic_link'
        ? renderMagicLink({
            productName,
            publicUrl: config.EIM_PUBLIC_URL,
            token: issued.secret,
            expiresInMinutes,
            ...(userAgent === null ? {} : { requestedFrom: describeDevice(userAgent) }),
          })
        : renderEmailCode({
            productName,
            publicUrl: config.EIM_PUBLIC_URL,
            code: issued.secret,
            expiresInMinutes,
            ...(userAgent === null ? {} : { requestedFrom: describeDevice(userAgent) }),
          });

    const delivery = await mailer.send({ ...message, to: input.email });

    if (!delivery.delivered) {
      // Section 20: delivery failures are recorded and shown to administrators,
      // and "do not change challenge validity rules". The challenge stands, and
      // the caller still gets the generic answer, because reporting a delivery
      // failure to the browser would answer the enumeration question.
      runtime().logger.error(
        { event: 'auth_mail_failed', reason: delivery.failure.kind },
        delivery.failure.summary,
      );

      await audit.record(db, {
        action: 'auth.challenge.issued',
        result: 'failure',
        severity: 'warning',
        detail: { stage: 'delivery', reason: delivery.failure.kind },
      });
    }
  }

  return { outcome: 'accepted', browserBinding: issued.browserBinding };

  async function check(rule: RateLimitRule, subject: string) {
    return await consume(db, rule, subject, { cache: rateLimitCache });
  }
}

export type VerifySignInOutcome =
  | { readonly outcome: 'signed_in'; readonly userId: string; readonly redirectPath: string }
  | {
      /** The email factor passed; section 20 requires the second one next. */
      readonly outcome: 'second_factor_required';
      readonly userId: string;
      readonly redirectPath: string;
    }
  /** Used, expired, invalid, or unknown — one screen for all of them. */
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export interface VerifySignInInput {
  readonly presented: string;
  readonly browserBinding?: string | undefined;
  /** The address, when the form collected one, for pressure accounting. */
  readonly email?: string | undefined;
}

export async function verifySignIn(input: VerifySignInInput): Promise<VerifySignInOutcome> {
  const { db } = runtime();
  const { challenges, twoFactor, rateLimitCache } = identity();
  const { clientAddress, audit } = await anonymousContext();

  const fingerprint = input.email === undefined ? null : challenges.fingerprintOf(input.email);

  if (fingerprint !== null) {
    // Section 20's progressive delay. Checked before the attempt, so the wait
    // an attacker was told about is a wait they actually serve.
    const wait = await remainingDelaySeconds(db, fingerprint);

    if (wait > 0) {
      return { outcome: 'rate_limited', retryAfterSeconds: wait };
    }
  }

  const verificationLimits = await Promise.all([
    ...(fingerprint === null
      ? []
      : [consume(db, CHALLENGE_VERIFICATION_PER_EMAIL, fingerprint, { cache: rateLimitCache })]),
    ...(clientAddress === null
      ? []
      : [
          consume(db, CHALLENGE_VERIFICATION_PER_IP, clientAddress, {
            cache: rateLimitCache,
          }),
        ]),
  ]);

  const blocked = verificationLimits.find((decision) => !decision.allowed);

  if (blocked !== undefined) {
    await audit.record(db, {
      action: 'auth.rate_limited',
      result: 'denied',
      detail: { stage: 'verify' },
    });

    return { outcome: 'rate_limited', retryAfterSeconds: blocked.retryAfterSeconds };
  }

  const result = await challenges.verify(db, input.presented, {
    ...(input.browserBinding === undefined ? {} : { browserBinding: input.browserBinding }),
  });

  if (result.outcome !== 'verified') {
    if (fingerprint !== null) {
      await recordFailure(db, fingerprint);
    }

    await audit.record(db, {
      action: 'auth.challenge.failed',
      result: 'failure',
      // The specific reason is recorded here and not shown to the caller, which
      // is the whole point of keeping them separate.
      detail: { reason: result.outcome },
    });

    return { outcome: 'invalid' };
  }

  if (fingerprint !== null) {
    // Cleared on success, which is what keeps the delay costly for an attacker
    // and free for the person who mistyped a digit.
    await clearPressure(db, fingerprint);
  }

  await audit.record(db, {
    action: 'auth.challenge.consumed',
    result: 'success',
    actor: { userId: result.userId, kind: 'user' },
    detail: { method: result.challenge.method },
  });

  const redirectPath = safeRedirect(result.challenge.redirectPath);

  // Section 20: "Two email messages to the same inbox never count as two
  // factors", so an account with a second factor enrolled is not signed in yet.
  if (await twoFactor.isTotpActive(db, result.userId)) {
    return { outcome: 'second_factor_required', userId: result.userId, redirectPath };
  }

  return { outcome: 'signed_in', userId: result.userId, redirectPath };
}

/**
 * A short, recognisable description of a browser.
 *
 * Shown in a sign-in message so a recipient who did not ask can tell whether it
 * was them. Deliberately coarse: section 20 keeps device metadata minimal, and
 * a full user-agent string in an email is both unreadable and more than the
 * message needs.
 */
export function describeDevice(userAgent: string): string {
  const browser = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bOPR\//.test(userAgent)
      ? 'Opera'
      : /\bFirefox\//.test(userAgent)
        ? 'Firefox'
        : /\bChrome\//.test(userAgent)
          ? 'Chrome'
          : /\bSafari\//.test(userAgent)
            ? 'Safari'
            : 'an unrecognised browser';

  const platform = /\bWindows\b/.test(userAgent)
    ? 'Windows'
    : /\b(iPhone|iPad|iOS)\b/.test(userAgent)
      ? 'iOS'
      : /\bAndroid\b/.test(userAgent)
        ? 'Android'
        : /\bMac OS X\b/.test(userAgent)
          ? 'macOS'
          : /\bLinux\b/.test(userAgent)
            ? 'Linux'
            : null;

  return platform === null ? browser : `${browser} on ${platform}`;
}
