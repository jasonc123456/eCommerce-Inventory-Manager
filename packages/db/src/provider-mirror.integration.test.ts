import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  businesses,
  connections,
  importRuns,
  locations,
  marketplaceDeletionOutcomes,
  marketplaceDeletionRequests,
  memberships,
  providerItems,
  providerLocations,
  providerOrderLines,
  providerOrders,
  providerPolicies,
  providerRefunds,
  users,
} from './index';

/**
 * Proof that the mirror stays a mirror.
 *
 * The rules here are the ones that stop imported data being mistaken for
 * canonical data, or one seller's catalog for another's. The eligibility and
 * disappearance rules matter most: an entity wrongly marked eligible becomes
 * something the application will later write quantities to, and a row deleted
 * because one page of an import failed becomes a listing that quietly stopped
 * being managed.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<{
  businessId: string;
  connectionId: string;
  locationId: string;
}> {
  const { db } = harness;
  const slug = `mirror-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid` })
    .returning({ id: users.id });

  await db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' });

  const [location] = await db
    .insert(locations)
    .values({ businessId: business!.id, code: 'MAIN', name: 'Main' })
    .returning({ id: locations.id });

  const [connection] = await db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: slug,
      displayName: 'Seller',
      status: 'active',
      connectedAt: new Date(),
    })
    .returning({ id: connections.id });

  return {
    businessId: business!.id,
    connectionId: connection!.id,
    locationId: location!.id,
  };
}

const item = (businessId: string, connectionId: string, externalId: string) => ({
  businessId,
  connectionId,
  externalId,
  kind: 'listing' as const,
  inventoryEligible: true,
});

describe('catalog entities', () => {
  it('updates rather than duplicates when the same catalog is imported twice', async () => {
    // An import that runs twice, or resumes after a failure, re-reads pages it
    // has already seen. Two rows for one listing would then be mapped twice and
    // written to twice.
    const { businessId, connectionId } = await seed();

    await harness.db.insert(providerItems).values(item(businessId, connectionId, 'listing-1'));

    const reason = await refuses(() =>
      harness.db.insert(providerItems).values(item(businessId, connectionId, 'listing-1')),
    );

    expect(reason).toContain('provider_items_external_unique');
  });

  it('lets two connections hold the same provider identifier', async () => {
    // Identifiers are unique within a provider account, not globally. Two eBay
    // sellers can both have a listing numbered 1.
    const first = await seed();
    const second = await seed();

    await harness.db.insert(providerItems).values(item(first.businessId, first.connectionId, '1'));

    await expect(
      harness.db.insert(providerItems).values(item(second.businessId, second.connectionId, '1')),
    ).resolves.toBeTruthy();
  });

  it('refuses an item attached to another business’s connection', async () => {
    const owner = await seed();
    const stranger = await seed();

    const reason = await refuses(() =>
      harness.db.insert(providerItems).values(item(stranger.businessId, owner.connectionId, 'x')),
    );

    expect(reason).toContain('provider_items_connection_fkey');
  });

  it('requires an ineligible entity to say why, and an eligible one not to', async () => {
    // "Not eligible" with no reason is a support ticket; "eligible, because
    // parent-level stock" is a contradiction that would let a write through.
    const { businessId, connectionId } = await seed();

    expect(
      await refuses(() =>
        harness.db.insert(providerItems).values({
          ...item(businessId, connectionId, 'a'),
          inventoryEligible: false,
        }),
      ),
    ).toContain('provider_items_ineligible_explained');

    expect(
      await refuses(() =>
        harness.db.insert(providerItems).values({
          ...item(businessId, connectionId, 'b'),
          inventoryEligible: true,
          ineligibleReason: 'stock is managed on the parent',
        }),
      ),
    ).toContain('provider_items_ineligible_explained');

    await expect(
      harness.db.insert(providerItems).values({
        ...item(businessId, connectionId, 'c'),
        inventoryEligible: false,
        ineligibleReason: 'stock is managed on the parent',
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a price without a currency', async () => {
    const { businessId, connectionId } = await seed();

    expect(
      await refuses(() =>
        harness.db
          .insert(providerItems)
          .values({ ...item(businessId, connectionId, 'p'), priceAmount: '19.9900' }),
      ),
    ).toContain('provider_items_price_complete');

    expect(
      await refuses(() =>
        harness.db.insert(providerItems).values({
          ...item(businessId, connectionId, 'q'),
          priceAmount: '19.9900',
          priceCurrency: 'usd',
        }),
      ),
    ).toContain('provider_items_currency_shaped');
  });

  it('keeps a negative quantity, because WooCommerce means something by it', async () => {
    // Section 8 as amended by D-130: negative stock is backorder demand, and
    // clamping it at zero destroys the signal the store is sending.
    const { businessId, connectionId } = await seed();

    await harness.db.insert(providerItems).values({
      ...item(businessId, connectionId, 'backordered'),
      quantity: -4,
      backordersEnabled: true,
    });

    const [row] = await harness.db
      .select({ quantity: providerItems.quantity })
      .from(providerItems)
      .where(eq(providerItems.externalId, 'backordered'));

    expect(row?.quantity).toBe(-4);
  });

  it('survives the import run that created it being pruned', async () => {
    // Run history ages out under retention; the catalog does not go with it.
    const { businessId, connectionId } = await seed();

    const [run] = await harness.db
      .insert(importRuns)
      .values({ businessId, connectionId, stream: 'listings' })
      .returning({ id: importRuns.id });

    await harness.db.insert(providerItems).values({
      ...item(businessId, connectionId, 'kept'),
      lastImportRunId: run!.id,
    });

    await harness.db.delete(importRuns).where(eq(importRuns.id, run!.id));

    const [row] = await harness.db
      .select({ id: providerItems.id, runId: providerItems.lastImportRunId })
      .from(providerItems)
      .where(eq(providerItems.externalId, 'kept'));

    expect(row).toBeDefined();
    expect(row?.runId).toBeNull();
  });
});

describe('locations', () => {
  it('leaves the internal mapping unset until somebody chooses it', async () => {
    // Guessing which warehouse an eBay location means is the guess that sends
    // stock to the wrong place.
    const { businessId, connectionId } = await seed();

    await harness.db
      .insert(providerLocations)
      .values({ businessId, connectionId, externalId: 'WAREHOUSE-1' });

    const [row] = await harness.db
      .select({ mapped: providerLocations.mappedLocationId })
      .from(providerLocations)
      .where(eq(providerLocations.externalId, 'WAREHOUSE-1'));

    expect(row?.mapped).toBeNull();
  });

  it('refuses a mapping to a location in another business', async () => {
    const owner = await seed();
    const stranger = await seed();

    const reason = await refuses(() =>
      harness.db.insert(providerLocations).values({
        businessId: owner.businessId,
        connectionId: owner.connectionId,
        externalId: 'W1',
        mappedLocationId: stranger.locationId,
      }),
    );

    expect(reason).toContain('provider_locations_mapped_fkey');
  });
});

describe('policies', () => {
  it('allows one identifier to exist as two policy types', async () => {
    // eBay numbers each policy family separately, so a payment policy and a
    // return policy can share an identifier.
    const { businessId, connectionId } = await seed();

    await harness.db.insert(providerPolicies).values([
      { businessId, connectionId, externalId: '5', policyType: 'payment' },
      { businessId, connectionId, externalId: '5', policyType: 'return' },
    ]);

    const rows = await harness.db
      .select({ id: providerPolicies.id })
      .from(providerPolicies)
      .where(eq(providerPolicies.connectionId, connectionId));

    expect(rows).toHaveLength(2);
  });
});

describe('orders', () => {
  it('bounds fulfilled quantity by ordered quantity', async () => {
    // Section 13 supports partial fulfilment; more shipped than sold is a
    // parsing error, and one that would later release stock that never existed.
    const { businessId, connectionId } = await seed();

    const [order] = await harness.db
      .insert(providerOrders)
      .values({ businessId, connectionId, externalId: 'order-1' })
      .returning({ id: providerOrders.id });

    expect(
      await refuses(() =>
        harness.db.insert(providerOrderLines).values({
          businessId,
          orderId: order!.id,
          externalId: 'line-1',
          quantity: 2,
          quantityFulfilled: 3,
        }),
      ),
    ).toContain('provider_order_lines_fulfilled_bounded');

    expect(
      await refuses(() =>
        harness.db.insert(providerOrderLines).values({
          businessId,
          orderId: order!.id,
          externalId: 'line-2',
          quantity: 0,
        }),
      ),
    ).toContain('provider_order_lines_quantity_positive');
  });

  it('keeps an order line whose listing has since been swept away', async () => {
    // An ended listing is removed from the catalog; the order that sold it is
    // still the reason stock left the building.
    const { businessId, connectionId } = await seed();

    await harness.db.insert(providerItems).values(item(businessId, connectionId, 'ended-listing'));

    const [order] = await harness.db
      .insert(providerOrders)
      .values({ businessId, connectionId, externalId: 'order-2' })
      .returning({ id: providerOrders.id });

    await harness.db.insert(providerOrderLines).values({
      businessId,
      orderId: order!.id,
      externalId: 'line-1',
      itemExternalId: 'ended-listing',
      quantity: 1,
    });

    await harness.db.delete(providerItems).where(eq(providerItems.externalId, 'ended-listing'));

    const lines = await harness.db
      .select({ id: providerOrderLines.id })
      .from(providerOrderLines)
      .where(eq(providerOrderLines.orderId, order!.id));

    expect(lines).toHaveLength(1);
  });

  it('accepts a refund that arrives before its order', async () => {
    // Refunds and orders are separate streams with separate cursors. Refusing
    // the refund until the order lands would drop it permanently.
    const { businessId, connectionId } = await seed();

    await expect(
      harness.db.insert(providerRefunds).values({
        businessId,
        connectionId,
        externalId: 'refund-1',
        orderExternalId: 'order-not-yet-imported',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('marketplace deletion', () => {
  it('refuses to process a request whose signature did not verify', async () => {
    // Erasure is irreversible, so acting on an unauthenticated instruction to
    // erase is a denial-of-service primitive rather than a compliance step.
    const reason = await refuses(() =>
      harness.db.insert(marketplaceDeletionRequests).values({
        buyerExternalId: 'buyer-1',
        notificationId: `note-${String((counter += 1))}`,
        verified: false,
        status: 'processing',
      }),
    );

    expect(reason).toContain('marketplace_deletion_requests_unverified_not_processed');
  });

  it('deduplicates a redelivered notification', async () => {
    const notificationId = `note-${String((counter += 1))}`;

    await harness.db
      .insert(marketplaceDeletionRequests)
      .values({ buyerExternalId: 'buyer-2', notificationId, verified: true });

    const reason = await refuses(() =>
      harness.db
        .insert(marketplaceDeletionRequests)
        .values({ buyerExternalId: 'buyer-2', notificationId, verified: true }),
    );

    expect(reason).toContain('marketplace_deletion_requests_notification_unique');
  });

  it('records an outcome per business so a partial failure stays visible', async () => {
    // One endpoint per application, several businesses holding the same buyer's
    // data (D-137). A single status would report success as soon as the first
    // business finished, while another kept the data.
    const first = await seed();
    const second = await seed();

    const [request] = await harness.db
      .insert(marketplaceDeletionRequests)
      .values({
        buyerExternalId: 'buyer-3',
        notificationId: `note-${String((counter += 1))}`,
        verified: true,
        status: 'processing',
      })
      .returning({ id: marketplaceDeletionRequests.id });

    await harness.db.insert(marketplaceDeletionOutcomes).values([
      {
        requestId: request!.id,
        businessId: first.businessId,
        status: 'completed',
        recordsAffected: 3,
        completedAt: new Date(),
      },
      { requestId: request!.id, businessId: second.businessId, status: 'failed' },
    ]);

    const outcomes = await harness.db
      .select({ status: marketplaceDeletionOutcomes.status })
      .from(marketplaceDeletionOutcomes)
      .where(eq(marketplaceDeletionOutcomes.requestId, request!.id));

    expect(outcomes.map((o) => o.status).sort()).toEqual(['completed', 'failed']);
  });

  it('refuses two outcomes for the same business on one request', async () => {
    const { businessId } = await seed();

    const [request] = await harness.db
      .insert(marketplaceDeletionRequests)
      .values({
        buyerExternalId: 'buyer-4',
        notificationId: `note-${String((counter += 1))}`,
        verified: true,
      })
      .returning({ id: marketplaceDeletionRequests.id });

    await harness.db
      .insert(marketplaceDeletionOutcomes)
      .values({ requestId: request!.id, businessId });

    const reason = await refuses(() =>
      harness.db.insert(marketplaceDeletionOutcomes).values({ requestId: request!.id, businessId }),
    );

    expect(reason).toContain('marketplace_deletion_outcomes_pkey');
  });
});
