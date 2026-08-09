import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import {
  businesses,
  channelOrderLines,
  channelOrders,
  connections,
  locationAddresses,
  locations,
  shipmentLabels,
  shipmentPackages,
  shippingAccounts,
  users,
} from '@eim/db';
import { FakeShippingAdapter, type ShipmentAddress } from '@eim/providers';
import { confirmOperation } from '@eim/review';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchLabelDocument, voidLabel } from './labels';
import { createPackage } from './packages';
import { executeLabelPurchase, proposeLabelPurchase } from './purchase';
import { quoteRatesFor } from './rates';

/**
 * What happens to a label after it has been bought (sections 2, 13, 19, 21).
 *
 * Two things are being proven. That a void only frees the package when the
 * carrier actually refunds — anything else leaves postage the business has paid
 * for, and buying a replacement would spend money twice. And that a label
 * document is permissioned, audited, and never stored, because it carries the
 * buyer's name and address and this application is built around not holding
 * those.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

const base = new Date('2026-04-02T09:00:00.000Z');
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
  readonly packageId: string;
}

async function seed(): Promise<Fixture> {
  const { db } = harness;
  const slug = `lbl-${String((counter += 1))}`;

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
    .values({ email: `${slug}-viewer@example.invalid`, displayName: 'Viewer' })
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
    .values({ businessId, code: `V${String(counter)}`, name: 'Workshop' })
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
    // A member with everything except the shipping permissions.
    viewer: {
      userId: other!.id,
      isOwner: false,
      grants: [{ permission: 'view_orders', scope: { kind: 'business' } }],
    },
    audit,
    accountId: account!.id,
    packageId: parcel.id,
  };
}

/** A package with a label on it, bought properly through the gate. */
async function labelled(fixture: Fixture, adapter: FakeShippingAdapter) {
  const quoted = await quoteRatesFor(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId: fixture.packageId,
    accountId: fixture.accountId,
    adapter,
    to,
    actorUserId: fixture.userId,
    now: base,
  });

  const proposal = await proposeLabelPurchase(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId: fixture.packageId,
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

  return executeLabelPurchase(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    operationId: proposal.operationId,
    accountId: fixture.accountId,
    adapter,
    now: at(MINUTE),
  });
}

