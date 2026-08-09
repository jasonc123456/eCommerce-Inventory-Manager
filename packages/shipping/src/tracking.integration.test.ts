import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import {
  businesses,
  channelOrderLines,
  channelOrders,
  connections,
  locationAddresses,
  locations,
  shipmentChannelPushes,
  shipmentTrackingEvents,
  shippingAccounts,
  users,
} from '@eim/db';
import { FakeChannelAdapter, FakeShippingAdapter, type ShipmentAddress } from '@eim/providers';
import { confirmOperation } from '@eim/review';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPackage } from './packages';
import { executeLabelPurchase, proposeLabelPurchase } from './purchase';
import { quoteRatesFor } from './rates';
import { everythingShipped, markShipped, pushTrackingToChannel, recordTracking } from './tracking';

/**
 * From a scan to the customer's order page (sections 13, 14).
 *
 * The claims under test: a scan reported twice is stored once, a label is not a
 * shipment, a partially shipped order does not get completed, and a fulfilment
 * retried after an ambiguous timeout adopts the one the channel already has
 * rather than shipping the order twice.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

const base = new Date('2026-04-03T09:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;

const to: ShipmentAddress = {
  name: 'A Buyer',
  line1: '2 Buyer Street',
  city: 'Bristol',
  postcode: 'BS1 1AA',
  country: 'GB',
};

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly owner: Subject;
  readonly viewer: Subject;
  readonly audit: AuditRecorder;
  readonly accountId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly locationId: string;
}

async function seed(quantity = 1): Promise<Fixture> {
  const { db } = harness;
  const slug = `trk-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Packer' })
    .returning({ id: users.id });
  const [other] = await db
    .insert(users)
    .values({ email: `${slug}-v@example.invalid`, displayName: 'Viewer' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;
  const audit = createAuditRecorder({ actor: { kind: 'user', userId }, businessId });

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
    .values({ businessId, code: `T${String(counter)}`, name: 'Workshop' })
    .returning({ id: locations.id });

  await db.insert(locationAddresses).values({
    businessId,
    locationId: location!.id,
    purpose: 'ship_from',
    name: 'DIY Geeks',
    line1: '1 Workshop Way',
    city: 'Leeds',
    postalCode: 'LS1 1AA',
    countryCode: 'GB',
  });

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
    .values({ businessId, orderId: order!.id, externalLineId: 'A', quantity })
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

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    viewer: {
      userId: other!.id,
      isOwner: false,
      grants: [{ permission: 'view_shipments', scope: { kind: 'business' } }],
    },
    audit,
    accountId: account!.id,
    orderId: order!.id,
    lineId: line!.id,
    locationId: location!.id,
  };
}

/** A labelled package holding `quantity` of the order's only line. */
async function labelledPackage(
  fixture: Fixture,
  shipping: FakeShippingAdapter,
  quantity = 1,
): Promise<{ packageId: string; labelId: string }> {
  const parcel = await createPackage(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    orderId: fixture.orderId,
    locationId: fixture.locationId,
    lines: [{ orderLineId: fixture.lineId, quantity }],
    weightGrams: 500,
    actorUserId: fixture.userId,
    now: base,
  });

  const quoted = await quoteRatesFor(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId: parcel.id,
    accountId: fixture.accountId,
    adapter: shipping,
    to,
    actorUserId: fixture.userId,
    now: base,
  });

  const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId: parcel.id,
    quoteId: quoted.quoteId,
    rateId: 'rate-standard',
    to,
    actorUserId: fixture.userId,
    now: base,
  });

  await confirmOperation(harness.db, {
    businessId: fixture.businessId,
    operationId: proposal.operationId,
    subject: fixture.owner,
    fingerprint: proposal.fingerprint,
    hasRecentAuthentication: true,
    now: at(MINUTE),
  });

  const label = await executeLabelPurchase(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    operationId: proposal.operationId,
    accountId: fixture.accountId,
    adapter: shipping,
    now: at(MINUTE),
  });

  return { packageId: parcel.id, labelId: label.id };
}

