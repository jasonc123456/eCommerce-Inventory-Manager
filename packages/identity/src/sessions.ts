import { generateToken, type KeyedHasher } from '@eim/crypto';
import {
  memberships,
  sessions,
  users,
  type Database,
  type Session,
  type SessionRevocationReason,
  type User,
} from '@eim/db';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import { DEFAULT_SESSION_POLICY, type SessionPolicy } from './policy';

/**
 * Sessions (section 20).
 *
 * The token is opaque and random, and the database holds only a keyed hash of
 * it. Not a signed token carrying claims: a self-hosted installation has to be
 * able to end a session immediately — on suspension, on a security change, on a
 * global sign-out — and a stateless token cannot be recalled, only waited out.
 * The row is the authority, and revoking is one UPDATE.
 *
 * Two deadlines rather than one, both stored rather than computed. An idle
 * deadline ends a session somebody walked away from; an absolute deadline ends
 * one that has been kept alive by activity for a month. Storing them means
 * changing the policy never retroactively extends a session that already exists,
 * which is the behaviour an operator shortening a timeout after an incident is
 * expecting.
 */

export type SessionResolution =
  | { readonly status: 'active'; readonly session: Session; readonly user: User }
  /** No such token. Deliberately indistinguishable from a forged one. */
  | { readonly status: 'unknown' }
  | { readonly status: 'revoked'; readonly reason: SessionRevocationReason | null }
  | { readonly status: 'expired'; readonly reason: 'idle' | 'absolute' }
  | { readonly status: 'account_suspended' };

export interface CreateSessionInput {
  readonly userId: string;
  /** Section 20's explicit remember-device choice, never a default. */
  readonly rememberDevice?: boolean;
  readonly requestIp?: string | null;
  readonly requestUserAgent?: string | null;
  readonly deviceLabel?: string | null;
  readonly activeBusinessId?: string | null;
}

export interface IssuedSession {
  /** The value the cookie carries. Returned exactly once and never stored. */
  readonly token: string;
  readonly session: Session;
  /** How long the cookie should live: the absolute deadline, not the idle one. */
  readonly maxAgeMs: number;
}

/** Anything that can run these statements: the pool or a transaction. */
export type SessionWriter = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export interface SessionService {
  create(db: SessionWriter, input: CreateSessionInput): Promise<IssuedSession>;
  resolve(db: SessionWriter, token: string, now?: Date): Promise<SessionResolution>;
  /** Replaces a live session with a new one, as section 20 requires after
   * authentication and after a privilege or security change. */
  rotate(db: SessionWriter, token: string, now?: Date): Promise<IssuedSession | null>;
  /** Records that the user has just proved who they are, restarting the
   * ten-minute step-up clock. */
  markAuthenticated(db: SessionWriter, sessionId: string, now?: Date): Promise<void>;
  hasRecentAuthentication(session: Session, now?: Date): boolean;
  revoke(
    db: SessionWriter,
    sessionId: string,
    reason: SessionRevocationReason,
    now?: Date,
  ): Promise<void>;
  revokeAllForUser(
    db: SessionWriter,
    userId: string,
    reason: SessionRevocationReason,
    options?: { readonly exceptSessionId?: string; readonly now?: Date },
  ): Promise<number>;
  listForUser(db: SessionWriter, userId: string, now?: Date): Promise<Session[]>;
  switchBusiness(db: SessionWriter, sessionId: string, businessId: string): Promise<boolean>;
  pruneExpired(db: SessionWriter, now?: Date): Promise<number>;
}

