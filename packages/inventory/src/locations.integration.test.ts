import { businesses, canonicalItems, connections, locationBalances, locations } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCanonicalItem,
  listCanonicalItems,
  readItemBalances,
  setItemLocationSettings,
  updateCanonicalItem,
} from './items';
import {
  archiveLocation,
  createLocation,
  linkLocationToChannel,
  listLocations,
  readLocationAddress,
  setLocationAddress,
  unlinkLocationFromChannel,
  updateLocation,
} from './locations';
import { readSettings, updateSettings } from './settings';

/**
 * Locations, canonical items, and the settings that decide how much of the
 * stock at each is withheld (sections 8, 9).
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seedBusiness(): Promise<string> {
  const slug = `inv-${String((counter += 1))}`;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  return business!.id;
}

describe('business inventory settings', () => {
  it('answers with section 8 defaults before anything is configured', async () => {
    // A business that has never opened the settings screen still has to produce
    // a number for every availability calculation downstream.
    const businessId = await seedBusiness();

    await expect(readSettings(harness.db, businessId)).resolves.toEqual({
      businessId,
      defaultSafetyStock: 1,
      consumptionMode: 'reserve_until_fulfilled',
      splitFulfillment: false,
      configured: false,
    });
  });

  it('stores a change and reports the business as configured', async () => {
    const businessId = await seedBusiness();

    await updateSettings(harness.db, { businessId, defaultSafetyStock: 3 });
    await updateSettings(harness.db, { businessId, splitFulfillment: true });

    await expect(readSettings(harness.db, businessId)).resolves.toMatchObject({
      defaultSafetyStock: 3,
      splitFulfillment: true,
      configured: true,
    });
  });

  it('refuses a fractional default', async () => {
    const businessId = await seedBusiness();

    await expect(
      updateSettings(harness.db, { businessId, defaultSafetyStock: 1.5 }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

describe('locations', () => {
  it('creates one and lists it in allocation order', async () => {
    const businessId = await seedBusiness();

    await createLocation(harness.db, { businessId, code: 'B', name: 'Back room', priority: 10 });
    await createLocation(harness.db, { businessId, code: 'A', name: 'Aisle', priority: 10 });
    await createLocation(harness.db, { businessId, code: 'C', name: 'Container', priority: 5 });

    const listed = await listLocations(harness.db, businessId);

    // Priority first, then code. The tiebreak is what makes allocation
    // repeatable before an operator has ranked anything.
    expect(listed.map((row) => row.code)).toEqual(['C', 'A', 'B']);
  });

  it('rejects a second location with the same code', async () => {
    const businessId = await seedBusiness();

    await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });

    await expect(
      createLocation(harness.db, { businessId, code: 'main', name: 'Also main' }),
    ).resolves.toEqual({ outcome: 'code_taken' });
  });

  it('lets two businesses use the same code', async () => {
    const first = await seedBusiness();
    const second = await seedBusiness();

    await createLocation(harness.db, { businessId: first, code: 'MAIN', name: 'Main' });

    await expect(
      createLocation(harness.db, { businessId: second, code: 'MAIN', name: 'Main' }),
    ).resolves.toMatchObject({ outcome: 'created' });
  });

  it('does not update a location belonging to another business', async () => {
    const owner = await seedBusiness();
    const stranger = await seedBusiness();
    const created = await createLocation(harness.db, { businessId: owner, code: 'X', name: 'X' });

    const result = await updateLocation(harness.db, {
      businessId: stranger,
      locationId: created.outcome === 'created' ? created.locationId : '',
      name: 'renamed by a stranger',
    });

    expect(result).toEqual({ outcome: 'not_found' });
  });
});

describe('archiving a location', () => {
  it('refuses while units are still there', async () => {
    // Archiving would leave the units counted in no pool and reachable through
    // no screen, which is worse than telling the operator to move them first.
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'FULL', name: 'Full' });
    const locationId = created.outcome === 'created' ? created.locationId : '';
    const item = await createCanonicalItem(harness.db, { businessId, sku: 'S-1', name: 'Thing' });
    const canonicalItemId = item.outcome === 'created' ? item.canonicalItemId : '';

    await harness.db
      .insert(locationBalances)
      .values({ businessId, canonicalItemId, locationId, onHand: 4 });

    await expect(archiveLocation(harness.db, { businessId, locationId })).resolves.toEqual({
      outcome: 'holds_stock',
      items: 1,
    });
  });

  it('archives an empty one and frees its code', async () => {
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'OLD', name: 'Old' });
    const locationId = created.outcome === 'created' ? created.locationId : '';

    await expect(archiveLocation(harness.db, { businessId, locationId })).resolves.toEqual({
      outcome: 'archived',
    });

    // The code unique index is partial on deleted_at, so the label can be reused
    // on the shelf that replaced it.
    await expect(
      createLocation(harness.db, { businessId, code: 'OLD', name: 'Replacement' }),
    ).resolves.toMatchObject({ outcome: 'created' });

    await expect(listLocations(harness.db, businessId)).resolves.toHaveLength(1);
  });

  it('archives one that has a balance row but no units', async () => {
    // A shelf label with nothing on it is not stock.
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'EMPTY', name: 'Empty' });
    const locationId = created.outcome === 'created' ? created.locationId : '';
    const item = await createCanonicalItem(harness.db, { businessId, sku: 'S-2', name: 'Thing' });
    const canonicalItemId = item.outcome === 'created' ? item.canonicalItemId : '';

    await setItemLocationSettings(harness.db, {
      businessId,
      canonicalItemId,
      locationId,
      bin: 'A-04',
    });

    await expect(archiveLocation(harness.db, { businessId, locationId })).resolves.toEqual({
      outcome: 'archived',
    });
  });
});

describe('location addresses', () => {
  it('keeps a ship-from and a return address apart', async () => {
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'HQ', name: 'HQ' });
    const locationId = created.outcome === 'created' ? created.locationId : '';

    await setLocationAddress(harness.db, {
      businessId,
      locationId,
      purpose: 'ship_from',
      address: { line1: '1 Warehouse Way', city: 'Leeds', countryCode: 'gb' },
    });
    await setLocationAddress(harness.db, {
      businessId,
      locationId,
      purpose: 'return',
      address: { line1: 'PO Box 9', city: 'Manchester', countryCode: 'GB' },
    });

    await expect(
      readLocationAddress(harness.db, { businessId, locationId, purpose: 'ship_from' }),
    ).resolves.toMatchObject({ city: 'Leeds', countryCode: 'GB' });
    await expect(
      readLocationAddress(harness.db, { businessId, locationId, purpose: 'return' }),
    ).resolves.toMatchObject({ city: 'Manchester' });
  });

  it('replaces rather than duplicating an address of the same purpose', async () => {
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'DEP', name: 'Depot' });
    const locationId = created.outcome === 'created' ? created.locationId : '';

    for (const city of ['Leeds', 'York']) {
      await setLocationAddress(harness.db, {
        businessId,
        locationId,
        purpose: 'ship_from',
        address: { line1: '1 Way', city, countryCode: 'GB' },
      });
    }

    await expect(
      readLocationAddress(harness.db, { businessId, locationId, purpose: 'ship_from' }),
    ).resolves.toMatchObject({ city: 'York' });
  });

  it('rejects a country that is not an ISO code', async () => {
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'BAD', name: 'Bad' });
    const locationId = created.outcome === 'created' ? created.locationId : '';

    await expect(
      setLocationAddress(harness.db, {
        businessId,
        locationId,
        purpose: 'ship_from',
        address: { line1: '1 Way', city: 'Leeds', countryCode: 'United Kingdom' },
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

describe('linking a location to a connection', () => {
  async function seedConnection(businessId: string, account: string): Promise<string> {
    const [row] = await harness.db
      .insert(connections)
      .values({
        businessId,
        provider: 'ebay',
        environment: 'sandbox',
        externalAccountId: account,
        displayName: account,
        status: 'active',
        connectedAt: new Date(),
      })
      .returning({ id: connections.id });

    return row!.id;
  }

  it('refuses to point two internal locations at one merchant location', async () => {
    // Section 9 wants the link explicit. Two shelves answering to one remote
    // pool would write each other's quantities.
    const businessId = await seedBusiness();
    const connectionId = await seedConnection(businessId, 'seller-a');
    const first = await createLocation(harness.db, { businessId, code: 'L1', name: 'One' });
    const second = await createLocation(harness.db, { businessId, code: 'L2', name: 'Two' });

    await linkLocationToChannel(harness.db, {
      businessId,
      locationId: first.outcome === 'created' ? first.locationId : '',
      connectionId,
      externalLocationId: 'WAREHOUSE_1',
    });

    await expect(
      linkLocationToChannel(harness.db, {
        businessId,
        locationId: second.outcome === 'created' ? second.locationId : '',
        connectionId,
        externalLocationId: 'WAREHOUSE_1',
      }),
    ).resolves.toEqual({ outcome: 'external_id_taken' });
  });

  it('repoints one location at a different merchant location', async () => {
    const businessId = await seedBusiness();
    const connectionId = await seedConnection(businessId, 'seller-b');
    const created = await createLocation(harness.db, { businessId, code: 'L3', name: 'Three' });
    const locationId = created.outcome === 'created' ? created.locationId : '';

    await linkLocationToChannel(harness.db, {
      businessId,
      locationId,
      connectionId,
      externalLocationId: 'OLD',
    });

    await expect(
      linkLocationToChannel(harness.db, {
        businessId,
        locationId,
        connectionId,
        externalLocationId: 'NEW',
      }),
    ).resolves.toEqual({ outcome: 'linked' });

    await expect(
      unlinkLocationFromChannel(harness.db, { businessId, locationId, connectionId }),
    ).resolves.toEqual({ outcome: 'unlinked' });
  });
});

describe('canonical items', () => {
  it('rejects a duplicate SKU within a business but not across businesses', async () => {
    const first = await seedBusiness();
    const second = await seedBusiness();

    await createCanonicalItem(harness.db, { businessId: first, sku: 'WIDGET', name: 'Widget' });

    await expect(
      createCanonicalItem(harness.db, { businessId: first, sku: 'widget', name: 'Other' }),
    ).resolves.toEqual({ outcome: 'sku_taken' });
    await expect(
      createCanonicalItem(harness.db, { businessId: second, sku: 'WIDGET', name: 'Widget' }),
    ).resolves.toMatchObject({ outcome: 'created' });
  });

  it('keeps its identity when its SKU is corrected', async () => {
    // Section 7: the SKU is a searchable attribute, never database identity.
    const businessId = await seedBusiness();
    const created = await createCanonicalItem(harness.db, {
      businessId,
      sku: 'TYPP',
      name: 'Typo',
    });
    const canonicalItemId = created.outcome === 'created' ? created.canonicalItemId : '';

    await expect(
      updateCanonicalItem(harness.db, { businessId, canonicalItemId, sku: 'TYPO' }),
    ).resolves.toEqual({ outcome: 'updated' });

    const [row] = await harness.db
      .select({ id: canonicalItems.id, sku: canonicalItems.sku })
      .from(canonicalItems)
      .where(eq(canonicalItems.id, canonicalItemId));

    expect(row).toEqual({ id: canonicalItemId, sku: 'TYPO' });
  });

  it('lists only the business asking', async () => {
    const owner = await seedBusiness();
    const stranger = await seedBusiness();

    await createCanonicalItem(harness.db, { businessId: owner, sku: 'MINE', name: 'Mine' });
    await createCanonicalItem(harness.db, { businessId: stranger, sku: 'THEIRS', name: 'Theirs' });

    const listed = await listCanonicalItems(harness.db, owner);

    expect(listed.map((row) => row.sku)).toEqual(['MINE']);
  });
});

describe('resolving safety stock through the levels', () => {
  interface Fixture {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly locationId: string;
  }

  async function fixture(): Promise<Fixture> {
    const businessId = await seedBusiness();
    const created = await createLocation(harness.db, { businessId, code: 'S', name: 'Shelf' });
    const item = await createCanonicalItem(harness.db, { businessId, sku: 'RES', name: 'Res' });

    return {
      businessId,
      locationId: created.outcome === 'created' ? created.locationId : '',
      canonicalItemId: item.outcome === 'created' ? item.canonicalItemId : '',
    };
  }

  it('falls back to the business default', async () => {
    const ref = await fixture();

    await setItemLocationSettings(harness.db, { ...ref, bin: 'A-1' });

    const [balance] = await readItemBalances(harness.db, ref);

    expect(balance).toMatchObject({ safetyStock: 1, safetyStockFrom: 'business', bin: 'A-1' });
  });

  it('prefers the item override, including a deliberate zero', async () => {
    const ref = await fixture();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 4 });
    await setItemLocationSettings(harness.db, ref);
    await updateCanonicalItem(harness.db, { ...ref, safetyStockOverride: 0 });

    const [balance] = await readItemBalances(harness.db, ref);

    // A stored 0 is a decision. Reading it as absence would withhold four units
    // the operator deliberately released.
    expect(balance).toMatchObject({ safetyStock: 0, safetyStockFrom: 'item' });
  });

  it('prefers the location override to the item override', async () => {
    const ref = await fixture();

    await updateCanonicalItem(harness.db, { ...ref, safetyStockOverride: 5 });
    await setItemLocationSettings(harness.db, { ...ref, safetyStock: 2 });

    const [balance] = await readItemBalances(harness.db, ref);

    expect(balance).toMatchObject({ safetyStock: 2, safetyStockFrom: 'location' });
  });

  it('stores nothing rather than zero when an override is not given', async () => {
    // The migration made this column nullable precisely so the two stay
    // distinguishable; a service that defaulted it to 0 would undo that.
    const ref = await fixture();

    await setItemLocationSettings(harness.db, { ...ref, note: 'top shelf' });

    const [row] = await harness.db
      .select({ safetyStock: locationBalances.safetyStock })
      .from(locationBalances)
      .where(
        and(
          eq(locationBalances.businessId, ref.businessId),
          eq(locationBalances.canonicalItemId, ref.canonicalItemId),
          eq(locationBalances.locationId, ref.locationId),
        ),
      );

    expect(row?.safetyStock).toBeNull();
  });

  it('reports nothing for an item in another business', async () => {
    const ref = await fixture();
    const stranger = await seedBusiness();

    await setItemLocationSettings(harness.db, ref);

    await expect(
      readItemBalances(harness.db, {
        businessId: stranger,
        canonicalItemId: ref.canonicalItemId,
      }),
    ).resolves.toEqual([]);
  });

  it('hides balances at an archived location', async () => {
    const ref = await fixture();

    await setItemLocationSettings(harness.db, ref);
    await harness.db
      .update(locations)
      .set({ deletedAt: new Date() })
      .where(eq(locations.id, ref.locationId));

    await expect(readItemBalances(harness.db, ref)).resolves.toEqual([]);
  });
});