describe('recording what the carrier says', () => {
  it('stores a scan once, however often it is reported', async () => {
    const fixture = await seed();
    const shipping = new FakeShippingAdapter({ now: () => base });
    const { labelId } = await labelledPackage(fixture, shipping);

    const first = await recordTracking(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId,
      adapter: shipping,
    });
    const second = await recordTracking(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId,
      adapter: shipping,
    });

    expect(first.recorded).toBe(1);
    // A poll and a webhook carrying the same scan are one event.
    expect(second.recorded).toBe(0);

    const stored = await harness.db
      .select()
      .from(shipmentTrackingEvents)
      .where(eq(shipmentTrackingEvents.labelId, labelId));
    expect(stored).toHaveLength(1);
  });

  it('refuses a provider that does not report tracking', async () => {
    const fixture = await seed();
    const shipping = new FakeShippingAdapter({ now: () => base });
    const { labelId } = await labelledPackage(fixture, shipping);

    const silent = new FakeShippingAdapter({
      now: () => base,
      capabilities: { supportsTracking: false },
    });

    await expect(
      recordTracking(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId,
        adapter: silent,
      }),
    ).rejects.toMatchObject({ reason: 'unsupported' });
  });
});

describe('marking shipped', () => {
  it('is a separate act from buying the label', async () => {
    const fixture = await seed();
    const shipping = new FakeShippingAdapter({ now: () => base });
    const { packageId } = await labelledPackage(fixture, shipping);

    const parcel = await markShipped(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      subject: fixture.owner,
      now: at(2 * MINUTE),
    });

    expect(parcel.status).toBe('shipped');
    expect(parcel.shippedByUserId).toBe(fixture.userId);

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    expect(events.map((event) => event.action)).toContain('shipping.package.shipped');
  });

  it('refuses a package with no label, and one already shipped', async () => {
    const fixture = await seed(2);
    const shipping = new FakeShippingAdapter({ now: () => base });

    const unlabelled = await createPackage(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      orderId: fixture.orderId,
      locationId: fixture.locationId,
      lines: [{ orderLineId: fixture.lineId, quantity: 1 }],
      weightGrams: 300,
      actorUserId: fixture.userId,
      now: base,
    });

    await expect(
      markShipped(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId: unlabelled.id,
        subject: fixture.owner,
      }),
    ).rejects.toMatchObject({ reason: 'not_labelled' });

    const { packageId } = await labelledPackage(fixture, shipping, 1);
    await markShipped(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      subject: fixture.owner,
      now: at(MINUTE),
    });

    await expect(
      markShipped(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId,
        subject: fixture.owner,
      }),
    ).rejects.toMatchObject({ reason: 'not_labelled' });
  });

  it('refuses somebody without mark_shipped', async () => {
    const fixture = await seed();
    const shipping = new FakeShippingAdapter({ now: () => base });
    const { packageId } = await labelledPackage(fixture, shipping);

    await expect(
      markShipped(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId,
        subject: fixture.viewer,
      }),
    ).rejects.toMatchObject({ reason: 'not_permitted' });
  });
});