export function createSessionService(
  hasher: KeyedHasher,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): SessionService {
  const hashOf = (token: string): string => hasher.hash('session', token);

  return {
    async create(db, input) {
      const now = new Date();
      const remembered = input.rememberDevice ?? false;
      const idleMs = remembered ? policy.rememberedIdleMs : policy.idleMs;
      const absoluteMs = remembered ? policy.rememberedAbsoluteMs : policy.absoluteMs;

      const token = generateToken();

      const [session] = await db
        .insert(sessions)
        .values({
          userId: input.userId,
          tokenHash: hashOf(token),
          rememberDevice: remembered,
          createdAt: now,
          lastSeenAt: now,
          authenticatedAt: now,
          idleExpiresAt: new Date(now.getTime() + idleMs),
          absoluteExpiresAt: new Date(now.getTime() + absoluteMs),
          activeBusinessId: input.activeBusinessId ?? null,
          deviceLabel: input.deviceLabel ?? null,
          requestIp: input.requestIp ?? null,
          requestUserAgent: input.requestUserAgent ?? null,
        })
        .returning();

      if (session === undefined) {
        // An INSERT ... RETURNING that returns nothing means the row was not
        // written, and handing back a session object anyway would produce a
        // cookie for a session that does not exist.
        throw new Error('the session could not be created');
      }

      return { token, session, maxAgeMs: absoluteMs };
    },

    async resolve(db, token, now = new Date()) {
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, hashOf(token)));

      if (row === undefined) {
        return { status: 'unknown' };
      }

      const { session, user } = row;

      if (session.revokedAt !== null) {
        return { status: 'revoked', reason: session.revokedReason };
      }

      // Absolute first. A session past both deadlines is past its absolute one,
      // and that is the more accurate thing to tell the user.
      if (session.absoluteExpiresAt.getTime() <= now.getTime()) {
        return { status: 'expired', reason: 'absolute' };
      }

      if (session.idleExpiresAt.getTime() <= now.getTime()) {
        return { status: 'expired', reason: 'idle' };
      }

      // Suspension takes effect on the next request rather than waiting for a
      // sweep to revoke every session. Section 20 requires it to be immediate,
      // and "immediate" has to survive a sweep that has not run yet.
      if (user.suspendedAt !== null || user.status !== 'active' || user.deletedAt !== null) {
        return { status: 'account_suspended' };
      }

      const idleMs = session.rememberDevice ? policy.rememberedIdleMs : policy.idleMs;
      const slid = slideIdleDeadline(session, now, idleMs, policy.idleWriteBackMs);

      if (slid !== null) {
        await db
          .update(sessions)
          .set({ lastSeenAt: now, idleExpiresAt: slid })
          .where(eq(sessions.id, session.id));

        return {
          status: 'active',
          session: { ...session, lastSeenAt: now, idleExpiresAt: slid },
          user,
        };
      }

      return { status: 'active', session, user };
    },

    async rotate(db, token, now = new Date()) {
      const current = await this.resolve(db, token, now);

      if (current.status !== 'active') {
        return null;
      }

      const issued = await this.create(db, {
        userId: current.session.userId,
        rememberDevice: current.session.rememberDevice,
        requestIp: current.session.requestIp,
        requestUserAgent: current.session.requestUserAgent,
        deviceLabel: current.session.deviceLabel,
        activeBusinessId: current.session.activeBusinessId,
      });

      // Revoked after the replacement exists, so a failure between the two
      // leaves the user signed in rather than signed out with no replacement.
      await this.revoke(db, current.session.id, 'session_rotated', now);

      return issued;
    },

    async markAuthenticated(db, sessionId, now = new Date()) {
      await db
        .update(sessions)
        .set({ authenticatedAt: now, lastSeenAt: now })
        .where(eq(sessions.id, sessionId));
    },

    hasRecentAuthentication(session, now = new Date()) {
      return now.getTime() - session.authenticatedAt.getTime() < policy.stepUpMs;
    },

    async revoke(db, sessionId, reason, now = new Date()) {
      await db
        .update(sessions)
        .set({ revokedAt: now, revokedReason: reason })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    },

    async revokeAllForUser(db, userId, reason, options = {}) {
      const now = options.now ?? new Date();

      const revoked = await db
        .update(sessions)
        .set({ revokedAt: now, revokedReason: reason })
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            // The current session is spared when the caller asks, so "sign out
            // everywhere else" does not sign the user out of the browser they
            // are asking from.
            options.exceptSessionId === undefined
              ? sql`true`
              : sql`${sessions.id} <> ${options.exceptSessionId}`,
          ),
        )
        .returning({ id: sessions.id });

      return revoked.length;
    },

    async listForUser(db, userId, now = new Date()) {
      return await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            sql`${sessions.absoluteExpiresAt} > ${now}`,
            sql`${sessions.idleExpiresAt} > ${now}`,
          ),
        )
        .orderBy(sql`${sessions.lastSeenAt} desc`);
    },

    async switchBusiness(db, sessionId, businessId) {
      // Membership is verified here rather than trusted from the request,
      // because the business id arrives from the browser. The session field is
      // advisory — every request re-checks authorization — but writing an
      // unverified value would put a business the user cannot see into the one
      // place the UI reads it from.
      const [session] = await db
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));

      if (session === undefined) {
        return false;
      }

      const [membership] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, session.userId),
            eq(memberships.businessId, businessId),
            eq(memberships.status, 'active'),
          ),
        );

      if (membership === undefined) {
        return false;
      }

      await db
        .update(sessions)
        .set({ activeBusinessId: businessId })
        .where(eq(sessions.id, sessionId));

      return true;
    },

    async pruneExpired(db, now = new Date()) {
      // Only rows that can no longer authenticate anything. A revoked session is
      // kept until its absolute deadline passes, because the devices screen and
      // the audit surface both want to be able to say what happened to it.
      const removed = await db
        .delete(sessions)
        .where(lte(sessions.absoluteExpiresAt, now))
        .returning({ id: sessions.id });

      return removed.length;
    },
  };
}

/**
 * The new idle deadline, or null when it is not worth a write.
 *
 * Capped at the absolute deadline, so sliding can extend a session inside its
 * lifetime but never past it.
 */
function slideIdleDeadline(
  session: Session,
  now: Date,
  idleMs: number,
  writeBackMs: number,
): Date | null {
  const proposed = Math.min(now.getTime() + idleMs, session.absoluteExpiresAt.getTime());

  if (proposed - session.idleExpiresAt.getTime() < writeBackMs) {
    return null;
  }

  return new Date(proposed);
}

/**
 * Ends every session belonging to a user whose account has just been suspended
 * or whose security has just changed.
 *
 * A convenience over `revokeAllForUser` that also states the reason as a single
 * concept, so a caller cannot suspend an account and revoke its sessions with a
 * reason that contradicts it.
 */
export async function revokeSessionsForSecurityChange(
  db: SessionWriter,
  service: SessionService,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return await service.revokeAllForUser(db, userId, 'security_change', { now });
}

/**
 * Live sessions that would be affected by removing a membership.
 *
 * Used to clear the switcher when somebody loses access to the business their
 * session is pointing at. The session itself survives: losing one business is
 * not a reason to sign a user out of the others.
 */
export async function clearActiveBusiness(
  db: SessionWriter,
  userId: string,
  businessId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ activeBusinessId: null })
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.activeBusinessId, businessId),
        isNull(sessions.revokedAt),
      ),
    );
}