describe('voiding', () => {
  it('returns the package to draft when the carrier refunds', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    const result = await voidLabel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      subject: fixture.owner,
      hasRecentAuthentication: true,
      adapter,
      now: at(2 * MINUTE),
    });

    expect(result.outcome).toBe('refunded');
    expect(result.label.state).toBe('voided');

    const [parcel] = await harness.db
      .select()
      .from(shipmentPackages)
      .where(eq(shipmentPackages.id, fixture.packageId));

    expect(parcel?.status).toBe('draft');
  });

  it('leaves a refused void holding the package, because the postage is still paid for', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({
      now: () => base,
      voidOutcome: { outcome: 'refused', detail: 'this service is not refundable' },
    });
    const label = await labelled(fixture, adapter);

    const result = await voidLabel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      subject: fixture.owner,
      hasRecentAuthentication: true,
      adapter,
      now: at(2 * MINUTE),
    });

    expect(result.outcome).toBe('refused');
    expect(result.label.state).toBe('void_refused');

    const [parcel] = await harness.db
      .select()
      .from(shipmentPackages)
      .where(eq(shipmentPackages.id, fixture.packageId));
    expect(parcel?.status).toBe('labelled');

    // And the package still cannot buy another label.
    const message = await refuses(() =>
      harness.db.insert(shipmentLabels).values({
        businessId: fixture.businessId,
        packageId: fixture.packageId,
        accountId: fixture.accountId,
        quoteId: label.quoteId,
        operationId: label.operationId,
        providerLabelId: 'lbl-second',
        providerShipmentId: label.providerShipmentId,
        rateId: label.rateId,
        carrier: label.carrier,
        service: label.service,
        trackingNumber: 'TRK-second',
        amount: '3.95',
        currency: 'GBP',
        purchasedAt: new Date(),
      }),
    );
    expect(message).toContain('shipment_labels_one_live_per_package');
  });

  it('records a pending refund as pending rather than as money returned', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({
      now: () => base,
      voidOutcome: { outcome: 'requested', detail: 'the carrier will confirm within 14 days' },
    });
    const label = await labelled(fixture, adapter);

    const result = await voidLabel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      subject: fixture.owner,
      hasRecentAuthentication: true,
      adapter,
      now: at(2 * MINUTE),
    });

    expect(result.outcome).toBe('requested');
    expect(result.label.state).toBe('void_requested');
    expect(result.label.refundAmount).toBeNull();

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    const actions = events.map((event) => event.action);

    expect(actions).toContain('shipping.label.void_requested');
    // Nothing has been refunded, so nothing says it has.
    expect(actions).not.toContain('shipping.label.voided');
  });

  it('refuses a provider that does not void at all', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({
      now: () => base,
      capabilities: { supportsVoid: false },
    });
    const label = await labelled(fixture, adapter);

    await expect(
      voidLabel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        subject: fixture.owner,
        hasRecentAuthentication: true,
        adapter,
        now: at(2 * MINUTE),
      }),
    ).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('refuses somebody without the permission, and somebody who has not authenticated recently', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    await expect(
      voidLabel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        subject: fixture.viewer,
        hasRecentAuthentication: true,
        adapter,
      }),
    ).rejects.toMatchObject({ reason: 'not_permitted' });

    await expect(
      voidLabel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        subject: fixture.owner,
        hasRecentAuthentication: false,
        adapter,
      }),
    ).rejects.toMatchObject({ reason: 'recent_authentication_required' });

    expect(adapter.voids).toHaveLength(0);
  });

  it('will not void the same label twice', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    const request = async () =>
      voidLabel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        subject: fixture.owner,
        hasRecentAuthentication: true,
        adapter,
        now: at(2 * MINUTE),
      });

    await request();
    await expect(request()).rejects.toMatchObject({ reason: 'already_settled' });
  });

  it('leaves the label usable when the void call itself fails', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    // The void request never reaches a carrier that agreed to anything.
    const failing = new FakeShippingAdapter({
      now: () => base,
      failures: [{ status: 'unavailable', message: 'gateway down', statusCode: 503 }],
    });

    await expect(
      voidLabel(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        subject: fixture.owner,
        hasRecentAuthentication: true,
        adapter: failing,
        now: at(2 * MINUTE),
      }),
    ).rejects.toMatchObject({ reason: 'provider_refused' });

    const [row] = await harness.db
      .select()
      .from(shipmentLabels)
      .where(eq(shipmentLabels.id, label.id));

    // Back to purchased rather than stuck pending, which would leave the label
    // unusable and unreplaceable at the same time.
    expect(row?.state).toBe('purchased');
  });
});

describe('the document', () => {
  it('is fetched, handed over, and not kept', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    const document = await fetchLabelDocument(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      documentType: 'label',
      subject: fixture.owner,
      adapter,
    });

    expect(document.contentType).toBe('application/pdf');
    expect(document.bytes.byteLength).toBeGreaterThan(0);

    // Asking again fetches again. Nothing was cached, and there is nowhere it
    // could have been cached to.
    await fetchLabelDocument(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      documentType: 'label',
      subject: fixture.owner,
      adapter,
    });

    expect(adapter.documentReads).toHaveLength(2);
  });

  it('records who looked at it, without recording who it is addressed to', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    await fetchLabelDocument(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      documentType: 'label',
      subject: fixture.owner,
      adapter,
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    const access = events.find((event) => event.action === 'shipping.label.document_accessed');

    expect(access?.actorUserId).toBe(fixture.userId);
    expect(JSON.stringify(access?.detail)).not.toContain('Buyer');
    expect(JSON.stringify(access?.detail)).not.toContain('Bristol');
  });

  it('refuses somebody without view_shipments', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const label = await labelled(fixture, adapter);

    await expect(
      fetchLabelDocument(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        documentType: 'label',
        subject: fixture.viewer,
        adapter,
      }),
    ).rejects.toMatchObject({ reason: 'not_permitted' });

    expect(adapter.documentReads).toHaveLength(0);
  });

  it("will not fetch another business's label through this one's account", async () => {
    const one = await seed();
    const two = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const theirs = await labelled(two, adapter);

    await expect(
      fetchLabelDocument(harness.db, one.audit, {
        businessId: one.businessId,
        labelId: theirs.id,
        documentType: 'label',
        subject: one.owner,
        adapter,
      }),
    ).rejects.toMatchObject({ reason: 'unknown_label' });

    // The provider was never asked, which is the point: an identifier from
    // elsewhere must not become a request on this business's shipping account.
    expect(adapter.documentReads).toHaveLength(0);
  });
});
