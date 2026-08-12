import { businesses, operatorAlerts } from '@eim/db';
import { openAlerts } from '@eim/notifications';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { alertMappingBlocked, alertOversold } from './alerts';

/**
 * The synchronization core's alerts (sections 11, 12, 22).
 *
 * The lifecycle is proven in `@eim/notifications`. What is worth proving here
 * is the only decision these functions make: what each kind of problem
 * deduplicates on. Getting that wrong is not a cosmetic error — an oversell
 * keyed by the order rather than by the item produces one alert per
 * disappointed customer, and the eleventh is the one nobody reads.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<string> {
  const slug = `sync-alert-${String((counter += 1))}`;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  return business!.id;
}

describe('alertOversold', () => {
  it('is one shortage to resolve, not one alert per disappointed customer', async () => {
    const businessId = await seed();
    const canonicalItemId = '11111111-1111-1111-1111-111111111111';

    for (const externalOrderId of ['order-1', 'order-2', 'order-3']) {
      await alertOversold(harness.db, {
        businessId,
        canonicalItemId,
        externalOrderId,
        shortage: 1,
      });
    }

    const open = await openAlerts(harness.db, businessId);
    expect(open).toHaveLength(1);
    expect(open[0]?.severity).toBe('critical');
    expect(open[0]?.occurrences).toBe(3);
    expect(open[0]?.canonicalItemId).toBe(canonicalItemId);
    expect(open[0]?.recommendedAction).not.toBeNull();
  });
});

describe('alertMappingBlocked', () => {
  it('is one thing to fix however long it has been failing', async () => {
    const businessId = await seed();
    const mappingId = '22222222-2222-2222-2222-222222222222';

    for (const reason of ['rate limited', 'rate limited', 'the credentials were rejected']) {
      await alertMappingBlocked(harness.db, { businessId, mappingId, reason });
    }

    const open = await openAlerts(harness.db, businessId);
    expect(open).toHaveLength(1);
    expect(open[0]?.summary).toContain('the credentials were rejected');
    expect(open[0]?.mappingId).toBe(mappingId);
  });
});

describe('severity ordering', () => {
  it('puts the worst first, which sorting by the severity name would not', async () => {
    // 'critical' < 'error' < 'info' < 'warning' alphabetically, so a list
    // ordered by name would bury the oversell in the middle.
    const businessId = await seed();

    await alertMappingBlocked(harness.db, {
      businessId,
      mappingId: '33333333-3333-3333-3333-333333333333',
      reason: 'rejected',
    });
    await harness.db.insert(operatorAlerts).values({
      businessId,
      kind: 'restock_pending',
      severity: 'warning',
      subjectKey: 'item:waiting',
      summary: 'waiting to go back on sale',
    });

    const open = await openAlerts(harness.db, businessId);
    expect(open.map((alert) => alert.severity)).toEqual(['critical', 'warning']);
  });
});
