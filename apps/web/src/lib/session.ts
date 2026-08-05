import { createAuditRecorder, type AuditContext, type AuditRecorder } from '@eim/audit';
import type { Session, User } from '@eim/db';
import { SESSION_COOKIE_NAME, sessionCookieAttributes } from '@eim/identity';
import { cookies, headers } from 'next/headers';

import { resolveClientAddress } from './client-address';
import { identity } from './identity';
import { runtime } from './runtime';

/**
 * Reading the caller's session on the server.
 *
 * Every screen and every action goes through here rather than trusting anything
 * the browser sent about who it is. The cookie carries an opaque token and
 * nothing else — no user id, no role, no business — so there is nothing in it
 * to tamper with and no path where a forged value becomes an identity.
 */

export interface RequestContext {
  readonly session: Session;
  readonly user: User;
  readonly clientAddress: string | null;
  readonly userAgent: string | null;
  readonly audit: AuditRecorder;
}

export interface AnonymousContext {
  readonly clientAddress: string | null;
  readonly userAgent: string | null;
  readonly audit: AuditRecorder;
}

/** The request's client address and user agent, whether or not signed in. */
export async function requestMetadata(): Promise<{
  clientAddress: string | null;
  userAgent: string | null;
}> {
  const incoming = await headers();
  const { config } = runtime();

  return {
    clientAddress: resolveClientAddress(incoming, config.EIM_TRUSTED_PROXY_CIDRS).address,
    userAgent: incoming.get('user-agent'),
  };
}

/** An audit recorder for a caller who has not signed in. */
export async function anonymousContext(): Promise<AnonymousContext> {
  const metadata = await requestMetadata();

  return {
    ...metadata,
    audit: createAuditRecorder({
      actor: { userId: null, kind: 'system' },
      requestIp: metadata.clientAddress,
      requestUserAgent: metadata.userAgent,
    }),
  };
}

/**
 * The signed-in caller, or null.
 *
 * Returns null for every failure — no session, expired, revoked, suspended —
 * because a page has one thing to do about all of them, which is show the
 * sign-in screen. Callers that need to explain the difference use
 * `resolveSession` directly.
 */
export async function currentContext(): Promise<RequestContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;

  if (token === undefined || token.length === 0) {
    return null;
  }

  const { db } = runtime();
  const resolution = await identity().sessions.resolve(db, token);

  if (resolution.status !== 'active') {
    return null;
  }

  const metadata = await requestMetadata();
  const context: AuditContext = {
    actor: { userId: resolution.user.id, kind: 'user' },
    businessId: resolution.session.activeBusinessId,
    requestIp: metadata.clientAddress,
    requestUserAgent: metadata.userAgent,
  };

  return {
    session: resolution.session,
    user: resolution.user,
    ...metadata,
    audit: createAuditRecorder(context),
  };
}

/**
 * Writes the session cookie.
 *
 * `maxAge` is the absolute deadline rather than the idle one, so closing the
 * browser and returning the next morning still finds the cookie. The idle
 * deadline is enforced server-side, where it cannot be edited.
 */
export async function setSessionCookie(token: string, maxAgeMs: number): Promise<void> {
  const jar = await cookies();

  jar.set(SESSION_COOKIE_NAME, token, sessionCookieAttributes(maxAgeMs));
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();

  jar.set(SESSION_COOKIE_NAME, '', { ...sessionCookieAttributes(0), maxAge: 0 });
}

/**
 * Whether the caller authenticated recently enough for a sensitive action.
 *
 * Section 20 requires authentication within the previous ten minutes before
 * credentials, user and role changes, publication, price changes, label
 * purchase, security changes, sensitive exports, and destructive bulk actions.
 * This is the check; each of those call sites is responsible for making it.
 */
export function hasStepUp(context: RequestContext): boolean {
  return identity().sessions.hasRecentAuthentication(context.session);
}