describe('telling the channel', () => {
  async function shipped(
    fixture: Fixture,
    quantity = 1,
    // One adapter across several parcels, because a real provider does not
    // restart its label numbering for each new instance.
    shipping = new FakeShippingAdapter({ now: () => base }),
  ) {
    const { packageId } = await labelledPackage(fixture, shipping, quantity);

    await markShipped(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      subject: fixture.owner,
      now: at(2 * MINUTE),
    });

    return packageId;
  }

  it('creates one fulfilment carrying the tracking number', async () => {
    const fixture = await seed();
    const packageId = await shipped(fixture);
    const channel = new FakeChannelAdapter({ fulfillmentOperations: true });

    const push = await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      kind: 'ebay_fulfillment',
      subject: fixture.owner,
      adapter: channel,
      now: at(3 * MINUTE),
    });

    expect(push.state).toBe('succeeded');
    expect(channel.fulfillments).toHaveLength(1);
    expect(channel.fulfillments[0]?.trackingNumber).toMatch(/^TRK/);
    expect(channel.fulfillments[0]?.lines).toEqual([{ externalLineId: 'A', quantity: 1 }]);
  });

  it('adopts a fulfilment the channel already has rather than creating a second', async () => {
    const fixture = await seed();
    const packageId = await shipped(fixture);

    // The first attempt reached eBay, which recorded it and then timed out
    // before answering. Section 13: query existing fulfilments first.
    const channel = new FakeChannelAdapter({
      fulfillmentOperations: true,
      existingFulfillments: new Map([[`push:${packageId}:ebay_fulfillment`, 'ful-existing']]),
    });

    const push = await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      kind: 'ebay_fulfillment',
      subject: fixture.owner,
      adapter: channel,
      now: at(3 * MINUTE),
    });

    expect(push.state).toBe('succeeded');
    expect(push.externalReference).toBe('ful-existing');
    expect(channel.fulfillments).toHaveLength(0);
  });

  it('leaves a successful push alone when it is asked for again', async () => {
    const fixture = await seed();
    const packageId = await shipped(fixture);
    const channel = new FakeChannelAdapter({ fulfillmentOperations: true });

    await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      kind: 'ebay_fulfillment',
      subject: fixture.owner,
      adapter: channel,
      now: at(3 * MINUTE),
    });
    await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      kind: 'ebay_fulfillment',
      subject: fixture.owner,
      adapter: channel,
      now: at(4 * MINUTE),
    });

    const pushes = await harness.db
      .select()
      .from(shipmentChannelPushes)
      .where(eq(shipmentChannelPushes.packageId, packageId));

    expect(pushes).toHaveLength(1);
    expect(channel.fulfillments).toHaveLength(1);
  });

  it('writes tracking into a customer-visible note, not into plugin metadata', async () => {
    const fixture = await seed();
    const packageId = await shipped(fixture);
    const channel = new FakeChannelAdapter({
      provider: 'woocommerce',
      fulfillmentOperations: true,
    });

    await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      kind: 'woocommerce_order_note',
      subject: fixture.owner,
      adapter: channel,
      now: at(3 * MINUTE),
    });

    expect(channel.orderNotes[0]?.customerVisible).toBe(true);
    expect(channel.orderNotes[0]?.note).toContain('Tracking number');
  });

  it('completes an order only once every quantity has shipped', async () => {
    const fixture = await seed(2);
    const channel = new FakeChannelAdapter({
      provider: 'woocommerce',
      fulfillmentOperations: true,
    });

    const shipping = new FakeShippingAdapter({ now: () => base });
    const first = await shipped(fixture, 1, shipping);
    expect(
      await everythingShipped(harness.db, {
        businessId: fixture.businessId,
        orderId: fixture.orderId,
      }),
    ).toBe(false);

    await expect(
      pushTrackingToChannel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId: first,
        kind: 'woocommerce_status',
        subject: fixture.owner,
        adapter: channel,
        now: at(3 * MINUTE),
      }),
    ).rejects.toMatchObject({ reason: 'not_all_shipped' });

    const second = await shipped(fixture, 1, shipping);
    const push = await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: second,
      kind: 'woocommerce_status',
      subject: fixture.owner,
      adapter: channel,
      now: at(4 * MINUTE),
    });

    expect(push.state).toBe('succeeded');
    expect(channel.statusChanges).toHaveLength(1);
    expect(channel.statusChanges[0]).toContain(':completed');
  });

  it('records a channel that cannot be told as unsupported rather than failed', async () => {
    const fixture = await seed();
    const packageId = await shipped(fixture);
    // No fulfilment operations at all.
    const channel = new FakeChannelAdapter();

    const push = await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId,
      kind: 'ebay_fulfillment',
      subject: fixture.owner,
      adapter: channel,
      now: at(3 * MINUTE),
    });

    expect(push.state).toBe('unsupported');
    expect(push.failureSummary).toContain('cannot be told');
  });

  it('will not report a package nobody has marked shipped', async () => {
    const fixture = await seed();
    const shipping = new FakeShippingAdapter({ now: () => base });
    const { packageId } = await labelledPackage(fixture, shipping);
    const channel = new FakeChannelAdapter({ fulfillmentOperations: true });

    await expect(
      pushTrackingToChannel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId,
        kind: 'ebay_fulfillment',
        subject: fixture.owner,
        adapter: channel,
      }),
    ).rejects.toMatchObject({ reason: 'not_labelled' });

    expect(channel.fulfillments).toHaveLength(0);
  });

  it('refuses somebody without manage_tracking', async () => {
    const fixture = await seed();
    const packageId = await shipped(fixture);
    const channel = new FakeChannelAdapter({ fulfillmentOperations: true });

    await expect(
      pushTrackingToChannel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId,
        kind: 'ebay_fulfillment',
        subject: fixture.viewer,
        adapter: channel,
      }),
    ).rejects.toMatchObject({ reason: 'not_permitted' });

    expect(channel.fulfillments).toHaveLength(0);
  });
});
