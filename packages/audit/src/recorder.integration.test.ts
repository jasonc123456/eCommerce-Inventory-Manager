import { auditEvents, businesses, memberships, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditError, createAuditRecorder, recordAuditEvent } from './recorder';
import { readBusinessAuditEvents, readInstallationAuditEvents } from './query';

/**
 * The audit writer against a real database.
 *
 * A unit test with a fake writer would prove the object shape and nothing about
 * the two properties that matter: that the row survives its own transaction
 * being rolled back only when the transaction is rolled back, and that reading
 * one tenant's history never returns another's.
 */

let harness: TestDatabase;

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
    .values({ email: `audit-${String(sequence)}@example.invalid` })
    .returning({ id: users.id });

  return user!.id;
}

async function createBusiness(): Promise<string> {
  sequence += 1;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${String(sequence)}`, slug: `audit-${String(sequence)}` })
    .returning({ id: businesses.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: await createUser(), role: 'owner' });

  return business!.id;
}

const system = { userId: null, kind: 'system' } as const;

describe('recordAuditEvent', () => {
  it('writes an event with the request context applied', async () => {
    const userId = await createUser();
    const businessId = await createBusiness();
    const correlationId = crypto.randomUUID();

    const recorder = createAuditRecorder({
      actor: { userId, kind: 'user' },
      businessId,
      correlationId,
      requestIp: '203.0.113.4',
      requestUserAgent: 'Mozilla/5.0',
    });

    await recorder.record(harness.db, {
      action: 'member.role_changed',
      result: 'success',
      targetType: 'membership',
      targetId: userId,
      detail: { before: { role: 'viewer' }, after: { role: 'manager' } },
    });

    const [event] = await readBusinessAuditEvents(harness.db, businessId);

    expect(event).toMatchObject({
      action: 'member.role_changed',
      result: 'success',
      severity: 'info',
      actorKind: 'user',
      actorUserId: userId,
      businessId,
      correlationId,
      requestIp: '203.0.113.4',
      requestUserAgent: 'Mozilla/5.0',
    });
    expect(event!.detail).toEqual({ before: { role: 'viewer' }, after: { role: 'manager' } });
  });

  it('sanitizes the detail on the way in, permanently', async () => {
    // The row cannot be edited afterwards, so a secret that reaches it stays.
    const businessId = await createBusiness();

    await recordAuditEvent(harness.db, {
      action: 'auth.login.succeeded',
      result: 'success',
      actor: system,
      businessId,
      detail: { method: 'email_code', emailCode: '00481502' },
    });

    const [event] = await readBusinessAuditEvents(harness.db, businessId);

    expect(event!.detail).toEqual({ method: 'email_code', emailCode: '[redacted]' });
  });

  it('derives a severity from the outcome when none is given', async () => {
    const businessId = await createBusiness();

    await recordAuditEvent(harness.db, {
      action: 'authz.denied',
      result: 'denied',
      actor: system,
      businessId,
    });
    await recordAuditEvent(harness.db, {
      action: 'auth.login.failed',
      result: 'failure',
      actor: system,
      businessId,
    });

    const events = await readBusinessAuditEvents(harness.db, businessId);
    const severities = Object.fromEntries(events.map((row) => [row.action, row.severity]));

    expect(severities).toEqual({ 'authz.denied': 'notice', 'auth.login.failed': 'warning' });
  });

  it('refuses a user action with no actor before it reaches the database', async () => {
    // The constraint would also catch this, but inside somebody else's
    // transaction it would take their work down with it.
    await expect(
      recordAuditEvent(harness.db, {
        action: 'member.removed',
        result: 'success',
        actor: { userId: null, kind: 'user' },
      }),
    ).rejects.toBeInstanceOf(AuditError);
  });
});

describe('audit inside a transaction', () => {
  it('is rolled back with the change it describes', async () => {
    const businessId = await createBusiness();

    await expect(
      harness.db.transaction(async (tx) => {
        await recordAuditEvent(tx, {
          action: 'business.settings_changed',
          result: 'success',
          actor: system,
          businessId,
        });

        throw new Error('the action failed after the audit write');
      }),
    ).rejects.toThrow(/the action failed/);

    // Evidence of something that never happened is worse than no evidence.
    expect(await readBusinessAuditEvents(harness.db, businessId)).toHaveLength(0);
  });

  it('commits with the change it describes', async () => {
    const businessId = await createBusiness();

    await harness.db.transaction(async (tx) => {
      await tx
        .update(businesses)
        .set({ timezone: 'Europe/London' })
        .where(eq(businesses.id, businessId));

      await recordAuditEvent(tx, {
        action: 'business.settings_changed',
        result: 'success',
        actor: system,
        businessId,
        detail: { before: { timezone: 'UTC' }, after: { timezone: 'Europe/London' } },
      });
    });

    expect(await readBusinessAuditEvents(harness.db, businessId)).toHaveLength(1);
  });
});

describe('reading the trail', () => {
  it('never returns another business history', async () => {
    const businessA = await createBusiness();
    const businessB = await createBusiness();

    await recordAuditEvent(harness.db, {
      action: 'business.created',
      result: 'success',
      actor: system,
      businessId: businessA,
    });

    expect(await readBusinessAuditEvents(harness.db, businessB)).toHaveLength(0);
  });

  it('never returns a business event on the installation surface', async () => {
    // An administrator holding view_installation_audit must not be handed every
    // tenant's history as a side effect of holding a different permission.
    const businessId = await createBusiness();

    await recordAuditEvent(harness.db, {
      action: 'business.created',
      result: 'success',
      actor: system,
      businessId,
    });

    const installation = await readInstallationAuditEvents(harness.db);

    expect(installation.every((row) => row.businessId === null)).toBe(true);
  });

  it('returns newest first and honours the cursor', async () => {
    const businessId = await createBusiness();

    for (const action of ['business.created', 'business.settings_changed'] as const) {
      await recordAuditEvent(harness.db, {
        action,
        result: 'success',
        actor: system,
        businessId,
      });
    }

    const all = await readBusinessAuditEvents(harness.db, businessId);
    expect(all).toHaveLength(2);
    expect(all[0]!.occurredAt.getTime()).toBeGreaterThanOrEqual(all[1]!.occurredAt.getTime());

    const older = await readBusinessAuditEvents(harness.db, businessId, {
      before: all[0]!.occurredAt,
    });
    expect(older.map((row) => row.id)).not.toContain(all[0]!.id);
  });

  it('filters by action and by correlation', async () => {
    const businessId = await createBusiness();
    const correlationId = crypto.randomUUID();

    await recordAuditEvent(harness.db, {
      action: 'member.invited',
      result: 'success',
      actor: system,
      businessId,
      correlationId,
    });
    await recordAuditEvent(harness.db, {
      action: 'member.removed',
      result: 'success',
      actor: system,
      businessId,
    });

    expect(
      await readBusinessAuditEvents(harness.db, businessId, { actions: ['member.invited'] }),
    ).toHaveLength(1);

    expect(await readBusinessAuditEvents(harness.db, businessId, { correlationId })).toHaveLength(
      1,
    );
  });

  it('caps the page size however large a limit is asked for', async () => {
    const businessId = await createBusiness();

    for (let index = 0; index < 5; index += 1) {
      await recordAuditEvent(harness.db, {
        action: 'business.settings_changed',
        result: 'success',
        actor: system,
        businessId,
      });
    }

    const page = await readBusinessAuditEvents(harness.db, businessId, { limit: 10_000 });

    expect(page.length).toBeLessThanOrEqual(200);
  });
});

describe('the trail cannot be rewritten', () => {
  it('refuses an update through the ordinary query surface', async () => {
    const businessId = await createBusiness();

    await recordAuditEvent(harness.db, {
      action: 'business.created',
      result: 'success',
      actor: system,
      businessId,
    });

    const [event] = await readBusinessAuditEvents(harness.db, businessId);

    await expect(
      harness.db
        .update(auditEvents)
        .set({ result: 'failure' })
        .where(eq(auditEvents.id, event!.id)),
    ).rejects.toThrow();
  });
});
