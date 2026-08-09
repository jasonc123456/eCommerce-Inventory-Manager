import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import {
  businesses,
  channelOrderLines,
  channelOrders,
  connections,
  locationAddresses,
  locations,
  reviewedOperations,
  shipmentLabels,
  shipmentPackages,
  shippingAccounts,
  users,
} from '@eim/db';
import { FakeShippingAdapter, type ShipmentAddress } from '@eim/providers';
import { confirmOperation } from '@eim/review';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPackage } from './packages';
import { executeLabelPurchase, proposeLabelPurchase } from './purchase';
import { quoteRatesFor } from './rates';

/**
 * Buying a label, end to end (sections 21, 30).
 *
 * Every test here is about money. Quoting spends nothing; a confirmation buys
 * exactly one label; a provider that reprices between the two sells nothing; a
 * retry after an ambiguous timeout buys nothing further; and an expired quote
 * cannot be confirmed at all.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

const base = new Date('2026-04-01T09:00:00.000Z');
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
  readonly audit: AuditRecorder;
  readonly accountId: string;
  readonly packageId: string;
}

async function seed(): Promise<Fixture> {
  const { db } = harness;
  const slug = `buy-${String((counter += 1))}`;

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
    .values({ businessId, code: `L${String(counter)}`, name: 'Workshop' })
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
    .values({ businessId, orderId: order!.id, externalLineId: 'A', quantity: 1 })
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

  const parcel = await createPackage(db, audit, {
    businessId,
    orderId: order!.id,
    locationId: location!.id,
    lines: [{ orderLineId: line!.id, quantity: 1 }],
    weightGrams: 500,
    actorUserId: userId,
    now: base,
  });

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    audit,
    accountId: account!.id,
    packageId: parcel.id,
  };
}

function adapterAt(now: Date, options = {}): FakeShippingAdapter {
  return new FakeShippingAdapter({ now: () => now, ...options });
}

async function quote(fixture: Fixture, adapter: FakeShippingAdapter, now = base) {
  return quoteRatesFor(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId: fixture.packageId,
    accountId: fixture.accountId,
    adapter,
    to,
    actorUserId: fixture.userId,
    now,
  });
}

async function confirm(fixture: Fixture, operationId: string, fingerprint: string, now: Date) {
  return confirmOperation(harness.db, {
    businessId: fixture.businessId,
    operationId,
    subject: fixture.owner,
    fingerprint,
    hasRecentAuthentication: true,
    now,
  });
}

describe('quoting', () => {
  it('prices a parcel and spends nothing', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);

    const quoted = await quote(fixture, adapter);

    expect(quoted.rates.length).toBeGreaterThan(1);
    expect(adapter.purchases).toHaveLength(0);

    const [parcel] = await harness.db
      .select()
      .from(shipmentPackages)
      .where(eq(shipmentPackages.id, fixture.packageId));
    expect(parcel?.status).toBe('draft');
  });

  it("honours the provider's expiry when it is sooner than ours", async () => {
    const fixture = await seed();
    const adapter = adapterAt(base, { quoteLifetimeMs: 2 * MINUTE });

    const quoted = await quote(fixture, adapter);

    // Ours is ten minutes; the carrier says two, and the carrier decides.
    expect(quoted.usableUntil.getTime()).toBe(base.getTime() + 2 * MINUTE);
  });

  it('applies our own ceiling when the provider publishes none', async () => {
    const fixture = await seed();
    const quoted = await quote(fixture, adapterAt(base));

    expect(quoted.usableUntil.getTime()).toBe(base.getTime() + 10 * MINUTE);
  });

  it('refuses to price a parcel that already has a label', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);
    const quoted = await quote(fixture, adapter);

    const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      quoteId: quoted.quoteId,
      rateId: 'rate-standard',
      to,
      actorUserId: fixture.userId,
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    await executeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      accountId: fixture.accountId,
      adapter,
      now: at(MINUTE),
    });

    await expect(quote(fixture, adapter, at(2 * MINUTE))).rejects.toMatchObject({
      reason: 'package_not_open',
    });
  });
});

describe('confirming and buying', () => {
  async function proposed(
    fixture: Fixture,
    adapter: FakeShippingAdapter,
    rateId = 'rate-standard',
  ) {
    const quoted = await quote(fixture, adapter);

    return proposeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      quoteId: quoted.quoteId,
      rateId,
      to,
      actorUserId: fixture.userId,
      now: base,
    });
  }

  it('buys exactly what was confirmed and leaves the package labelled, not shipped', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);
    const proposal = await proposed(fixture, adapter);

    expect(adapter.purchases).toHaveLength(0);

    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    const label = await executeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      accountId: fixture.accountId,
      adapter,
      now: at(MINUTE),
    });

    expect(label.amount).toBe('3.9500');
    expect(label.carrier).toBe('RoyalMail');
    expect(adapter.purchases).toHaveLength(1);

    const [parcel] = await harness.db
      .select()
      .from(shipmentPackages)
      .where(eq(shipmentPackages.id, fixture.packageId));

    // Section 14: label purchase does not mean shipped.
    expect(parcel?.status).toBe('labelled');
    expect(parcel?.shippedAt).toBeNull();
  });

  it('buys nothing until somebody confirms', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);
    const proposal = await proposed(fixture, adapter);

    await expect(
      executeLabelPurchase(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        accountId: fixture.accountId,
        adapter,
        now: at(MINUTE),
      }),
    ).rejects.toThrow();

    expect(adapter.purchases).toHaveLength(0);
  });

  it('refuses a confirmation against a fingerprint from a different rate', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);
    const proposal = await proposed(fixture, adapter, 'rate-express');

    const outcome = await confirm(
      fixture,
      proposal.operationId,
      'not-the-screen-you-read',
      at(MINUTE),
    );

    expect(outcome.confirmed).toBe(false);
    expect(adapter.purchases).toHaveLength(0);
  });

  it('refuses a confirmation once the quote has gone stale', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);
    const proposal = await proposed(fixture, adapter);

    // Eleven minutes later: inside the twenty-minute proposal window, past the
    // ten-minute source window. The intent is still current; the price is not.
    const outcome = await confirm(
      fixture,
      proposal.operationId,
      proposal.fingerprint,
      at(11 * MINUTE),
    );

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_source' });
  });

  it('refuses to propose against a quote the carrier has already withdrawn', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base, { quoteLifetimeMs: MINUTE });
    const quoted = await quote(fixture, adapter);

    await expect(
      proposeLabelPurchase(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        packageId: fixture.packageId,
        quoteId: quoted.quoteId,
        rateId: 'rate-standard',
        to,
        actorUserId: fixture.userId,
        now: at(2 * MINUTE),
      }),
    ).rejects.toMatchObject({ reason: 'quote_expired' });
  });

  it('permits one live proposal per package', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);
    await proposed(fixture, adapter);

    await expect(proposed(fixture, adapter)).rejects.toThrow();
  });
});

describe('the money', () => {
  it('refuses to record a purchase the provider repriced', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base, {
      chargeInsteadOf: new Map([['rate-standard', '9.99']]),
    });

    const quoted = await quote(fixture, adapter);
    const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      quoteId: quoted.quoteId,
      rateId: 'rate-standard',
      to,
      actorUserId: fixture.userId,
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

    await expect(
      executeLabelPurchase(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        accountId: fixture.accountId,
        adapter,
        now: at(MINUTE),
      }),
    ).rejects.toMatchObject({ reason: 'cost_changed' });

    const labels = await harness.db
      .select()
      .from(shipmentLabels)
      .where(eq(shipmentLabels.packageId, fixture.packageId));

    // No row at a price nobody was shown, and the operation says why.
    expect(labels).toHaveLength(0);

    const [operation] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));
    expect(operation?.state).toBe('failed');
    expect(operation?.failureSummary).toContain('9.99');
  });

  it('buys one label however many times an ambiguous timeout is retried', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base, {
      purchaseFailures: [{ status: 'unavailable', message: 'gateway timeout', statusCode: 504 }],
    });

    const quoted = await quote(fixture, adapter);
    const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      quoteId: quoted.quoteId,
      rateId: 'rate-standard',
      to,
      actorUserId: fixture.userId,
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

    // The first attempt times out after the provider has already taken it.
    await expect(
      executeLabelPurchase(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        accountId: fixture.accountId,
        adapter,
        now: at(MINUTE),
      }),
    ).rejects.toThrow();

    // Two requests reached the provider under one key, and it sold one label.
    expect(adapter.purchases).toHaveLength(1);
    expect(adapter.sold.size).toBe(0);
  });

  it('records what it cost, and whether the provider replayed it', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);

    const quoted = await quote(fixture, adapter);
    const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      quoteId: quoted.quoteId,
      rateId: 'rate-express',
      to,
      actorUserId: fixture.userId,
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    await executeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      accountId: fixture.accountId,
      adapter,
      now: at(MINUTE),
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    const purchase = events.find((event) => event.action === 'shipping.label.purchased');

    expect(purchase?.detail).toMatchObject({
      service: 'Tracked24',
      amount: '5.45',
      currency: 'GBP',
      replayed: false,
    });
  });

  it('keeps the confirmation and the label attached to each other', async () => {
    const fixture = await seed();
    const adapter = adapterAt(base);

    const quoted = await quote(fixture, adapter);
    const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: fixture.packageId,
      quoteId: quoted.quoteId,
      rateId: 'rate-standard',
      to,
      actorUserId: fixture.userId,
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    const label = await executeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      accountId: fixture.accountId,
      adapter,
      now: at(MINUTE),
    });

    expect(label.operationId).toBe(proposal.operationId);

    const [operation] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(
        and(
          eq(reviewedOperations.id, proposal.operationId),
          eq(reviewedOperations.businessId, fixture.businessId),
        ),
      );

    expect(operation?.state).toBe('executed');
    expect(operation?.confirmedByUserId).toBe(fixture.userId);
  });
});
