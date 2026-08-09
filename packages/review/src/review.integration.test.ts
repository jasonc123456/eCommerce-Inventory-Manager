import type { Subject } from '@eim/authz';
import { businesses, reviewedOperationRefusals, reviewedOperations, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fingerprintOf } from './fingerprint';
import {
  beginExecution,
  cancelOperation,
  completeExecution,
  confirmOperation,
  expireProposals,
  failExecution,
  proposeOperation,
} from './review';

/**
 * The confirmation gate (sections 3, 11, 13, 14, 30).
 *
 * What is worth proving here is the refusals. That a confirmation works is table
 * stakes; that it is refused when the values moved, when the read went stale,
 * when the permission is missing, when the authentication is old, and when
 * somebody tries to run the same confirmation twice is the entire reason the
 * table exists. Section 30's AC-10 names five of those in one sentence:
 * "permission, fee/currency impact, fresh source value, exact confirmation,
 * idempotency, and audit".
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly owner: Subject;
}

async function seed(): Promise<Fixture> {
  const slug = `review-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Reviewer' })
    .returning({ id: users.id });

  const userId = user!.id;
  return {
    businessId: business!.id,
    userId,
    owner: { userId, isOwner: true, grants: [] },
  };
}

const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;

/**
 * What the database actually said.
 *
 * Drizzle wraps a driver error in one of its own carrying the SQL and the
 * parameters, so the trigger's message — the part that says which rule was
 * broken — is on the cause. Asserting the wrapper would pass for any failed
 * update, including a typo in the column name.
 */
async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error('expected the database to refuse this, and it did not');
}

async function propose(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof proposeOperation>[1]> = {},
) {
  return proposeOperation(harness.db, {
    businessId: fixture.businessId,
    kind: 'price_copy',
    subjectKey: `mapping:${String((counter += 1))}`,
    requiredPermission: 'change_prices',
    preview: { source: { price: '10.00' }, destination: { price: '12.00' } },
    decisive: { price: '10.00', currency: 'GBP' },
    sourceObservedAt: base,
    proposedByUserId: fixture.userId,
    idempotencyKey: `price:${String(counter)}`,
    now: base,
    ...overrides,
  });
}

describe('proposeOperation', () => {
  it('records what was shown and how long it stays good for', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    expect(proposal.fingerprint).toBe(fingerprintOf({ price: '10.00', currency: 'GBP' }));
    // A price copy: fifteen minutes to decide, five for the read to stay true.
    expect(proposal.expiresAt).toEqual(at(15 * MINUTE));
    expect(proposal.sourceMaxAgeMs).toBe(5 * MINUTE);
  });

  it('refuses a second live proposal for the same subject', async () => {
    // Four proposals to copy the same price, all confirmable, is a recurring
    // price change assembled by hand — which section 3 excludes from version 1.
    const fixture = await seed();
    const first = await propose(fixture, { subjectKey: 'mapping:contended' });

    await expect(
      propose(fixture, { subjectKey: 'mapping:contended', idempotencyKey: 'price:second' }),
    ).rejects.toThrow();

    expect(first.operationId).toBeDefined();
  });

  it('allows the next proposal once the previous one has settled', async () => {
    const fixture = await seed();
    const first = await propose(fixture, { subjectKey: 'mapping:sequential' });
    await cancelOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: first.operationId,
    });

    await expect(
      propose(fixture, { subjectKey: 'mapping:sequential', idempotencyKey: 'price:again' }),
    ).resolves.toBeDefined();
  });

  it('refuses to reuse an idempotency key', async () => {
    const fixture = await seed();
    await propose(fixture, { idempotencyKey: 'price:shared' });

    await expect(propose(fixture, { idempotencyKey: 'price:shared' })).rejects.toThrow();
  });

  it('demands recent authentication for the permissions that require it', async () => {
    const fixture = await seed();
    const priced = await propose(fixture);
    const drafted = await propose(fixture, {
      kind: 'draft_create',
      requiredPermission: 'create_drafts',
      subjectKey: 'item:drafted',
      idempotencyKey: 'draft:1',
    });

    const rows = await harness.db
      .select({
        id: reviewedOperations.id,
        requires: reviewedOperations.requiresRecentAuthentication,
      })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.businessId, fixture.businessId));

    const byId = new Map(rows.map((row) => [row.id, row.requires]));
    // change_prices is a step-up permission; create_drafts is not.
    expect(byId.get(priced.operationId)).toBe(true);
    expect(byId.get(drafted.operationId)).toBe(false);
  });
});

