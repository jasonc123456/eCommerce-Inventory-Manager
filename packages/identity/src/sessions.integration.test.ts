import { createHasher } from '@eim/crypto';
import { businesses, memberships, sessions, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SESSION_POLICY } from './policy';
import {
  clearActiveBusiness,
  createSessionService,
  revokeSessionsForSecurityChange,
} from './sessions';

/**
 * Sessions against a real database.
 *
 * The properties worth proving are all about state that outlives a request: a
 * revoked session stays revoked, a rotated token stops working the instant its
 * replacement exists, and a suspended account cannot use a session that was
 * valid a moment earlier.
 */

let harness: TestDatabase;
const service = createSessionService(createHasher('s'.repeat(48)));

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

async function createUser(): Promise<string> {
  sequence += 1;
  const [user] = await harness.db
    .insert(users)
    .values({ email: `session-${String(sequence)}@example.invalid` })
    .returning({ id: users.id });

  return user!.id;
}

async function createBusinessWithMember(
  userId: string,
  role = 'manager' as const,
): Promise<string> {
  sequence += 1;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${String(sequence)}`, slug: `session-${String(sequence)}` })
    .returning({ id: businesses.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: await createUser(), role: 'owner' });

  await harness.db.insert(memberships).values({ businessId: business!.id, userId, role });

  return business!.id;
}

describe('creating a session', () => {
  it('returns the token once and stores only a hash of it', async () => {
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, { userId });

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const [stored] = await harness.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.id, session.id));

    expect(stored!.tokenHash).not.toBe(token);
    expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues a different token every time', async () => {
    const userId = await createUser();
    const tokens = new Set<string>();

    for (let index = 0; index < 20; index += 1) {
      tokens.add((await service.create(harness.db, { userId })).token);
    }

    expect(tokens.size).toBe(20);
  });

  it('applies the ordinary deadlines by default', async () => {
    const userId = await createUser();
    const { session, maxAgeMs } = await service.create(harness.db, { userId });

    const idleMs = session.idleExpiresAt.getTime() - session.createdAt.getTime();
    const absoluteMs = session.absoluteExpiresAt.getTime() - session.createdAt.getTime();

    expect(idleMs).toBe(DEFAULT_SESSION_POLICY.idleMs);
    expect(absoluteMs).toBe(DEFAULT_SESSION_POLICY.absoluteMs);
    expect(maxAgeMs).toBe(DEFAULT_SESSION_POLICY.absoluteMs);
  });

  it('applies the longer deadlines only when the user asked to be remembered', async () => {
    const userId = await createUser();
    const { session } = await service.create(harness.db, { userId, rememberDevice: true });

    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(
      DEFAULT_SESSION_POLICY.rememberedAbsoluteMs,
    );
  });
});

describe('resolving a session', () => {
  it('returns the session and the user for a live token', async () => {
    const userId = await createUser();
    const { token } = await service.create(harness.db, { userId });

    const resolution = await service.resolve(harness.db, token);

    expect(resolution.status).toBe('active');
    expect(resolution.status === 'active' && resolution.user.id).toBe(userId);
  });

  it('treats an unknown token exactly as a forged one', async () => {
    expect(await service.resolve(harness.db, 'not-a-real-token')).toEqual({ status: 'unknown' });
  });

  it('refuses a revoked session and says why', async () => {
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, { userId });

    await service.revoke(harness.db, session.id, 'user_signed_out');

    expect(await service.resolve(harness.db, token)).toEqual({
      status: 'revoked',
      reason: 'user_signed_out',
    });
  });

  it('refuses a session past its idle deadline', async () => {
    const userId = await createUser();
    const { token } = await service.create(harness.db, { userId });

    const later = new Date(Date.now() + DEFAULT_SESSION_POLICY.idleMs + 1000);

    expect(await service.resolve(harness.db, token, later)).toEqual({
      status: 'expired',
      reason: 'idle',
    });
  });

  it('refuses a session past its absolute deadline, and says absolute', async () => {
    // A session past both deadlines is past its absolute one, and that is the
    // more accurate thing to tell the user.
    const userId = await createUser();
    const { token } = await service.create(harness.db, { userId });

    const later = new Date(Date.now() + DEFAULT_SESSION_POLICY.absoluteMs + 1000);

    expect(await service.resolve(harness.db, token, later)).toEqual({
      status: 'expired',
      reason: 'absolute',
    });
  });

  it('refuses immediately when the account is suspended', async () => {
    // Section 20 requires suspension to take effect immediately, and immediate
    // has to survive a revocation sweep that has not run yet.
    const userId = await createUser();
    const { token } = await service.create(harness.db, { userId });

    await harness.db
      .update(users)
      .set({ suspendedAt: new Date(), status: 'suspended' })
      .where(eq(users.id, userId));

    expect(await service.resolve(harness.db, token)).toEqual({ status: 'account_suspended' });
  });

  it('slides the idle deadline forward on use', async () => {
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, { userId });

    const later = new Date(Date.now() + 5 * 60_000);
    const resolution = await service.resolve(harness.db, token, later);

    expect(resolution.status).toBe('active');
    expect(
      resolution.status === 'active' &&
        resolution.session.idleExpiresAt.getTime() > session.idleExpiresAt.getTime(),
    ).toBe(true);
  });

  it('does not write on every request for a change nobody can observe', async () => {
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, { userId });

    await service.resolve(harness.db, token, new Date(session.createdAt.getTime() + 100));

    const [after] = await harness.db
      .select({ idleExpiresAt: sessions.idleExpiresAt })
      .from(sessions)
      .where(eq(sessions.id, session.id));

    expect(after!.idleExpiresAt.getTime()).toBe(session.idleExpiresAt.getTime());
  });

  it('never slides the idle deadline past the absolute one', async () => {
    // Reachable only by a session that has been used continuously to within one
    // idle window of its absolute deadline, so the state is set up directly
    // rather than by waiting twenty-four days.
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, {
      userId,
      rememberDevice: true,
    });

    const nearlyOver = new Date(
      session.absoluteExpiresAt.getTime() - DEFAULT_SESSION_POLICY.rememberedIdleMs / 2,
    );

    await harness.db
      .update(sessions)
      .set({ idleExpiresAt: new Date(nearlyOver.getTime() + 60_000) })
      .where(eq(sessions.id, session.id));

    const resolution = await service.resolve(harness.db, token, nearlyOver);

    expect(resolution.status).toBe('active');
    expect(resolution.status === 'active' && resolution.session.idleExpiresAt.getTime()).toBe(
      session.absoluteExpiresAt.getTime(),
    );
  });
});

describe('rotation', () => {
  it('issues a new token and stops the old one working', async () => {
    // Section 20 rotates after authentication and after a privilege or security
    // change, which is what defeats a session fixed before sign-in.
    const userId = await createUser();
    const { token: original } = await service.create(harness.db, { userId });

    const rotated = await service.rotate(harness.db, original);

    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(original);
    expect((await service.resolve(harness.db, rotated!.token)).status).toBe('active');
    expect(await service.resolve(harness.db, original)).toEqual({
      status: 'revoked',
      reason: 'session_rotated',
    });
  });

  it('carries the remember-device choice and the active business across', async () => {
    const userId = await createUser();
    const businessId = await createBusinessWithMember(userId);
    const { token } = await service.create(harness.db, {
      userId,
      rememberDevice: true,
      activeBusinessId: businessId,
    });

    const rotated = await service.rotate(harness.db, token);

    expect(rotated!.session.rememberDevice).toBe(true);
    expect(rotated!.session.activeBusinessId).toBe(businessId);
  });

  it('refuses to rotate a session that is not live', async () => {
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, { userId });
    await service.revoke(harness.db, session.id, 'user_signed_out');

    expect(await service.rotate(harness.db, token)).toBeNull();
  });
});

describe('step-up recency', () => {
  it('counts a session authenticated a moment ago as recent', async () => {
    const userId = await createUser();
    const { session } = await service.create(harness.db, { userId });

    expect(service.hasRecentAuthentication(session)).toBe(true);
  });

  it('stops counting it after ten minutes', async () => {
    const userId = await createUser();
    const { session } = await service.create(harness.db, { userId });

    const later = new Date(session.authenticatedAt.getTime() + DEFAULT_SESSION_POLICY.stepUpMs);

    expect(service.hasRecentAuthentication(session, later)).toBe(false);
  });

  it('restarts the clock when the user proves who they are again', async () => {
    // The step-up clock is not the session's age: a session can be hours old
    // and have authenticated a minute ago.
    const userId = await createUser();
    const { token, session } = await service.create(harness.db, { userId });

    const hoursLater = new Date(Date.now() + 3 * 60 * 60_000);
    await service.markAuthenticated(harness.db, session.id, hoursLater);

    const resolution = await service.resolve(harness.db, token, hoursLater);

    expect(
      resolution.status === 'active' &&
        service.hasRecentAuthentication(resolution.session, hoursLater),
    ).toBe(true);
  });
});

describe('revocation', () => {
  it('ends every session for a user', async () => {
    const userId = await createUser();
    const first = await service.create(harness.db, { userId });
    const second = await service.create(harness.db, { userId });

    const count = await service.revokeAllForUser(harness.db, userId, 'global_sign_out');

    expect(count).toBe(2);
    expect((await service.resolve(harness.db, first.token)).status).toBe('revoked');
    expect((await service.resolve(harness.db, second.token)).status).toBe('revoked');
  });

  it('can spare the session asking, so "sign out everywhere else" works', async () => {
    const userId = await createUser();
    const keep = await service.create(harness.db, { userId });
    const other = await service.create(harness.db, { userId });

    await service.revokeAllForUser(harness.db, userId, 'global_sign_out', {
      exceptSessionId: keep.session.id,
    });

    expect((await service.resolve(harness.db, keep.token)).status).toBe('active');
    expect((await service.resolve(harness.db, other.token)).status).toBe('revoked');
  });

  it('leaves another user alone', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    const myToken = (await service.create(harness.db, { userId: mine })).token;
    const theirToken = (await service.create(harness.db, { userId: theirs })).token;

    await service.revokeAllForUser(harness.db, mine, 'global_sign_out');

    expect((await service.resolve(harness.db, myToken)).status).toBe('revoked');
    expect((await service.resolve(harness.db, theirToken)).status).toBe('active');
  });

  it('does not overwrite the reason a session was already revoked for', async () => {
    const userId = await createUser();
    const { session } = await service.create(harness.db, { userId });

    await service.revoke(harness.db, session.id, 'account_suspended');
    await service.revoke(harness.db, session.id, 'user_signed_out');

    const [row] = await harness.db
      .select({ revokedReason: sessions.revokedReason })
      .from(sessions)
      .where(eq(sessions.id, session.id));

    expect(row!.revokedReason).toBe('account_suspended');
  });

  it('names a security change as the reason when that is what happened', async () => {
    const userId = await createUser();
    await service.create(harness.db, { userId });

    await revokeSessionsForSecurityChange(harness.db, service, userId);

    const [row] = await harness.db
      .select({ revokedReason: sessions.revokedReason })
      .from(sessions)
      .where(eq(sessions.userId, userId));

    expect(row!.revokedReason).toBe('security_change');
  });
});

describe('the devices screen', () => {
  it('lists live sessions and omits revoked and expired ones', async () => {
    const userId = await createUser();
    const live = await service.create(harness.db, { userId, deviceLabel: 'Laptop' });
    const revoked = await service.create(harness.db, { userId, deviceLabel: 'Phone' });

    await service.revoke(harness.db, revoked.session.id, 'user_signed_out');

    const listed = await service.listForUser(harness.db, userId);

    expect(listed.map((row) => row.id)).toEqual([live.session.id]);
  });

  it('lists nothing for a user with no sessions', async () => {
    expect(await service.listForUser(harness.db, await createUser())).toEqual([]);
  });
});

describe('the business switcher', () => {
  it('accepts a business the user is a member of', async () => {
    const userId = await createUser();
    const businessId = await createBusinessWithMember(userId);
    const { session } = await service.create(harness.db, { userId });

    expect(await service.switchBusiness(harness.db, session.id, businessId)).toBe(true);

    const [row] = await harness.db
      .select({ activeBusinessId: sessions.activeBusinessId })
      .from(sessions)
      .where(eq(sessions.id, session.id));

    expect(row!.activeBusinessId).toBe(businessId);
  });

  it('refuses a business the user is not a member of', async () => {
    // The business id arrives from the browser, so membership is verified here
    // rather than trusted.
    const userId = await createUser();
    const stranger = await createUser();
    const businessId = await createBusinessWithMember(stranger);
    const { session } = await service.create(harness.db, { userId });

    expect(await service.switchBusiness(harness.db, session.id, businessId)).toBe(false);

    const [row] = await harness.db
      .select({ activeBusinessId: sessions.activeBusinessId })
      .from(sessions)
      .where(eq(sessions.id, session.id));

    expect(row!.activeBusinessId).toBeNull();
  });

  it('refuses a business whose membership is suspended', async () => {
    const userId = await createUser();
    const businessId = await createBusinessWithMember(userId);
    const { session } = await service.create(harness.db, { userId });

    await harness.db
      .update(memberships)
      .set({ status: 'suspended', suspendedAt: new Date() })
      .where(eq(memberships.userId, userId));

    expect(await service.switchBusiness(harness.db, session.id, businessId)).toBe(false);
  });

  it('refuses to act on a revoked session', async () => {
    const userId = await createUser();
    const businessId = await createBusinessWithMember(userId);
    const { session } = await service.create(harness.db, { userId });
    await service.revoke(harness.db, session.id, 'user_signed_out');

    expect(await service.switchBusiness(harness.db, session.id, businessId)).toBe(false);
  });

  it('clears the switcher without signing the user out of other businesses', async () => {
    // Losing one business is not a reason to end a session that also reaches
    // others.
    const userId = await createUser();
    const businessId = await createBusinessWithMember(userId);
    const { token, session } = await service.create(harness.db, {
      userId,
      activeBusinessId: businessId,
    });

    await clearActiveBusiness(harness.db, userId, businessId);

    const resolution = await service.resolve(harness.db, token);

    expect(resolution.status).toBe('active');
    expect(resolution.status === 'active' && resolution.session.activeBusinessId).toBeNull();
    expect(session.activeBusinessId).toBe(businessId);
  });
});

describe('pruning', () => {
  it('removes only sessions that can no longer authenticate anything', async () => {
    const userId = await createUser();
    const live = await service.create(harness.db, { userId });
    const { session: revoked } = await service.create(harness.db, { userId });
    await service.revoke(harness.db, revoked.id, 'user_signed_out');

    // A revoked session is kept until its absolute deadline: the devices screen
    // and the audit surface both want to say what happened to it.
    const removed = await service.pruneExpired(harness.db, new Date());
    expect(removed).toBe(0);

    const wellPast = new Date(Date.now() + DEFAULT_SESSION_POLICY.absoluteMs + 1000);
    expect(await service.pruneExpired(harness.db, wellPast)).toBeGreaterThanOrEqual(2);
    expect((await service.resolve(harness.db, live.token)).status).toBe('unknown');
  });
});
