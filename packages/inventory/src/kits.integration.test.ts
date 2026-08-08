import { businesses, canonicalItems, inventoryLedger, kitRecipes, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCanonicalItem } from './items';
import {
  approveRecipe,
  declareKit,
  describeOverlap,
  draftRecipe,
  kitCapacity,
  kitsUsingComponent,
  readActiveRecipe,
  readRecipe,
} from './kits';
import { postMovements } from './ledger';
import { createLocation } from './locations';
import { updateSettings } from './settings';

/**
 * Fixed-quantity kits (section 10).
 *
 * The arithmetic is property-tested without a database in `@eim/domain`. What
 * needs a real one is the structural claim: a kit has no independent physical
 * stock, and no path exists by which it acquires any.
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
  readonly kitId: string;
  readonly boltId: string;
  readonly plateId: string;
  readonly locationId: string;
  readonly otherLocationId: string;
  readonly slug: string;
}

async function seed(): Promise<Fixture> {
  const slug = `kit-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Administrator' })
    .returning({ id: users.id });
  const businessId = business!.id;

  const make = async (sku: string): Promise<string> => {
    const created = await createCanonicalItem(harness.db, { businessId, sku, name: sku });

    return created.outcome === 'created' ? created.canonicalItemId : '';
  };

  const main = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const spare = await createLocation(harness.db, { businessId, code: 'SPARE', name: 'Spare' });

  const kitId = await make(`${slug}-kit`);
  await declareKit(harness.db, { businessId, canonicalItemId: kitId });

  return {
    businessId,
    slug,
    userId: user!.id,
    kitId,
    boltId: await make(`${slug}-bolt`),
    plateId: await make(`${slug}-plate`),
    locationId: main.outcome === 'created' ? main.locationId : '',
    otherLocationId: spare.outcome === 'created' ? spare.locationId : '',
  };
}

async function stock(
  ref: Fixture,
  canonicalItemId: string,
  quantity: number,
  locationId = ref.locationId,
): Promise<void> {
  await harness.db.transaction(async (tx) => {
    await postMovements(tx, {
      businessId: ref.businessId,
      movements: [{ canonicalItemId, locationId, kind: 'receipt', quantityDelta: quantity }],
    });
  });
}

async function activeRecipe(
  ref: Fixture,
  components: readonly { readonly canonicalItemId: string; readonly requiredQuantity: number }[],
): Promise<string> {
  const drafted = await draftRecipe(harness.db, {
    businessId: ref.businessId,
    kitCanonicalItemId: ref.kitId,
    components,
    createdByUserId: ref.userId,
  });
  const recipeId = drafted.outcome === 'drafted' ? drafted.recipeId : '';

  await approveRecipe(harness.db, {
    businessId: ref.businessId,
    recipeId,
    approvedByUserId: ref.userId,
  });

  return recipeId;
}

describe('a kit has no independent physical stock', () => {
  it('refuses a ledger entry against a kit', async () => {
    // Section 10's first sentence, enforced by a composite foreign key rather
    // than by whichever code path remembered.
    const ref = await seed();

    const failure = await harness.db
      .transaction(async (tx) =>
        postMovements(tx, {
          businessId: ref.businessId,
          movements: [
            {
              canonicalItemId: ref.kitId,
              locationId: ref.locationId,
              kind: 'receipt',
              quantityDelta: 5,
            },
          ],
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);

    const entries = await harness.db
      .select({ id: inventoryLedger.id })
      .from(inventoryLedger)
      .where(eq(inventoryLedger.canonicalItemId, ref.kitId));

    expect(entries).toEqual([]);
  });

  it('refuses to turn a stocked item into a kit', async () => {
    // A conversion would leave the counted units belonging to nothing.
    const ref = await seed();

    await stock(ref, ref.boltId, 4);

    await expect(
      declareKit(harness.db, { businessId: ref.businessId, canonicalItemId: ref.boltId }),
    ).resolves.toEqual({ outcome: 'holds_stock' });
  });

  it('is idempotent for an item that is already a kit', async () => {
    const ref = await seed();

    await expect(
      declareKit(harness.db, { businessId: ref.businessId, canonicalItemId: ref.kitId }),
    ).resolves.toEqual({ outcome: 'declared' });
  });
});

describe('authoring a recipe', () => {
  it('requires positive whole component quantities', async () => {
    const ref = await seed();

    for (const requiredQuantity of [0, -1, 1.5]) {
      await expect(
        draftRecipe(harness.db, {
          businessId: ref.businessId,
          kitCanonicalItemId: ref.kitId,
          components: [{ canonicalItemId: ref.boltId, requiredQuantity }],
        }),
      ).resolves.toMatchObject({ outcome: 'invalid' });
    }
  });

  it('refuses a kit that contains itself', async () => {
    const ref = await seed();

    await expect(
      draftRecipe(harness.db, {
        businessId: ref.businessId,
        kitCanonicalItemId: ref.kitId,
        components: [{ canonicalItemId: ref.kitId, requiredQuantity: 1 }],
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('refuses a kit as a component of another kit', async () => {
    // A kit inside a kit would contribute no units, having none of its own.
    const ref = await seed();
    const otherKit = await createCanonicalItem(harness.db, {
      businessId: ref.businessId,
      sku: `${ref.slug}-kit2`,
      name: 'Second kit',
    });
    const otherKitId = otherKit.outcome === 'created' ? otherKit.canonicalItemId : '';

    await declareKit(harness.db, { businessId: ref.businessId, canonicalItemId: otherKitId });

    await expect(
      draftRecipe(harness.db, {
        businessId: ref.businessId,
        kitCanonicalItemId: ref.kitId,
        components: [{ canonicalItemId: otherKitId, requiredQuantity: 1 }],
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('refuses a recipe for an item that is not a kit', async () => {
    const ref = await seed();

    await expect(
      draftRecipe(harness.db, {
        businessId: ref.businessId,
        kitCanonicalItemId: ref.boltId,
        components: [{ canonicalItemId: ref.plateId, requiredQuantity: 1 }],
      }),
    ).resolves.toEqual({ outcome: 'not_a_kit' });
  });

  it('drafts without putting anything in force', async () => {
    const ref = await seed();

    await draftRecipe(harness.db, {
      businessId: ref.businessId,
      kitCanonicalItemId: ref.kitId,
      components: [{ canonicalItemId: ref.boltId, requiredQuantity: 2 }],
    });

    await expect(
      readActiveRecipe(harness.db, {
        businessId: ref.businessId,
        kitCanonicalItemId: ref.kitId,
      }),
    ).resolves.toBeNull();
  });
});

describe('approving a recipe', () => {
  it('supersedes the one it replaces and keeps it readable', async () => {
    // Section 10: existing orders retain the recipe version active at purchase,
    // so a kit reversal must be able to read what was actually taken.
    const ref = await seed();
    const first = await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 2 }]);
    const second = await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 3 }]);

    await expect(
      readActiveRecipe(harness.db, {
        businessId: ref.businessId,
        kitCanonicalItemId: ref.kitId,
      }),
    ).resolves.toMatchObject({ recipeId: second, version: 2 });

    await expect(
      readRecipe(harness.db, { businessId: ref.businessId, recipeId: first }),
    ).resolves.toMatchObject({
      status: 'superseded',
      components: [{ requiredQuantity: 2 }],
    });
  });

  it('records the person who approved it', async () => {
    // Section 10: AI may suggest components but cannot save or activate. An
    // active recipe therefore always names an approver, and the database agrees.
    const ref = await seed();
    const recipeId = await activeRecipe(ref, [
      { canonicalItemId: ref.boltId, requiredQuantity: 1 },
    ]);

    const [row] = await harness.db
      .select({ approvedByUserId: kitRecipes.approvedByUserId })
      .from(kitRecipes)
      .where(eq(kitRecipes.id, recipeId));

    expect(row?.approvedByUserId).toBe(ref.userId);
  });

  it('refuses to approve the same draft twice', async () => {
    const ref = await seed();
    const recipeId = await activeRecipe(ref, [
      { canonicalItemId: ref.boltId, requiredQuantity: 1 },
    ]);

    await expect(
      approveRecipe(harness.db, {
        businessId: ref.businessId,
        recipeId,
        approvedByUserId: ref.userId,
      }),
    ).resolves.toEqual({ outcome: 'not_draft', status: 'active' });
  });
});

describe('kit capacity', () => {
  it('is the component that runs out first', async () => {
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, ref.boltId, 10);
    await stock(ref, ref.plateId, 3);
    await activeRecipe(ref, [
      { canonicalItemId: ref.boltId, requiredQuantity: 2 },
      { canonicalItemId: ref.plateId, requiredQuantity: 1 },
    ]);

    const result = await kitCapacity(harness.db, {
      businessId: ref.businessId,
      kitCanonicalItemId: ref.kitId,
    });

    // floor(10 / 2) = 5 bolts' worth, floor(3 / 1) = 3 plates' worth.
    expect(result).toMatchObject({ outcome: 'computed', capacity: { capacity: 3 } });
    expect(
      result.outcome === 'computed' ? result.capacity.limitedBy.map((row) => row.sku) : [],
    ).toEqual([`${ref.slug}-plate`]);
  });

  it('inherits component safety stock and cannot consume protected units', async () => {
    // Section 10 is explicit about this: kit capacity divides the component's
    // available-to-sell figure, not its physical count.
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 2 });
    await stock(ref, ref.boltId, 6);
    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }]);

    await expect(
      kitCapacity(harness.db, { businessId: ref.businessId, kitCanonicalItemId: ref.kitId }),
    ).resolves.toMatchObject({ capacity: { capacity: 4 } });
  });

  it('will not build one kit from two locations unless splitting is enabled', async () => {
    // Section 10: components from multiple locations satisfy one kit only when
    // split fulfillment is enabled.
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, ref.boltId, 5);
    await stock(ref, ref.plateId, 5, ref.otherLocationId);
    await activeRecipe(ref, [
      { canonicalItemId: ref.boltId, requiredQuantity: 1 },
      { canonicalItemId: ref.plateId, requiredQuantity: 1 },
    ]);

    await expect(
      kitCapacity(harness.db, { businessId: ref.businessId, kitCanonicalItemId: ref.kitId }),
    ).resolves.toMatchObject({ capacity: { capacity: 0 } });

    await updateSettings(harness.db, { businessId: ref.businessId, splitFulfillment: true });

    await expect(
      kitCapacity(harness.db, { businessId: ref.businessId, kitCanonicalItemId: ref.kitId }),
    ).resolves.toMatchObject({ capacity: { capacity: 5, splitFulfillment: true } });
  });

  it('recomputes the moment a component moves', async () => {
    // Section 10 requires immediate recalculation on every component movement.
    // Deriving rather than storing is what makes that true by construction.
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, ref.boltId, 4);
    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }]);

    await expect(
      kitCapacity(harness.db, { businessId: ref.businessId, kitCanonicalItemId: ref.kitId }),
    ).resolves.toMatchObject({ capacity: { capacity: 4 } });

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: ref.businessId,
        movements: [
          {
            canonicalItemId: ref.boltId,
            locationId: ref.locationId,
            kind: 'shipment',
            quantityDelta: -3,
          },
        ],
      });
    });

    await expect(
      kitCapacity(harness.db, { businessId: ref.businessId, kitCanonicalItemId: ref.kitId }),
    ).resolves.toMatchObject({ capacity: { capacity: 1 } });
  });

  it('supplies nothing without a recipe in force', async () => {
    const ref = await seed();

    await stock(ref, ref.boltId, 10);
    await draftRecipe(harness.db, {
      businessId: ref.businessId,
      kitCanonicalItemId: ref.kitId,
      components: [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }],
    });

    await expect(
      kitCapacity(harness.db, { businessId: ref.businessId, kitCanonicalItemId: ref.kitId }),
    ).resolves.toEqual({ outcome: 'no_active_recipe' });
  });

  it('narrows to the locations a mapping selected', async () => {
    const ref = await seed();

    await updateSettings(harness.db, {
      businessId: ref.businessId,
      defaultSafetyStock: 0,
      splitFulfillment: true,
    });
    await stock(ref, ref.boltId, 4);
    await stock(ref, ref.boltId, 6, ref.otherLocationId);
    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }]);

    await expect(
      kitCapacity(harness.db, {
        businessId: ref.businessId,
        kitCanonicalItemId: ref.kitId,
        locationIds: [ref.locationId],
      }),
    ).resolves.toMatchObject({ capacity: { capacity: 4 } });
  });
});

describe('the deliberate overlap', () => {
  it('names the components a kit shares with an item being mapped', async () => {
    // Section 10 permits a kit and its own component to both be mapped, and
    // requires the warning to name what is shared: "there is an overlap" is not
    // something an operator can act on.
    const ref = await seed();

    await activeRecipe(ref, [
      { canonicalItemId: ref.boltId, requiredQuantity: 2 },
      { canonicalItemId: ref.plateId, requiredQuantity: 1 },
    ]);

    const overlap = await describeOverlap(harness.db, {
      businessId: ref.businessId,
      canonicalItemId: ref.boltId,
    });

    expect(overlap).toHaveLength(1);
    expect(overlap[0]).toMatchObject({
      kitCanonicalItemId: ref.kitId,
      sharedComponents: [{ canonicalItemId: ref.boltId, sku: `${ref.slug}-bolt` }],
    });
  });

  it('reports nothing for an item no kit uses', async () => {
    const ref = await seed();

    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }]);

    await expect(
      describeOverlap(harness.db, {
        businessId: ref.businessId,
        canonicalItemId: ref.plateId,
      }),
    ).resolves.toEqual([]);
  });

  it('lists the kits that would be recalculated by a component movement', async () => {
    const ref = await seed();

    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 4 }]);

    await expect(
      kitsUsingComponent(harness.db, {
        businessId: ref.businessId,
        canonicalItemId: ref.boltId,
      }),
    ).resolves.toEqual([{ kitCanonicalItemId: ref.kitId, requiredQuantity: 4 }]);
  });

  it('ignores a superseded recipe', async () => {
    const ref = await seed();

    await activeRecipe(ref, [{ canonicalItemId: ref.plateId, requiredQuantity: 1 }]);
    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }]);

    await expect(
      kitsUsingComponent(harness.db, {
        businessId: ref.businessId,
        canonicalItemId: ref.plateId,
      }),
    ).resolves.toEqual([]);
  });

  it('does not look into another business', async () => {
    const ref = await seed();
    const stranger = await seed();

    await activeRecipe(ref, [{ canonicalItemId: ref.boltId, requiredQuantity: 1 }]);

    await expect(
      describeOverlap(harness.db, {
        businessId: stranger.businessId,
        canonicalItemId: ref.boltId,
      }),
    ).resolves.toEqual([]);
  });
});

describe('the kit item itself', () => {
  it('is marked as a kit and stays a canonical item', async () => {
    const ref = await seed();

    const [row] = await harness.db
      .select({ isKit: canonicalItems.isKit, sku: canonicalItems.sku })
      .from(canonicalItems)
      .where(eq(canonicalItems.id, ref.kitId));

    expect(row).toMatchObject({ isKit: true, sku: `${ref.slug}-kit` });
  });
});
