import { businesses, inventoryLedger, locationBalances, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAdjustment, previewAdjustment, reverseEntry, transferStock } from './adjustments';
import { createCanonicalItem } from './items';
import { lockOrder, postMovements, readTimeline } from './ledger';
import { createLocation } from './locations';

/**
 * The append-only ledger and the balances it explains (sections 8, 12, 17).
 *
 * These need a real PostgreSQL rather than a fake: what is being tested is that
 * the database refuses negative stock, refuses an edited history, and serializes
 * two transactions racing for the last unit. A fake that agreed with all three
 * would prove only that it had been written to agree.
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
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly otherLocationId: string;
  readonly userId: string;
}

async function seed(): Promise<Fixture> {
  const slug = `led-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const main = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const spare = await createLocation(harness.db, { businessId, code: 'SPARE', name: 'Spare' });
  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });

  return {
    businessId,
    userId: user!.id,
    locationId: main.outcome === 'created' ? main.locationId : '',
    otherLocationId: spare.outcome === 'created' ? spare.locationId : '',
    canonicalItemId: item.outcome === 'created' ? item.canonicalItemId : '',
  };
}

async function stock(ref: Fixture, quantity: number, locationId = ref.locationId): Promise<void> {
  await harness.db.transaction(async (tx) => {
    await postMovements(tx, {
      businessId: ref.businessId,
      movements: [
        {
          canonicalItemId: ref.canonicalItemId,
          locationId,
          kind: 'receipt',
          quantityDelta: quantity,
        },
      ],
    });
  });
}

async function onHandAt(ref: Fixture, locationId: string): Promise<number | undefined> {
  const [row] = await harness.db
    .select({ onHand: locationBalances.onHand })
    .from(locationBalances)
    .where(
      and(
        eq(locationBalances.businessId, ref.businessId),
        eq(locationBalances.canonicalItemId, ref.canonicalItemId),
        eq(locationBalances.locationId, locationId),
      ),
    );

  return row?.onHand;
}

describe('posting movements', () => {
  it('creates the balance row on the first receipt', async () => {
    const ref = await seed();

    await stock(ref, 7);

    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(7);
  });

  it('refuses the whole set when one movement cannot be supplied', async () => {
    // Section 10: partial component mutation is prohibited. The same argument
    // applies to a transfer, where a decrement without its increment destroys
    // stock.
    const ref = await seed();

    await stock(ref, 3);
    await stock(ref, 10, ref.otherLocationId);

    const result = await harness.db.transaction(async (tx) =>
      postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.otherLocationId,
            kind: 'shipment',
            quantityDelta: -1,
          },
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'shipment',
            quantityDelta: -5,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'insufficient',
      shortfalls: [{ locationId: ref.locationId, onHand: 3, requested: 5, short: 2 }],
    });

    // The movement that could have been supplied was not.
    await expect(onHandAt(ref, ref.otherLocationId)).resolves.toBe(10);
  });

  it('nets repeated movements at one location before checking', async () => {
    // A kit sale can name the same component twice. Rejecting on the first leg
    // while the pair is affordable would refuse an order that is fine.
    const ref = await seed();

    await stock(ref, 4);

    const result = await harness.db.transaction(async (tx) =>
      postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'shipment',
            quantityDelta: -4,
          },
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'receipt',
            quantityDelta: 2,
          },
        ],
      }),
    );

    expect(result.outcome).toBe('posted');
    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(2);
  });

  it('rejects a zero-quantity movement', async () => {
    const ref = await seed();

    const result = await harness.db.transaction(async (tx) =>
      postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'adjustment',
            quantityDelta: 0,
          },
        ],
      }),
    );

    expect(result).toMatchObject({ outcome: 'invalid' });
  });

  it('will not leave fewer units on hand than are reserved', async () => {
    const ref = await seed();

    await stock(ref, 5);
    await harness.db
      .update(locationBalances)
      .set({ reserved: 4 })
      .where(eq(locationBalances.canonicalItemId, ref.canonicalItemId));

    const result = await harness.db.transaction(async (tx) =>
      postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'shipment',
            quantityDelta: -3,
          },
        ],
      }),
    );

    expect(result).toMatchObject({ outcome: 'invalid' });
  });
});

describe('the append-only guarantee', () => {
  /**
   * The query builder wraps the driver's error, so the trigger's own words are
   * in the cause rather than the message. Asserting on the wrapper would pass
   * for any failure at all, including a typo in the column name.
   */
  function whyItFailed(error: unknown): string {
    const messages: string[] = [];

    for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
      messages.push(current.message);
      current = current.cause;
    }

    return messages.join(' | ');
  }

  it('refuses an update to a committed entry', async () => {
    // Section 17. The trigger is what makes this true of every code path, not
    // only of the ones that remembered.
    const ref = await seed();

    await stock(ref, 2);

    const failure = await harness.db
      .update(inventoryLedger)
      .set({ quantityDelta: 99 })
      .where(eq(inventoryLedger.canonicalItemId, ref.canonicalItemId))
      .catch((error: unknown) => error);

    expect(whyItFailed(failure)).toMatch(/append-only/);
  });

  it('refuses a delete', async () => {
    const ref = await seed();

    await stock(ref, 2);

    const failure = await harness.db
      .delete(inventoryLedger)
      .where(eq(inventoryLedger.canonicalItemId, ref.canonicalItemId))
      .catch((error: unknown) => error);

    expect(whyItFailed(failure)).toMatch(/append-only/);
  });
});

