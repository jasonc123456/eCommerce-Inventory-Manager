import { constantTimeEqual } from '@eim/crypto';
import { CHALLENGE_COOKIE_NAME, sessionCookieAttributes } from '@eim/identity';
import { cookies } from 'next/headers';

import { identity } from './identity';

/**
 * The state between "proved the email" and "proved the second factor".
 *
 * Section 20 completes the email challenge and only then performs 2FA, which
 * means there is a moment where the server knows who the caller is and must not
 * yet let them in. Nothing in the schema represents that, and adding a
 * "half-authenticated" flag to `sessions` would have been worse: every query
 * that reads a session would then have to remember to check it, and the one
 * that forgot would be an authentication bypass.
 *
 * So it lives in a cookie the server minted and authenticated for itself. There
 * is no storage to keep consistent, the value is useless without the
 * installation secret, and it expires on its own. Replaying it inside its ten
 * minutes gets you back to the second-factor prompt, which is where you already
 * were.
 */

const PENDING_COOKIE_NAME = '__Host-eim_pending';

/** Long enough to fetch a code from a phone, short enough not to linger. */
const PENDING_TTL_MS = 10 * 60_000;

export interface PendingAuthentication {
  readonly userId: string;
  /** Where to go once the second factor is satisfied. Already validated. */
  readonly redirectPath: string;
  /** Whether the user asked to be remembered, carried across the 2FA step. */
  readonly rememberDevice: boolean;
}

export async function setPendingAuthentication(
  pending: PendingAuthentication,
  now: Date = new Date(),
): Promise<void> {
  const expiresAt = now.getTime() + PENDING_TTL_MS;
  const payload = [
    pending.userId,
    String(expiresAt),
    pending.rememberDevice ? '1' : '0',
    pending.redirectPath,
  ].join('|');

  const value = `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;

  const jar = await cookies();
  jar.set(PENDING_COOKIE_NAME, value, sessionCookieAttributes(PENDING_TTL_MS));
}

export async function readPendingAuthentication(
  now: Date = new Date(),
): Promise<PendingAuthentication | null> {
  const jar = await cookies();
  const value = jar.get(PENDING_COOKIE_NAME)?.value;

  if (value === undefined) {
    return null;
  }

  const separator = value.lastIndexOf('.');

  if (separator <= 0) {
    return null;
  }

  const payload = Buffer.from(value.slice(0, separator), 'base64url').toString('utf8');
  const signature = value.slice(separator + 1);

  if (!constantTimeEqual(sign(payload), signature)) {
    return null;
  }

  const [userId, expiresAtText, remembered, ...rest] = payload.split('|');
  const expiresAt = Number(expiresAtText);

  if (userId === undefined || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return null;
  }

  return {
    userId,
    rememberDevice: remembered === '1',
    // Rejoined, because a redirect path may legitimately contain the separator
    // and splitting on it would truncate the destination.
    redirectPath: rest.join('|'),
  };
}

export async function clearPendingAuthentication(): Promise<void> {
  const jar = await cookies();

  jar.set(PENDING_COOKIE_NAME, '', { ...sessionCookieAttributes(0), maxAge: 0 });
}

/** Clears the browser-binding cookie once its challenge is finished with. */
export async function clearChallengeCookie(): Promise<void> {
  const jar = await cookies();

  jar.set(CHALLENGE_COOKIE_NAME, '', { ...sessionCookieAttributes(0), maxAge: 0 });
}

export async function setChallengeCookie(binding: string): Promise<void> {
  const jar = await cookies();

  jar.set(CHALLENGE_COOKIE_NAME, binding, sessionCookieAttributes(15 * 60_000));
}

export async function readChallengeCookie(): Promise<string | undefined> {
  const jar = await cookies();

  return jar.get(CHALLENGE_COOKIE_NAME)?.value;
}

function sign(payload: string): string {
  return identity().hasher.hash('pending_authentication', payload);
}
