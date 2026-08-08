import { businesses, connections, providerItems, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  postMovements,
  proposeMapping,
} from '@eim/inventory';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CHANNEL_WRITE_JOB,
  beginWriteAttempt,
  readTarget,
  recordDesiredTarget,
  recordObservation,
  refreshTargetsForItem,
  settleWriteAttempt,
} from './targets';

/**
 * Versioned desired targets (sections 8, 12, 15).
 *
 * Section 12's rule — "older targets can never overwrite newer committed
 * targets" — is the thing being proven, and it is only meaningful against a
 * database that will actually refuse. The check constraint is the backstop
 * behind the version comparison, and a fake would have neither.
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
  readonly connectionId: string;
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly mappingId: string;
  readonly userId: string;
}

async function seed(quantityOnHand = 10): Promise<Fixture> {
  const slug = `tgt-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `acct-${slug}`,
      displayName: 'Test seller',
      status: 'active',
    })
    .returning({ id: connections.id });

  const connectionId = connection!.id;

  const location = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const locationId = location.outcome === 'created' ? location.locationId : '';

  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });
  const canonicalItemId = item.outcome === 'created' ? item.canonicalItemId : '';

  const [providerItem] = await harness.db
    .insert(providerItems)
    .values({
      businessId,
      connectionId,
      externalId: `listing-${slug}`,
      title: 'Widget',
      kind: 'listing',
      inventoryEligible: true,
      quantity: 0,
    })
    .returning({ id: providerItems.id });

  const proposed = await proposeMapping(harness.db, {
    businessId,
    connectionId,
    canonicalItemId,
    providerItemId: providerItem!.id,
    locationIds: [locationId],
    createdByUserId: userId,
  });

  const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';
  await approveMapping(harness.db, { businessId, mappingId, approvedByUserId: userId });
  await activateMapping(harness.db, { businessId, mappingId, actorUserId: userId });

  if (quantityOnHand > 0) {
    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId,
        actorUserId: userId,
        movements: [
          { canonicalItemId, locationId, kind: 'receipt', quantityDelta: quantityOnHand },
        ],
      });
    });
  }

  return { businessId, connectionId, canonicalItemId, locationId, mappingId, userId };
}

describe('recordDesiredTarget', () => {
  it('starts at version one and advances only on a real change', async () => {
    const fixture = await seed(0);
    const base = {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      reason: 'test',
    };

    const first = await recordDesiredTarget(harness.db, { ...base, quantity: 7 });
    const again = await recordDesiredTarget(harness.db, { ...base, quantity: 7 });
    const moved = await recordDesiredTarget(harness.db, { ...base, quantity: 3 });

    expect(first.targetVersion).toBe(1);
    // Re-recording the same quantity must not advance the version: a
    // reconciliation pass that bumped it every thirty minutes would invalidate
    // the write already in flight and the mapping would never converge.
    expect(again.targetVersion).toBe(1);
    expect(moved.targetVersion).toBe(2);
  });

  it('still asks for a write when the quantity is unchanged but never landed', async () => {
    const fixture = await seed(0);
    const base = {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      reason: 'test',
    };

    await recordDesiredTarget(harness.db, { ...base, quantity: 4 });
    const again = await recordDesiredTarget(harness.db, { ...base, quantity: 4 });

    expect(again.changed).toBe(true);
  });

  it('stops asking once the quantity has been written', async () => {
    // Section 15: "suppress unchanged writes". Decided here rather than in the
    // worker, which would have to make a provider call to discover it.
    const fixture = await seed(0);
    const base = {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      reason: 'test',
    };

    const target = await recordDesiredTarget(harness.db, { ...base, quantity: 4 });
    const attempt = await beginWriteAttempt(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      jobId: await someJobId(fixture.businessId),
      targetVersion: target.targetVersion,
      quantity: 4,
    });
    await settleWriteAttempt(harness.db, {
      attemptId: attempt.attemptId,
      mappingId: fixture.mappingId,
      targetVersion: target.targetVersion,
      quantity: 4,
      settlement: { outcome: 'acknowledged' },
    });

    const again = await recordDesiredTarget(harness.db, { ...base, quantity: 4 });

    expect(again.changed).toBe(false);
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('converged');
  });

  it('refuses to store a written version ahead of the desired one', async () => {
    // The backstop behind the version comparison. If a late acknowledgement for
    // a version that no longer exists could land, a mapping would read as
    // converged while advertising a quantity nobody asked for.
    const fixture = await seed(0);
    await recordDesiredTarget(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      quantity: 1,
      reason: 'test',
    });

    await expect(
      harness.db.execute(
        sql`update channel_targets set written_version = 99 where mapping_id = ${fixture.mappingId}::uuid`,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      whyItFailed(error).includes('channel_targets_written_not_ahead'),
    );
  });
});

describe('settleWriteAttempt', () => {
  it('leaves a mapping pending when the ledger moved while the write was in flight', async () => {
    const fixture = await seed(0);
    const base = {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      reason: 'test',
    };

    const first = await recordDesiredTarget(harness.db, { ...base, quantity: 5 });
    const attempt = await beginWriteAttempt(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      jobId: await someJobId(fixture.businessId),
      targetVersion: first.targetVersion,
      quantity: 5,
    });

    // A sale lands while the provider call is out.
    await recordDesiredTarget(harness.db, { ...base, quantity: 4 });

    await settleWriteAttempt(harness.db, {
      attemptId: attempt.attemptId,
      mappingId: fixture.mappingId,
      targetVersion: first.targetVersion,
      quantity: 5,
      settlement: { outcome: 'acknowledged' },
    });

    const target = await readTarget(harness.db, fixture.mappingId);

    // The write succeeded for the version it carried, and the mapping is still
    // behind. Reporting "converged" here is how a stale quantity survives.
    expect(target?.state).toBe('pending');
    expect(target?.writtenQuantity).toBe(5);
    expect(target?.desiredQuantity).toBe(4);
  });

  it('marks a failed write degraded and counts it', async () => {
    const fixture = await seed(0);
    const target = await recordDesiredTarget(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      quantity: 2,
      reason: 'test',
    });
    const attempt = await beginWriteAttempt(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      jobId: await someJobId(fixture.businessId),
      targetVersion: target.targetVersion,
      quantity: 2,
    });

    await settleWriteAttempt(harness.db, {
      attemptId: attempt.attemptId,
      mappingId: fixture.mappingId,
      targetVersion: target.targetVersion,
      quantity: 2,
      settlement: { outcome: 'failed', failureKind: 'unavailable', detail: 'store did not answer' },
    });

    const row = await readTarget(harness.db, fixture.mappingId);

    expect(row?.state).toBe('degraded');
    expect(row?.consecutiveFailures).toBe(1);
    expect(row?.writtenVersion).toBeNull();
  });

  it('sends the same idempotency key for a retry of the same version', async () => {
    // Section 12: a retry after an ambiguous timeout must not apply the same
    // change twice, and the provider can only honour that if the key repeats.
    const fixture = await seed(0);
    const target = await recordDesiredTarget(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      quantity: 2,
      reason: 'test',
    });

    const jobId = await someJobId(fixture.businessId);
    const open = {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      jobId,
      targetVersion: target.targetVersion,
      quantity: 2,
    };

    const first = await beginWriteAttempt(harness.db, open);
    const retry = await beginWriteAttempt(harness.db, open);

    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.attemptId).toBe(first.attemptId);
  });
});

describe('recordObservation', () => {
  it('records what the provider said without adopting it', async () => {
    const fixture = await seed(0);
    const target = await recordDesiredTarget(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      mappingId: fixture.mappingId,
      quantity: 6,
      reason: 'test',
    });

    await recordObservation(harness.db, {
      mappingId: fixture.mappingId,
      quantity: 99,
      version: 'etag-1',
      backordersEnabled: false,
    });

    const row = await readTarget(harness.db, fixture.mappingId);

    expect(row?.observedQuantity).toBe(99);
    // The disagreement is the point. Section 15 makes channel state evidence,
    // not truth, and adopting it here would let an unexplained external edit
    // rewrite canonical inventory with nobody deciding to.
    expect(row?.desiredQuantity).toBe(6);
    expect(row?.targetVersion).toBe(target.targetVersion);
  });
});

describe('refreshTargetsForItem', () => {
  it('computes a target from the ledger and queues the write', async () => {
    const fixture = await seed(10);

    const results = await refreshTargetsForItem(harness.db, {
      businessId: fixture.businessId,
      canonicalItemId: fixture.canonicalItemId,
      reason: 'receipt',
    });

    expect(results).toHaveLength(1);
    // Nine, not ten: section 8's business default withholds one unit, and the
    // target is what the channel may sell rather than what the shelf holds.
    expect(results[0]?.quantity).toBe(9);

    const jobs = await harness.db.execute<{ kind: string; payload: Record<string, unknown> }>(sql`
      select kind, payload from background_jobs
       where business_id = ${fixture.businessId}::uuid and kind = ${CHANNEL_WRITE_JOB}
    `);

    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload['mappingId']).toBe(fixture.mappingId);
  });

  it('queues nothing the second time when nothing moved', async () => {
    const fixture = await seed(10);

    await refreshTargetsForItem(harness.db, {
      businessId: fixture.businessId,
      canonicalItemId: fixture.canonicalItemId,
      reason: 'receipt',
    });

    const target = await readTarget(harness.db, fixture.mappingId);
    const attempt = await beginWriteAttempt(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      jobId: await someJobId(fixture.businessId),
      targetVersion: target!.targetVersion,
      quantity: target!.desiredQuantity,
    });
    await settleWriteAttempt(harness.db, {
      attemptId: attempt.attemptId,
      mappingId: fixture.mappingId,
      targetVersion: target!.targetVersion,
      quantity: target!.desiredQuantity,
      settlement: { outcome: 'acknowledged' },
    });

    const second = await refreshTargetsForItem(harness.db, {
      businessId: fixture.businessId,
      canonicalItemId: fixture.canonicalItemId,
      reason: 'reconciliation',
    });

    expect(second[0]?.changed).toBe(false);

    const jobs = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from background_jobs
       where business_id = ${fixture.businessId}::uuid and kind = ${CHANNEL_WRITE_JOB}
    `);

    expect(jobs.rows[0]?.count).toBe('1');
  });

  it('takes the targets with it when the ledger transaction rolls back', async () => {
    // The reason the queue and the targets live in the same database. A target
    // that survived a rolled-back sale would tell a channel about stock that
    // never moved.
    const fixture = await seed(10);

    await expect(
      harness.db.transaction(async (tx) => {
        await refreshTargetsForItem(tx, {
          businessId: fixture.businessId,
          canonicalItemId: fixture.canonicalItemId,
          reason: 'sale',
        });
        throw new Error('the sale was not valid after all');
      }),
    ).rejects.toThrow('not valid after all');

    expect(await readTarget(harness.db, fixture.mappingId)).toBeNull();
  });
});

/** A job row to hang a write attempt on, since the column references one. */
async function someJobId(businessId: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    insert into background_jobs (business_id, kind, expires_at)
    values (${businessId}::uuid, 'test.anchor', now() + interval '1 hour')
    returning id
  `);

  return rows.rows[0]!.id;
}

function whyItFailed(error: unknown): string {
  const parts: string[] = [];

  for (let current: unknown = error; current !== undefined && current !== null;) {
    if (!(current instanceof Error)) {
      break;
    }

    parts.push(current.message);
    if ('constraint' in current && typeof current.constraint === 'string') {
      parts.push(current.constraint);
    }
    current = current.cause;
  }

  return parts.join(' | ');
}