describe('previewing an adjustment', () => {
  it('turns an absolute figure into the change it implies', async () => {
    const ref = await seed();

    await stock(ref, 10);

    const preview = await previewAdjustment(harness.db, {
      ...ref,
      change: { mode: 'absolute', quantity: 12 },
      reason: 'stock count',
    });

    expect(preview).toMatchObject({
      outcome: 'previewed',
      preview: { onHand: 10, quantityDelta: 2, resultingOnHand: 12, unchanged: false },
    });
  });

  it('reports a location the item has never been stocked at as empty', async () => {
    const ref = await seed();

    const preview = await previewAdjustment(harness.db, {
      ...ref,
      change: { mode: 'absolute', quantity: 3 },
      reason: 'first delivery',
    });

    expect(preview).toMatchObject({
      outcome: 'previewed',
      preview: { onHand: 0, quantityDelta: 3 },
    });
  });

  it('names the shortfall rather than a negative balance', async () => {
    const ref = await seed();

    await stock(ref, 1);

    const preview = await previewAdjustment(harness.db, {
      ...ref,
      change: { mode: 'delta', quantityDelta: -4 },
      reason: 'breakage',
    });

    expect(preview).toMatchObject({
      outcome: 'previewed',
      preview: { shortfall: 3, resultingOnHand: 0 },
    });
  });

  it('changes nothing', async () => {
    const ref = await seed();

    await stock(ref, 5);
    await previewAdjustment(harness.db, {
      ...ref,
      change: { mode: 'absolute', quantity: 0 },
      reason: 'preview only',
    });

    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(5);
  });
});

describe('applying an adjustment', () => {
  it('records the actor and the stated reason', async () => {
    const ref = await seed();

    await stock(ref, 4);
    const result = await applyAdjustment(harness.db, {
      ...ref,
      change: { mode: 'absolute', quantity: 6 },
      reason: 'recount after delivery',
      actorUserId: ref.userId,
    });

    expect(result).toMatchObject({ outcome: 'adjusted', onHand: 6 });

    const [latest] = await readTimeline(harness.db, ref);

    expect(latest).toMatchObject({
      kind: 'adjustment',
      quantityDelta: 2,
      reason: 'recount after delivery',
      actorUserId: ref.userId,
    });
  });

  it('refuses an adjustment with no stated reason', async () => {
    // Section 8 admits no adjustment without one: an unexplained correction is
    // indistinguishable from the drift it was correcting.
    const ref = await seed();

    await expect(
      applyAdjustment(harness.db, {
        ...ref,
        change: { mode: 'delta', quantityDelta: 1 },
        reason: '   ',
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('writes no entry when the figure is already right', async () => {
    const ref = await seed();

    await stock(ref, 3);
    const result = await applyAdjustment(harness.db, {
      ...ref,
      change: { mode: 'absolute', quantity: 3 },
      reason: 'counted, unchanged',
    });

    expect(result).toEqual({ outcome: 'unchanged', onHand: 3 });
    await expect(readTimeline(harness.db, ref)).resolves.toHaveLength(1);
  });

  it('refuses to take a location below zero', async () => {
    const ref = await seed();

    await stock(ref, 2);

    await expect(
      applyAdjustment(harness.db, {
        ...ref,
        change: { mode: 'delta', quantityDelta: -5 },
        reason: 'wrote off',
      }),
    ).resolves.toMatchObject({ outcome: 'insufficient', shortfalls: [{ short: 3 }] });
  });

  it('recomputes an absolute figure against the locked row, not the preview', async () => {
    // An operator counts twelve, a sale takes one while they are reading the
    // confirmation, and they confirm. The answer must be twelve, not thirteen.
    const ref = await seed();

    await stock(ref, 10);
    const preview = await previewAdjustment(harness.db, {
      ...ref,
      change: { mode: 'absolute', quantity: 12 },
      reason: 'stock count',
    });

    expect(preview).toMatchObject({ preview: { quantityDelta: 2 } });

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'shipment',
            quantityDelta: -1,
          },
        ],
      });
    });

    await expect(
      applyAdjustment(harness.db, {
        ...ref,
        change: { mode: 'absolute', quantity: 12 },
        reason: 'stock count',
      }),
    ).resolves.toMatchObject({ outcome: 'adjusted', onHand: 12 });
  });
});

