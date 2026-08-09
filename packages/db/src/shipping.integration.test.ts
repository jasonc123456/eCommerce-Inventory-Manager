import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  businesses,
  channelOrderLines,
  channelOrders,
  connections,
  locations,
  reviewedOperations,
  shipmentLabels,
  shipmentPackageLines,
  shipmentPackages,
  shipmentRateQuotes,
  shipmentTrackingEvents,
  shippingAccounts,
  users,
} from './index';

/**
 * Proof that the shipping tables enforce what sections 2, 9, 14, and 21 say.
 *
 * The rules under test are the ones whose violation costs money or ships a
 * parcel nobody agreed to. A second label bought for a package that already has
 * one is a second charge on the business's account. A label with no confirmation
 * behind it is the "purchase after cost confirmation" rule of section 21 quietly
 * not applying. A package marked shipped with nobody attached to it is section
 * 14's "a user explicitly marks each package shipped" with the user missing.
 *
 * None of these announce themselves in normal use. They surface as a line on a
 * postage bill nobody can explain.
 *
 * Runs against real PostgreSQL 18 only. There is no fake.
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
  readonly orderId: string;
  readonly orderLineId: string;
  readonly locationId: string;
  readonly accountId: string;
  readonly packageId: string;
  readonly quoteId: string;
  readonly operationId: string;
}

async function seed(): Promise<Fixture> {
  const { db } = harness;
  const slug = `ship-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Packer' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  const [connection] = await db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `seller-${slug}`,
      displayName: 'Seller',
      status: 'active',
    })
    .returning({ id: connections.id });

  const [location] = await db
    .insert(locations)
    .values({ businessId, code: slug.toUpperCase().slice(0, 12), name: 'Workshop' })
    .returning({ id: locations.id });

  const [order] = await db
    .insert(channelOrders)
    .values({
      businessId,
      connectionId: connection!.id,
      externalOrderId: `order-${slug}`,
      demandState: 'committed',
    })
    .returning({ id: channelOrders.id });

  const [line] = await db
    .insert(channelOrderLines)
    .values({
      businessId,
      orderId: order!.id,
      externalLineId: 'line-1',
      quantity: 3,
    })
    .returning({ id: channelOrderLines.id });

  const [account] = await db
    .insert(shippingAccounts)
    .values({
      businessId,
      provider: 'easypost',
      environment: 'sandbox',
      displayName: 'Postage',
      status: 'active',
    })
    .returning({ id: shippingAccounts.id });

  const [parcel] = await db
    .insert(shipmentPackages)
    .values({
      businessId,
      orderId: order!.id,
      locationId: location!.id,
      weightGrams: 500,
      createdByUserId: userId,
    })
    .returning({ id: shipmentPackages.id });

  const [quote] = await db
    .insert(shipmentRateQuotes)
    .values({
      businessId,
      packageId: parcel!.id,
      accountId: account!.id,
      providerShipmentId: 'shp-1',
      rates: [{ rateId: 'rate-standard', amount: '3.95', currency: 'GBP' }],
      quotedAt: new Date(),
    })
    .returning({ id: shipmentRateQuotes.id });

  const operationId = await confirmedOperation(businessId, userId, `package:${parcel!.id}`);

  return {
    businessId,
    userId,
    orderId: order!.id,
    orderLineId: line!.id,
    locationId: location!.id,
    accountId: account!.id,
    packageId: parcel!.id,
    quoteId: quote!.id,
    operationId,
  };
}

/** A confirmed `label_purchase`, because an unconfirmed one cannot buy anything. */
async function confirmedOperation(
  businessId: string,
  userId: string,
  subjectKey: string,
): Promise<string> {
  const now = new Date();
  const [operation] = await harness.db
    .insert(reviewedOperations)
    .values({
      businessId,
      kind: 'label_purchase',
      subjectKey,
      requiredPermission: 'purchase_labels',
      preview: { amount: '3.95' },
      previewFingerprint: `fp-${subjectKey}`,
      sourceObservedAt: now,
      sourceMaxAgeMs: 600_000,
      expiresAt: new Date(now.getTime() + 1_200_000),
      idempotencyKey: `key-${subjectKey}-${String((counter += 1))}`,
      state: 'confirmed',
      confirmedByUserId: userId,
      confirmedAt: now,
    })
    .returning({ id: reviewedOperations.id });

  return operation!.id;
}

async function buyLabel(fixture: Fixture, providerLabelId: string) {
  return harness.db.insert(shipmentLabels).values({
    businessId: fixture.businessId,
    packageId: fixture.packageId,
    accountId: fixture.accountId,
    quoteId: fixture.quoteId,
    operationId: fixture.operationId,
    providerLabelId,
    providerShipmentId: 'shp-1',
    rateId: 'rate-standard',
    carrier: 'RoyalMail',
    service: 'Tracked48',
    trackingNumber: `TRK-${providerLabelId}`,
    amount: '3.95',
    currency: 'GBP',
    purchasedAt: new Date(),
  });
}

