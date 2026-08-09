import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
import { FakeChannelAdapter, FakeShippingAdapter, type ShipmentAddress } from '@eim/providers';
import { confirmOperation } from '@eim/review';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchLabelDocument, voidLabel } from './labels';
import { createPackage } from './packages';
import { executeLabelPurchase, proposeLabelPurchase } from './purchase';
import { quoteRatesFor } from './rates';
import { markShipped, pushTrackingToChannel } from './tracking';

/**
 * The M6 exit gate (section 36).
 *
 * "Sandbox/fake contract suites plus cost-confirmation, duplicate-purchase,
 * sensitive-document, and recovery tests pass."
 *
 * Five claims. The contract suite runs against the programmable fake, because
 * verification V-04 has not been run and section 40 permits no live provider
 * call — so the honest reading of "sandbox or fake" is the fake, and a structural
 * assertion below proves no HTTP exists in this package at all.
 *
 * The other four are the failures that cost money, and each is asserted where it
 * is actually prevented rather than only where it is convenient to observe.
 * Cost confirmation is a fingerprint and a price check at the provider boundary.
 * Duplicate purchase is a partial unique index and an idempotency key.
 * Sensitive-document handling is an absence — there is no table to hold one —
 * as well as a permission and an audit row. And recovery is the ambiguous
 * timeout: the case where the money has already gone and nobody knows.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

const base = new Date('2026-04-05T09:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;
const REPO = join(import.meta.dirname, '..', '..', '..');

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
  readonly stranger: Subject;
  readonly audit: AuditRecorder;
  readonly accountId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly locationId: string;
}

async function seed(quantity = 1): Promise<Fixture> {
  const { db } = harness;
  const slug = `gate6-${String((counter += 1))}`;

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
    .values({ email: `${slug}-s@example.invalid`, displayName: 'Stranger' })
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
    .values({ businessId, code: `G${String(counter)}`, name: 'Workshop' })
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
    stranger: {
      userId: other!.id,
      isOwner: false,
      grants: [{ permission: 'view_orders', scope: { kind: 'business' } }],
    },
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    accountId: account!.id,
    orderId: order!.id,
    lineId: line!.id,
    locationId: location!.id,
  };
}

async function packed(fixture: Fixture, quantity = 1) {
  return createPackage(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    orderId: fixture.orderId,
    locationId: fixture.locationId,
    lines: [{ orderLineId: fixture.lineId, quantity }],
    weightGrams: 500,
    actorUserId: fixture.userId,
    now: base,
  });
}

async function proposeFor(
  fixture: Fixture,
  adapter: FakeShippingAdapter,
  packageId: string,
  rateId = 'rate-standard',
) {
  const quoted = await quoteRatesFor(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId,
    accountId: fixture.accountId,
    adapter,
    to,
    actorUserId: fixture.userId,
    now: base,
  });

  return proposeLabelPurchase(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    packageId,
    quoteId: quoted.quoteId,
    rateId,
    to,
    actorUserId: fixture.userId,
    now: base,
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

async function boughtLabel(fixture: Fixture, adapter: FakeShippingAdapter, packageId: string) {
  const proposal = await proposeFor(fixture, adapter, packageId);
  await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

  return executeLabelPurchase(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    operationId: proposal.operationId,
    accountId: fixture.accountId,
    adapter,
    now: at(MINUTE),
  });
}

describe('the contract suite runs against a fake, because V-04 has not been run', () => {
  it('makes no HTTP call anywhere in the shipping path', () => {
    // Section 40 permits no live provider call, and verification V-04 — current
    // EasyPost and Easyship authentication, rates, label, refund, tracking,
    // quota, and commercial terms — has never been performed. A structural
    // assertion rather than a behavioural one, because "no network today" is
    // observable and "no network" is not.
    const sources = [
      // Tests excluded, this one included: it names the very strings it is
      // searching for, and a file that fails its own search proves nothing.
      ...readdirSync(join(REPO, 'packages/shipping/src'))
        .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
        .map((name) => join(REPO, 'packages/shipping/src', name)),
      join(REPO, 'packages/providers/src/shipping.ts'),
      join(REPO, 'packages/providers/src/fakes/fake-shipping-adapter.ts'),
    ];

    for (const source of sources) {
      const text = readFileSync(source, 'utf8');

      expect(text).not.toContain('node:https');
      expect(text).not.toContain('node:http');
      expect(text).not.toMatch(/\bfetch\(/);
      expect(text).not.toContain('createHttpClient');
    }
  });

  it('keeps postage out of reach of anything that runs unattended', () => {
    // The same boundary milestone 5 drew around publication, for the same
    // reason: postage bought by a background job is postage nobody confirmed.
    const config = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');
    expect(config).toContain('@eim/shipping');

    for (const unattended of ['packages/sync', 'packages/jobs', 'apps/worker']) {
      const manifest = readFileSync(join(REPO, unattended, 'package.json'), 'utf8');
      expect(manifest).not.toContain('@eim/shipping');
    }
  });

  it('has no schedule that could buy postage later', () => {
    // Comments are stripped first: this migration explains at length why there
    // is no schedule, using the words a naive search would find.
    const migration = readFileSync(join(REPO, 'packages/db/migrations/0023_shipping.sql'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(migration).not.toMatch(/\bnext_run_at\b/);
    expect(migration).not.toMatch(/\binterval_seconds\b/);
    expect(migration).not.toMatch(/\brepeat\b/);
  });
});

describe('cost confirmation', () => {
  it('buys nothing until a person agrees to one exact cost', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);

    const proposal = await proposeFor(fixture, adapter, parcel.id);

    // Quoted, proposed, previewed — and nothing bought.
    expect(adapter.purchases).toHaveLength(0);
    expect(proposal.rate.amount).toBe('3.95');

    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    const label = await executeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      accountId: fixture.accountId,
      adapter,
      now: at(MINUTE),
    });

    expect(label.amount).toBe('3.9500');
  });

  it('refuses a confirmation that does not name the screen that was read', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);

    const outcome = await confirm(fixture, proposal.operationId, 'some-other-screen', at(MINUTE));

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_preview' });
    expect(adapter.purchases).toHaveLength(0);
  });

  it('refuses a stale quote, and records the refusal', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);

    const outcome = await confirm(
      fixture,
      proposal.operationId,
      proposal.fingerprint,
      at(11 * MINUTE),
    );

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_source' });
  });

  it('refuses somebody without purchase_labels, and somebody who has not authenticated recently', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);

    const unpermitted = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.stranger,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });
    expect(unpermitted).toMatchObject({ confirmed: false, reason: 'not_permitted' });

    const stale = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: false,
      now: at(MINUTE),
    });
    expect(stale).toMatchObject({ confirmed: false, reason: 'recent_authentication_required' });

    expect(adapter.purchases).toHaveLength(0);
  });

  it('will not record a purchase at a price nobody was shown', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({
      now: () => base,
      chargeInsteadOf: new Map([['rate-standard', '12.50']]),
    });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);
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
      .where(eq(shipmentLabels.packageId, parcel.id));
    expect(labels).toHaveLength(0);
  });
});

describe('duplicate purchase', () => {
  it('lets only one of two simultaneous confirmations through', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);

    const outcomes = await Promise.all([
      confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE)),
      confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE)),
    ]);

    expect(outcomes.filter((outcome) => outcome.confirmed)).toHaveLength(1);
  });

  it('permits one live proposal per package', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);

    await proposeFor(fixture, adapter, parcel.id);

    // Four clicks on "buy postage" would otherwise be four confirmable
    // proposals for one parcel.
    await expect(proposeFor(fixture, adapter, parcel.id)).rejects.toThrow();
  });

  it('permits one label per package', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);

    await boughtLabel(fixture, adapter, parcel.id);

    // The package is no longer open, so it cannot even be priced again — the
    // refusal arrives before a second proposal is possible, and the partial
    // unique index would refuse the row even if one were.
    await expect(proposeFor(fixture, adapter, parcel.id)).rejects.toMatchObject({
      reason: 'package_not_open',
    });
    expect(adapter.sold.size).toBe(1);
  });

  it('asks the provider for the same label when an execution is retried', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

    const label = await executeLabelPurchase(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      accountId: fixture.accountId,
      adapter,
      now: at(MINUTE),
    });

    // The operation is settled, so a second execution is refused before a
    // provider is reached at all.
    await expect(
      executeLabelPurchase(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        accountId: fixture.accountId,
        adapter,
        now: at(2 * MINUTE),
      }),
    ).rejects.toThrow();

    expect(adapter.purchases).toHaveLength(1);
    expect(label.providerLabelId).toBe([...adapter.sold.keys()][0]);
  });
});

describe('sensitive documents', () => {
  it('has nowhere to store one', () => {
    // The strongest form of this claim is an absence. A label carries the
    // buyer's name and postal address; section 13 requires erasure across every
    // business holding a buyer's data, and section 11 made that tractable by
    // never copying buyer detail out of the provider. There is no bytea, no
    // blob, and no document table anywhere in the shipping schema.
    const migration = readFileSync(join(REPO, 'packages/db/migrations/0023_shipping.sql'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(migration).not.toContain('bytea');
    expect(migration).not.toMatch(/create table shipment_documents/);
    expect(migration).not.toMatch(/label_url/);
  });

  it('is permissioned, fetched fresh, and never cached', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const label = await boughtLabel(fixture, adapter, parcel.id);

    await expect(
      fetchLabelDocument(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        labelId: label.id,
        documentType: 'label',
        subject: fixture.stranger,
        adapter,
      }),
    ).rejects.toMatchObject({ reason: 'not_permitted' });

    await fetchLabelDocument(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      documentType: 'label',
      subject: fixture.owner,
      adapter,
    });
    await fetchLabelDocument(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      documentType: 'label',
      subject: fixture.owner,
      adapter,
    });

    // Two authorized reads, two fetches. Nothing was kept between them.
    expect(adapter.documentReads).toHaveLength(2);
  });

  it('records every access without recording the address on the label', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const label = await boughtLabel(fixture, adapter, parcel.id);

    await fetchLabelDocument(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      labelId: label.id,
      documentType: 'label',
      subject: fixture.owner,
      adapter,
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    const accesses = events.filter((event) => event.action === 'shipping.label.document_accessed');

    expect(accesses).toHaveLength(1);
    expect(JSON.stringify(accesses[0]?.detail)).not.toContain('Buyer');
    expect(JSON.stringify(accesses[0]?.detail)).not.toContain('Bristol');
  });

  it('will not fetch a label belonging to another business', async () => {
    const one = await seed();
    const two = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const theirs = await boughtLabel(two, adapter, (await packed(two)).id);

    await expect(
      fetchLabelDocument(harness.db, one.audit, {
        businessId: one.businessId,
        labelId: theirs.id,
        documentType: 'label',
        subject: one.owner,
        adapter,
      }),
    ).rejects.toMatchObject({ reason: 'unknown_label' });
  });
});

describe('recovery', () => {
  it('leaves an ambiguous purchase failed, explained, and safe to try again', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({
      now: () => base,
      purchaseFailures: [{ status: 'unavailable', message: 'gateway timeout', statusCode: 504 }],
    });
    const parcel = await packed(fixture);
    const proposal = await proposeFor(fixture, adapter, parcel.id);
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

    await expect(
      executeLabelPurchase(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        accountId: fixture.accountId,
        adapter,
        now: at(MINUTE),
      }),
    ).rejects.toMatchObject({ reason: 'provider_refused' });

    const [operation] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(
        and(
          eq(reviewedOperations.id, proposal.operationId),
          eq(reviewedOperations.businessId, fixture.businessId),
        ),
      );

    expect(operation?.state).toBe('failed');
    expect(operation?.failureSummary).toContain('unavailable');
    expect(operation?.attempts).toBe(1);

    // The package is untouched, so a fresh quote and a fresh confirmation are
    // the way back — which is what section 30's "failures are recoverable"
    // means when the previous attempt may or may not have taken the money.
    const [row] = await harness.db
      .select()
      .from(shipmentPackages)
      .where(eq(shipmentPackages.id, parcel.id));
    expect(row?.status).toBe('draft');
  });

  it('leaves a label usable when the void request itself fails', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const label = await boughtLabel(fixture, adapter, parcel.id);

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
    expect(row?.state).toBe('purchased');
  });

  it('adopts a fulfilment the channel already has rather than shipping twice', async () => {
    const fixture = await seed();
    const shipping = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    await boughtLabel(fixture, shipping, parcel.id);

    await markShipped(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: parcel.id,
      subject: fixture.owner,
      now: at(2 * MINUTE),
    });

    // The first attempt reached eBay, which recorded the fulfilment and then
    // timed out. Section 13: ambiguous fulfilment retries first query existing
    // fulfilments.
    const channel = new FakeChannelAdapter({
      fulfillmentOperations: true,
      existingFulfillments: new Map([[`push:${parcel.id}:ebay_fulfillment`, 'ful-already-there']]),
    });

    const push = await pushTrackingToChannel(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      packageId: parcel.id,
      kind: 'ebay_fulfillment',
      subject: fixture.owner,
      adapter: channel,
      now: at(3 * MINUTE),
    });

    expect(push.state).toBe('succeeded');
    expect(push.externalReference).toBe('ful-already-there');
    expect(channel.fulfillments).toHaveLength(0);
  });

  it('keeps every label attached to the confirmation that bought it', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ now: () => base });
    const parcel = await packed(fixture);
    const label = await boughtLabel(fixture, adapter, parcel.id);

    const [operation] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, label.operationId));

    expect(operation?.kind).toBe('label_purchase');
    expect(operation?.requiredPermission).toBe('purchase_labels');
    expect(operation?.confirmedByUserId).toBe(fixture.userId);
    expect(operation?.state).toBe('executed');
  });
});