describe('transfers', () => {
  it('moves units as one act', async () => {
    const ref = await seed();

    await stock(ref, 8);

    const result = await transferStock(harness.db, {
      businessId: ref.businessId,
      canonicalItemId: ref.canonicalItemId,
      fromLocationId: ref.locationId,
      toLocationId: ref.otherLocationId,
      quantity: 3,
      reason: 'rebalancing',
      actorUserId: ref.userId,
    });

    expect(result).toMatchObject({ outcome: 'transferred' });
    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(5);
    await expect(onHandAt(ref, ref.otherLocationId)).resolves.toBe(3);
  });

  it('ties both halves together so either end can find the other', async () => {
    const ref = await seed();

    await stock(ref, 4);
    await transferStock(harness.db, {
      businessId: ref.businessId,
      canonicalItemId: ref.canonicalItemId,
      fromLocationId: ref.locationId,
      toLocationId: ref.otherLocationId,
      quantity: 1,
    });

    const timeline = await readTimeline(harness.db, ref);
    const moves = timeline.filter((entry) => entry.kind.startsWith('transfer'));

    expect(moves).toHaveLength(2);
    expect(new Set(moves.map((entry) => entry.correlationId)).size).toBe(1);
  });

  it('moves nothing when the source cannot supply it', async () => {
    const ref = await seed();

    await stock(ref, 1);

    await expect(
      transferStock(harness.db, {
        businessId: ref.businessId,
        canonicalItemId: ref.canonicalItemId,
        fromLocationId: ref.locationId,
        toLocationId: ref.otherLocationId,
        quantity: 5,
      }),
    ).resolves.toMatchObject({ outcome: 'insufficient' });

    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(1);
    // Not even an empty balance row at the destination it never reached: a
    // refused transfer is discarded whole rather than tidied up after.
    await expect(onHandAt(ref, ref.otherLocationId)).resolves.toBeUndefined();
  });

  it('refuses a transfer to the same location', async () => {
    const ref = await seed();

    await expect(
      transferStock(harness.db, {
        businessId: ref.businessId,
        canonicalItemId: ref.canonicalItemId,
        fromLocationId: ref.locationId,
        toLocationId: ref.locationId,
        quantity: 1,
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

describe('reversing an entry', () => {
  it('appends the opposite and links it', async () => {
    const ref = await seed();

    await stock(ref, 5);
    const adjusted = await applyAdjustment(harness.db, {
      ...ref,
      change: { mode: 'delta', quantityDelta: 3 },
      reason: 'mistaken receipt',
      actorUserId: ref.userId,
    });
    const entryId = adjusted.outcome === 'adjusted' ? adjusted.entryId : '';

    const reversed = await reverseEntry(harness.db, {
      businessId: ref.businessId,
      entryId,
      reason: 'entered against the wrong item',
      actorUserId: ref.userId,
    });

    expect(reversed).toMatchObject({ outcome: 'reversed', onHand: 5 });

    const [latest] = await readTimeline(harness.db, ref);

    expect(latest).toMatchObject({ kind: 'reversal', quantityDelta: -3, reversalOfId: entryId });
  });

  it('refuses to reverse the same entry twice', async () => {
    const ref = await seed();

    await stock(ref, 5);
    const adjusted = await applyAdjustment(harness.db, {
      ...ref,
      change: { mode: 'delta', quantityDelta: 2 },
      reason: 'duplicate',
    });
    const entryId = adjusted.outcome === 'adjusted' ? adjusted.entryId : '';

    await reverseEntry(harness.db, { businessId: ref.businessId, entryId, reason: 'first' });

    await expect(
      reverseEntry(harness.db, { businessId: ref.businessId, entryId, reason: 'second' }),
    ).resolves.toMatchObject({ outcome: 'already_reversed' });
    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(5);
  });

  it('refuses to reverse a reversal', async () => {
    // Arithmetically fine, historically incomprehensible.
    const ref = await seed();

    await stock(ref, 5);
    const adjusted = await applyAdjustment(harness.db, {
      ...ref,
      change: { mode: 'delta', quantityDelta: 1 },
      reason: 'one too many',
    });
    const reversed = await reverseEntry(harness.db, {
      businessId: ref.businessId,
      entryId: adjusted.outcome === 'adjusted' ? adjusted.entryId : '',
      reason: 'undo',
    });

    await expect(
      reverseEntry(harness.db, {
        businessId: ref.businessId,
        entryId: reversed.outcome === 'reversed' ? reversed.entryId : '',
        reason: 'undo the undo',
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('refuses when the units are already gone', async () => {
    // Reversing a receipt whose units have since been sold would take the
    // location negative. Section 8 does not allow that, so the operator is told.
    const ref = await seed();

    const received = await applyAdjustment(harness.db, {
      ...ref,
      change: { mode: 'delta', quantityDelta: 4 },
      reason: 'delivery',
    });

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.canonicalItemId,
            locationId: ref.locationId,
            kind: 'shipment',
            quantityDelta: -4,
          },
        ],
      });
    });

    await expect(
      reverseEntry(harness.db, {
        businessId: ref.businessId,
        entryId: received.outcome === 'adjusted' ? received.entryId : '',
        reason: 'never actually arrived',
      }),
    ).resolves.toMatchObject({ outcome: 'insufficient' });
  });

  it('does not reverse an entry belonging to another business', async () => {
    const owner = await seed();
    const stranger = await seed();

    const adjusted = await applyAdjustment(harness.db, {
      ...owner,
      change: { mode: 'delta', quantityDelta: 5 },
      reason: 'delivery',
    });

    await expect(
      reverseEntry(harness.db, {
        businessId: stranger.businessId,
        entryId: adjusted.outcome === 'adjusted' ? adjusted.entryId : '',
        reason: 'not mine to reverse',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('the last unit', () => {
  it('is sold once when two transactions race for it', async () => {
    // Section 12: simultaneous sales serialize through canonical locks and the
    // first committed allocation receives the stock. Both transactions are held
    // open at once, so the second genuinely waits on the first's row lock rather
    // than merely running afterwards.
    const ref = await seed();

    await stock(ref, 1);

    const attempt = async (): Promise<string> =>
      harness.db.transaction(async (tx) => {
        const result = await postMovements(tx, {
          businessId: ref.businessId,
          movements: [
            {
              canonicalItemId: ref.canonicalItemId,
              locationId: ref.locationId,
              kind: 'shipment',
              quantityDelta: -1,
            },
          ],
        });

        return result.outcome;
      });

    const outcomes = await Promise.all([attempt(), attempt()]);

    expect(outcomes.filter((outcome) => outcome === 'posted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'insufficient')).toHaveLength(1);
    await expect(onHandAt(ref, ref.locationId)).resolves.toBe(0);
  });

  it('does not deadlock when two multi-item postings overlap', async () => {
    // Section 12 acquires multi-item locks in sorted UUID order. Two orders
    // naming the same pair in opposite sequence is the case that would deadlock
    // without it.
    const ref = await seed();
    const second = await createCanonicalItem(harness.db, {
      businessId: ref.businessId,
      sku: `pair-${String(counter)}`,
      name: 'Second',
    });
    const secondItemId = second.outcome === 'created' ? second.canonicalItemId : '';

    await stock(ref, 10);
    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: secondItemId,
            locationId: ref.locationId,
            kind: 'receipt',
            quantityDelta: 10,
          },
        ],
      });
    });

    const consume = async (order: readonly string[]): Promise<string> =>
      harness.db.transaction(async (tx) => {
        const result = await postMovements(tx, {
          businessId: ref.businessId,
          movements: order.map((canonicalItemId) => ({
            canonicalItemId,
            locationId: ref.locationId,
            kind: 'shipment' as const,
            quantityDelta: -1,
          })),
        });

        return result.outcome;
      });

    const outcomes = await Promise.all([
      consume([ref.canonicalItemId, secondItemId]),
      consume([secondItemId, ref.canonicalItemId]),
    ]);

    expect(outcomes).toEqual(['posted', 'posted']);
  });
});

describe('lock ordering', () => {
  it('sorts by item and then location, collapsing repeats', () => {
    const ordered = lockOrder([
      { canonicalItemId: 'b', locationId: '2' },
      { canonicalItemId: 'a', locationId: '2' },
      { canonicalItemId: 'a', locationId: '1' },
      { canonicalItemId: 'b', locationId: '2' },
    ]);

    expect(ordered).toEqual([
      { canonicalItemId: 'a', locationId: '1' },
      { canonicalItemId: 'a', locationId: '2' },
      { canonicalItemId: 'b', locationId: '2' },
    ]);
  });
});