describe('one label per package', () => {
  it('refuses a second live label for the same package', async () => {
    const fixture = await seed();
    await buyLabel(fixture, 'lbl-1');

    const message = await refuses(() => buyLabel(fixture, 'lbl-2'));

    expect(message).toContain('shipment_labels_one_live_per_package');
  });

  it('frees the package once the label is voided', async () => {
    const fixture = await seed();
    await buyLabel(fixture, 'lbl-3');

    await harness.db
      .update(shipmentLabels)
      .set({
        state: 'voided',
        voidRequestedAt: new Date(),
        voidRequestedByUserId: fixture.userId,
        voidedAt: new Date(),
      })
      .where(eq(shipmentLabels.packageId, fixture.packageId));

    // Buying a replacement after voiding is the entire reason voiding exists.
    await expect(buyLabel(fixture, 'lbl-4')).resolves.toBeDefined();
  });

  it('refuses the same provider label twice on one account', async () => {
    const fixture = await seed();
    await buyLabel(fixture, 'lbl-5');
    await harness.db
      .update(shipmentLabels)
      .set({
        state: 'voided',
        voidRequestedAt: new Date(),
        voidRequestedByUserId: fixture.userId,
        voidedAt: new Date(),
      })
      .where(eq(shipmentLabels.packageId, fixture.packageId));

    const message = await refuses(() => buyLabel(fixture, 'lbl-5'));

    expect(message).toContain('shipment_labels_provider_unique');
  });
});

describe('a label names the confirmation that bought it', () => {
  it('cannot be stored without one', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      harness.db.insert(shipmentLabels).values({
        businessId: fixture.businessId,
        packageId: fixture.packageId,
        accountId: fixture.accountId,
        quoteId: fixture.quoteId,
        // Deliberately null. Drizzle's insert type would object if this were
        // written literally, so the value arrives through a cast: the point of
        // the test is what the database does, not what the types prevent.
        operationId: null as unknown as string,
        providerLabelId: 'lbl-none',
        providerShipmentId: 'shp-1',
        rateId: 'rate-standard',
        carrier: 'RoyalMail',
        service: 'Tracked48',
        trackingNumber: 'TRK-none',
        amount: '3.95',
        currency: 'GBP',
        purchasedAt: new Date(),
      }),
    );

    expect(message).toContain('operation_id');
  });

  it('keeps the operation from being deleted out from under it', async () => {
    const fixture = await seed();
    await buyLabel(fixture, 'lbl-6');

    const message = await refuses(() =>
      harness.db.delete(reviewedOperations).where(eq(reviewedOperations.id, fixture.operationId)),
    );

    expect(message).toContain('shipment_labels_operation_id_fkey');
  });
});

describe('packages', () => {
  it('refuses a package that claims to be shipped with nobody attached', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      harness.db
        .update(shipmentPackages)
        .set({ status: 'shipped', shippedAt: new Date() })
        .where(eq(shipmentPackages.id, fixture.packageId)),
    );

    expect(message).toContain('shipment_packages_shipped_is_recorded');
  });

  it('refuses a weightless parcel', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      harness.db.insert(shipmentPackages).values({
        businessId: fixture.businessId,
        orderId: fixture.orderId,
        locationId: fixture.locationId,
        weightGrams: 0,
      }),
    );

    expect(message).toContain('shipment_packages_weight_positive');
  });

  it("refuses a package holding another business's order line", async () => {
    const one = await seed();
    const two = await seed();

    const message = await refuses(() =>
      harness.db.insert(shipmentPackageLines).values({
        businessId: one.businessId,
        packageId: one.packageId,
        orderLineId: two.orderLineId,
        quantity: 1,
      }),
    );

    expect(message).toContain('shipment_package_lines_order_line_fkey');
  });

  it('refuses the same order line twice in one package', async () => {
    const fixture = await seed();

    await harness.db.insert(shipmentPackageLines).values({
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      orderLineId: fixture.orderLineId,
      quantity: 1,
    });

    const message = await refuses(() =>
      harness.db.insert(shipmentPackageLines).values({
        businessId: fixture.businessId,
        packageId: fixture.packageId,
        orderLineId: fixture.orderLineId,
        quantity: 1,
      }),
    );

    expect(message).toContain('shipment_package_lines_unique');
  });
});

describe('tracking', () => {
  it('stores one row per provider event, however often it arrives', async () => {
    const fixture = await seed();
    await buyLabel(fixture, 'lbl-7');

    const [label] = await harness.db
      .select()
      .from(shipmentLabels)
      .where(
        and(
          eq(shipmentLabels.businessId, fixture.businessId),
          eq(shipmentLabels.packageId, fixture.packageId),
        ),
      )
      .limit(1);

    const event = {
      businessId: fixture.businessId,
      labelId: label!.id,
      providerEventId: 'evt-1',
      status: 'in_transit' as const,
      occurredAt: new Date(),
    };

    await harness.db.insert(shipmentTrackingEvents).values(event);
    const message = await refuses(() => harness.db.insert(shipmentTrackingEvents).values(event));

    expect(message).toContain('shipment_tracking_events_unique');
  });
});