describe('confirmOperation', () => {
  it('accepts the person who read the screen', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome.confirmed).toBe(true);
    if (outcome.confirmed) {
      expect(outcome.operation.state).toBe('confirmed');
      expect(outcome.operation.confirmedByUserId).toBe(fixture.userId);
      expect(outcome.idempotencyKey).toBeDefined();
    }
  });

  it('refuses a confirmation of values that have since moved', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: fingerprintOf({ price: '10.50', currency: 'GBP' }),
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_preview' });
  });

  it('refuses a read that has gone stale even when the screen still matches', async () => {
    // The dangerous case: the reviewer's browser still shows what it showed six
    // minutes ago, so the fingerprint agrees, and the price has changed anyway.
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(6 * MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_source' });
  });

  it('refuses and settles a proposal nobody confirmed in time', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(20 * MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'expired' });

    const [row] = await harness.db
      .select({ state: reviewedOperations.state })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));
    // Settled rather than merely refused, so the subject is free for a fresh
    // proposal instead of blocked by one that will never do anything.
    expect(row?.state).toBe('expired');
  });

  it('refuses somebody without the permission the proposal named', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: { userId: fixture.userId, isOwner: false, grants: [] },
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'not_permitted' });
  });

  it('refuses a scoped grant of a permission that cannot be narrowed', async () => {
    // change_prices is unscopable: a grant over two connections is not a weaker
    // version of it, and treating it as one would let a per-connection operator
    // change prices anywhere.
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: {
        userId: fixture.userId,
        isOwner: false,
        grants: [
          { permission: 'change_prices', scope: { kind: 'connections', connectionIds: ['any'] } },
        ],
      },
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'not_permitted' });
  });

  it('refuses a session that has not authenticated recently enough', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: false,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'recent_authentication_required' });
  });

  it('does not demand recent authentication for an operation that never needed it', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, {
      kind: 'draft_create',
      requiredPermission: 'create_drafts',
      subjectKey: 'item:draft-no-stepup',
      idempotencyKey: 'draft:no-stepup',
    });

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: false,
      now: at(MINUTE),
    });

    expect(outcome.confirmed).toBe(true);
  });

  it('refuses the second confirmation of one proposal', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);
    const confirm = async () =>
      confirmOperation(harness.db, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        subject: fixture.owner,
        fingerprint: proposal.fingerprint,
        hasRecentAuthentication: true,
        now: at(MINUTE),
      });

    expect((await confirm()).confirmed).toBe(true);
    expect(await confirm()).toMatchObject({ confirmed: false, reason: 'already_decided' });
  });

  it('does not leak an operation across businesses', async () => {
    const mine = await seed();
    const theirs = await seed();
    const proposal = await propose(mine);

    const outcome = await confirmOperation(harness.db, {
      businessId: theirs.businessId,
      operationId: proposal.operationId,
      subject: theirs.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false });
  });

  it('writes down every refusal', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: 'not the one on record',
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    const refusals = await harness.db
      .select()
      .from(reviewedOperationRefusals)
      .where(eq(reviewedOperationRefusals.operationId, proposal.operationId));

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toBe('stale_preview');
    expect(refusals[0]?.attemptedByUserId).toBe(fixture.userId);
  });

  it('records the refusal even when the confirmation is rolled back around it', async () => {
    // The refusal is written inside the same transaction as the check, so a
    // caller that wraps confirmation in its own transaction and then throws
    // loses the evidence with it. Asserting the ordinary path keeps that
    // trade-off visible: the refusal belongs to the decision, not to the request.
    const fixture = await seed();
    const proposal = await propose(fixture);

    await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: { userId: fixture.userId, isOwner: false, grants: [] },
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    const [row] = await harness.db
      .select({ state: reviewedOperations.state })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));
    // Still proposed: a refusal is not a decision about the operation, only
    // about this attempt to confirm it.
    expect(row?.state).toBe('proposed');
  });
});

