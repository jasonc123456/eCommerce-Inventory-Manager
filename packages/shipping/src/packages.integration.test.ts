import { createAuditRecorder, type AuditRecorder } from '@eim/audit';
import {
  businesses,
  channelOrderLines,
  channelOrders,
  connections,
  locationAddresses,
  locations,
  shipmentPackageLines,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PackageRefused,
  availabilityFor,
  cancelPackage,
  createPackage,
  shipFromAddress,
} from './packages';

/**
 * Building parcels out of orders (sections 9, 11, 14).
 *
 * The rule under test is the one that costs a shop money when it fails: a
 * package can only hold what the order has left to ship. Getting it wrong sends
 * the same item twice, and the second one is a loss nobody notices until the
 * customer says so.
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
  readonly audit: AuditRecorder;
  readonly orderId: string;
  readonly lineId: string;
  readonly secondLineId: string;
  readonly locationId: string;
}

async function seed(quantity = 4): Promise<Fixture> {
  const { db } = harness;
  const slug = `pkg-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: slug, slug })
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
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `store-${slug}`,
      displayName: 'Shop',
      status: 'active',
    })
    .returning({ id: connections.id });

  const [location] = await db
    .insert(locations)
    .values({ businessId, code: `L${String(counter)}`, name: 'Workshop' })
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
    .values({ businessId, orderId: order!.id, externalLineId: 'A', quantity })
    .returning({ id: channelOrderLines.id });
  const [second] = await db
    .insert(channelOrderLines)
    .values({ businessId, orderId: order!.id, externalLineId: 'B', quantity: 1 })
    .returning({ id: channelOrderLines.id });

  return {
    businessId,
    userId,
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    orderId: order!.id,
    lineId: line!.id,
    secondLineId: second!.id,
    locationId: location!.id,
  };
}

async function pack(fixture: Fixture, quantity: number, lineId = fixture.lineId) {
  return createPackage(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    orderId: fixture.orderId,
    locationId: fixture.locationId,
    lines: [{ orderLineId: lineId, quantity }],
    weightGrams: 400,
    actorUserId: fixture.userId,
  });
}

describe('what may go in a box', () => {
  it('splits one line across several packages until it runs out', async () => {
    const fixture = await seed(4);

    await pack(fixture, 3);
    await pack(fixture, 1);

    const availability = await availabilityFor(harness.db, fixture.businessId, fixture.orderId);
    const line = availability.find((entry) => entry.orderLineId === fixture.lineId);

    expect(line?.packed).toBe(4);
    expect(line?.remaining).toBe(0);
  });

  it('refuses more than the line has left', async () => {
    const fixture = await seed(4);
    await pack(fixture, 3);

    await expect(pack(fixture, 2)).rejects.toMatchObject({
      name: 'PackageRefused',
      reason: 'quantity_not_available',
    });
  });

  it('does not count cancelled or refunded quantities as shippable', async () => {
    const fixture = await seed(5);

    await harness.db
      .update(channelOrderLines)
      .set({ cancelledQuantity: 2, refundedQuantity: 1 })
      .where(eq(channelOrderLines.id, fixture.lineId));

    const availability = await availabilityFor(harness.db, fixture.businessId, fixture.orderId);
    const line = availability.find((entry) => entry.orderLineId === fixture.lineId);

    expect(line?.remaining).toBe(2);
    await expect(pack(fixture, 3)).rejects.toBeInstanceOf(PackageRefused);
    await expect(pack(fixture, 2)).resolves.toBeDefined();
  });

  it('gives back what a cancelled package was holding', async () => {
    const fixture = await seed(2);
    const parcel = await pack(fixture, 2);

    await cancelPackage(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: parcel.id,
    });

    const availability = await availabilityFor(harness.db, fixture.businessId, fixture.orderId);
    expect(availability.find((entry) => entry.orderLineId === fixture.lineId)?.remaining).toBe(2);
  });

  it('counts a draft package, because somebody is already filling it', async () => {
    const fixture = await seed(2);
    await pack(fixture, 2);

    // Not labelled, not shipped — and its contents are still spoken for.
    await expect(pack(fixture, 1)).rejects.toMatchObject({ reason: 'quantity_not_available' });
  });

  it('refuses an empty package and a fractional quantity', async () => {
    const fixture = await seed();

    await expect(
      createPackage(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        orderId: fixture.orderId,
        locationId: fixture.locationId,
        lines: [],
        weightGrams: 100,
        actorUserId: fixture.userId,
      }),
    ).rejects.toMatchObject({ reason: 'no_lines' });

    await expect(pack(fixture, 1.5)).rejects.toMatchObject({
      reason: 'quantity_not_available',
    });
  });

  it('refuses a line that belongs to a different order', async () => {
    const one = await seed();
    const two = await seed();

    await expect(pack(one, 1, two.lineId)).rejects.toMatchObject({ reason: 'unknown_line' });
  });

  it('holds several lines in one package', async () => {
    const fixture = await seed(2);

    const parcel = await createPackage(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      orderId: fixture.orderId,
      locationId: fixture.locationId,
      lines: [
        { orderLineId: fixture.lineId, quantity: 2 },
        { orderLineId: fixture.secondLineId, quantity: 1 },
      ],
      weightGrams: 900,
      actorUserId: fixture.userId,
    });

    const contents = await harness.db
      .select()
      .from(shipmentPackageLines)
      .where(eq(shipmentPackageLines.packageId, parcel.id));

    expect(contents).toHaveLength(2);
  });
});

describe('two benches packing one order', () => {
  it('lets only one of two simultaneous packages take the last unit', async () => {
    const fixture = await seed(1);

    const outcomes = await Promise.allSettled([pack(fixture, 1), pack(fixture, 1)]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');

    // Without the row lock both transactions would read "one left" and both
    // would put it in a box, and the shop would send the same item twice.
    expect(fulfilled).toHaveLength(1);
  });
});

describe('where a parcel ships from', () => {
  it('refuses a location with no ship-from address', async () => {
    const fixture = await seed();

    await expect(
      shipFromAddress(harness.db, fixture.businessId, fixture.locationId),
    ).rejects.toMatchObject({ reason: 'location_unusable' });
  });

  it('names the missing field rather than calling the address incomplete', async () => {
    const fixture = await seed();

    await harness.db.insert(locationAddresses).values({
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      purpose: 'ship_from',
      name: 'DIY Geeks',
      line1: '1 Workshop Way',
      city: 'Leeds',
      countryCode: 'GB',
    });

    await expect(
      shipFromAddress(harness.db, fixture.businessId, fixture.locationId),
    ).rejects.toThrow(/postal code/);
  });

  it('returns an address a carrier can use', async () => {
    const fixture = await seed();

    await harness.db.insert(locationAddresses).values({
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      purpose: 'ship_from',
      name: 'DIY Geeks',
      line1: '1 Workshop Way',
      city: 'Leeds',
      postalCode: 'LS1 1AA',
      countryCode: 'GB',
    });

    await expect(
      shipFromAddress(harness.db, fixture.businessId, fixture.locationId),
    ).resolves.toMatchObject({ line1: '1 Workshop Way', postcode: 'LS1 1AA', country: 'GB' });
  });

  it('refuses an archived location', async () => {
    const fixture = await seed();

    await harness.db
      .update(locations)
      .set({ isActive: false })
      .where(eq(locations.id, fixture.locationId));

    await expect(pack(fixture, 1)).rejects.toMatchObject({ reason: 'location_unusable' });
  });
});