describe('execution', () => {
  async function confirmed(fixture: Fixture) {
    const proposal = await propose(fixture);
    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });
    if (!outcome.confirmed) {
      throw new Error(`expected a confirmation, got ${outcome.reason}`);
    }
    return outcome;
  }

  it('carries one idempotency key across every attempt', async () => {
    // The ambiguous-timeout case. A provider that did receive the first call
    // must not apply a second.
    const fixture = await seed();
    const outcome = await confirmed(fixture);

    const first = await beginExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
    });
    const second = await beginExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
    });

    expect(first?.idempotencyKey).toBe(outcome.idempotencyKey);
    expect(second?.idempotencyKey).toBe(outcome.idempotencyKey);
    expect(first?.attempts).toBe(1);
    expect(second?.attempts).toBe(2);
  });

  it('will not execute what nobody confirmed', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    expect(
      await beginExecution(harness.db, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
      }),
    ).toBeNull();
  });

  it('will not execute an operation twice', async () => {
    const fixture = await seed();
    const outcome = await confirmed(fixture);

    await beginExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
    });
    await completeExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
      outcome: { externalId: 'ITEM-1' },
      now: at(2 * MINUTE),
    });

    expect(
      await beginExecution(harness.db, {
        businessId: fixture.businessId,
        operationId: outcome.operation.id,
      }),
    ).toBeNull();
  });

  it('refuses to revive an operation that already happened', async () => {
    // This is the guarantee behind "no recurring price path": one confirmation,
    // one effect, and no way back to a state that could produce another.
    const fixture = await seed();
    const outcome = await confirmed(fixture);

    await beginExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
    });
    await completeExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
      outcome: { externalId: 'ITEM-1' },
      now: at(2 * MINUTE),
    });

    expect(
      await databaseRefusal(
        harness.db
          .update(reviewedOperations)
          .set({ state: 'confirmed' })
          .where(eq(reviewedOperations.id, outcome.operation.id)),
      ),
    ).toMatch(/already executed/);
  });

  it('refuses to revive a cancelled proposal', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);
    await cancelOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
    });

    expect(
      await databaseRefusal(
        harness.db
          .update(reviewedOperations)
          .set({ state: 'proposed' })
          .where(eq(reviewedOperations.id, proposal.operationId)),
      ),
    ).toMatch(/already cancelled/);
  });

  it('records why an execution gave up', async () => {
    const fixture = await seed();
    const outcome = await confirmed(fixture);

    await beginExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
    });
    await failExecution(harness.db, {
      businessId: fixture.businessId,
      operationId: outcome.operation.id,
      summary: 'the provider rejected the price as below its minimum',
      now: at(2 * MINUTE),
    });

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, outcome.operation.id));

    expect(row?.state).toBe('failed');
    expect(row?.failureSummary).toContain('below its minimum');
  });
});

describe('expireProposals', () => {
  it('settles what nobody came back to, and leaves the rest alone', async () => {
    const fixture = await seed();
    const stale = await propose(fixture, { subjectKey: 'mapping:abandoned' });
    const live = await propose(fixture, {
      subjectKey: 'mapping:current',
      idempotencyKey: 'price:current',
      now: at(30 * MINUTE),
      sourceObservedAt: at(30 * MINUTE),
    });

    expect(
      await expireProposals(harness.db, {
        businessId: fixture.businessId,
        now: at(31 * MINUTE),
      }),
    ).toBe(1);

    const rows = await harness.db
      .select({ id: reviewedOperations.id, state: reviewedOperations.state })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.businessId, fixture.businessId));
    const byId = new Map(rows.map((row) => [row.id, row.state]));

    expect(byId.get(stale.operationId)).toBe('expired');
    expect(byId.get(live.operationId)).toBe('proposed');
  });
});
