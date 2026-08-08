import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { businesses, connections, mirroredOrders, reviewedOperations, users } from '@eim/db';
import { FakeChannelAdapter, type FakeAdapterOptions } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OrderCopyRefused,
  executeOrderCopy,
  proposeOrderCopy,
  type OrderCopySubject,
} from './order-copy';
import { confirmOperation } from './review';
import type { SuppressionTechnique } from './suppression';

/**
 * Copying one eBay order into a shop (section 11).
 *
 * Two facts about the copy are worth more than everything else here: it must not
 * reduce the store's own stock, and it must not become a second canonical sale
 * when it comes back through the order pipeline as an ordinary webhook. The
 * first is a gate that is currently closed on every WooCommerce version because
 * verification V-03 has not been run; the second is a row written before the
 * provider is called.
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
  readonly owner: Subject;
  readonly audit: AuditRecorder;
  readonly sourceConnectionId: string;
  readonly destinationConnectionId: string;
}

async function seed(): Promise<Fixture> {
  const slug = `copy-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Fulfiller' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  const [ebay] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `ebay-${slug}`,
      displayName: 'Seller',
      status: 'active',
    })
    .returning({ id: connections.id });
  const [store] = await harness.db
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

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    sourceConnectionId: ebay!.id,
    destinationConnectionId: store!.id,
  };
}

const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;

/** A technique V-03 has been run for, so the flow beyond the gate is reachable. */
const proven: readonly SuppressionTechnique[] = [
  {
    name: 'mark_order_stock_reduced',
    minimumVersion: '8.0.0',
    verified: true,
    evidence: 'a verification this test is standing in for',
  },
];

function subject(fixture: Fixture, overrides: Partial<OrderCopySubject> = {}): OrderCopySubject {
  return {
    sourceOrderId: `EBAY-${String((counter += 1))}`,
    sourceConnectionId: fixture.sourceConnectionId,
    fulfilled: false,
    currency: 'GBP',
    lines: [
      {
        sourceLineId: 'L1',
        sku: 'HOSE-BRASS-1',
        name: 'Brass garden hose fitting',
        quantity: 2,
        unitAmount: '12.50',
        totalAmount: '25.00',
        taxAmount: '5.00',
      },
    ],
    shippingAmount: '3.99',
    taxAmount: '5.00',
    totalAmount: '33.99',
    billing: { firstName: 'A', lastName: 'Buyer', city: 'Leeds', country: 'GB' },
    shipping: { firstName: 'A', lastName: 'Buyer', city: 'Leeds', country: 'GB' },
    placedAt: base,
    ...overrides,
  };
}

function adapter(options: FakeAdapterOptions = {}): FakeChannelAdapter {
  return new FakeChannelAdapter({ provider: 'woocommerce', listingOperations: true, ...options });
}

async function propose(fixture: Fixture, overrides: Partial<OrderCopySubject> = {}) {
  return proposeOrderCopy(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    subject: subject(fixture, overrides),
    destinationConnectionId: fixture.destinationConnectionId,
    destinationWooVersion: '9.4.2',
    actorUserId: fixture.userId,
    techniques: proven,
    sourceObservedAt: base,
    now: base,
  });
}

async function confirm(fixture: Fixture, operationId: string, fingerprint: string) {
  const outcome = await confirmOperation(harness.db, {
    businessId: fixture.businessId,
    operationId,
    subject: fixture.owner,
    fingerprint,
    hasRecentAuthentication: true,
    now: at(MINUTE),
  });
  if (!outcome.confirmed) {
    throw new Error(`expected a confirmation, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

describe('proposeOrderCopy', () => {
  it('refuses on the shipped catalogue, because V-03 has not been run', async () => {
    // The default path, and the one that is live today: no technique is
    // verified, so the action is unavailable rather than shipping a known
    // double decrement.
    const fixture = await seed();

    await expect(
      proposeOrderCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        subject: subject(fixture),
        destinationConnectionId: fixture.destinationConnectionId,
        destinationWooVersion: '9.4.2',
        actorUserId: fixture.userId,
        sourceObservedAt: base,
        now: base,
      }),
    ).rejects.toThrow(/V-03/);
  });

  it('refuses a store whose version is unknown', async () => {
    const fixture = await seed();

    await expect(
      proposeOrderCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        subject: subject(fixture),
        destinationConnectionId: fixture.destinationConnectionId,
        destinationWooVersion: null,
        actorUserId: fixture.userId,
        techniques: proven,
        sourceObservedAt: base,
        now: base,
      }),
    ).rejects.toThrow(/not known/);
  });

  it('maps an unshipped paid order to processing and a fulfilled one to completed', async () => {
    const fixture = await seed();

    expect((await propose(fixture)).status).toBe('processing');
    expect((await propose(fixture, { fulfilled: true })).status).toBe('completed');
  });

  it('puts every line and both addresses inside what is agreed to', async () => {
    // Section 11 requires the reviewer to see all customer, address, line,
    // amount, tax, shipping, and status data. A fingerprint over the total alone
    // would let two lines swap quantities without the agreement noticing.
    const fixture = await seed();
    const first = await propose(fixture, { sourceOrderId: 'EBAY-FIXED' });
    const second = await proposeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      subject: subject(fixture, {
        sourceOrderId: 'EBAY-FIXED-2',
        lines: [
          {
            sourceLineId: 'L1',
            sku: 'HOSE-BRASS-1',
            name: 'Brass garden hose fitting',
            quantity: 3,
            unitAmount: '12.50',
            totalAmount: '25.00',
            taxAmount: '5.00',
          },
        ],
      }),
      destinationConnectionId: fixture.destinationConnectionId,
      destinationWooVersion: '9.4.2',
      actorUserId: fixture.userId,
      techniques: proven,
      sourceObservedAt: base,
      now: base,
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('demands the copy permission', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);

    const [row] = await harness.db
      .select({ permission: reviewedOperations.requiredPermission })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    expect(row?.permission).toBe('copy_ebay_order_to_woocommerce');
  });

  it('says what the copy will and will not do', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);
    const warnings = proposal.warnings.join(' ');

    expect(warnings).toMatch(/moves no stock/);
    expect(warnings).toMatch(/will not be emailed/);
    expect(warnings).toMatch(/stock reduction will be suppressed/);
  });
});

describe('executeOrderCopy', () => {
  async function confirmed(fixture: Fixture) {
    const proposal = await propose(fixture);
    await confirm(fixture, proposal.operationId, proposal.fingerprint);
    return proposal;
  }

  it('writes the order with an eBay payment label and no customer email', async () => {
    const fixture = await seed();
    const proposal = await confirmed(fixture);
    const channel = adapter();

    const copied = await executeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    expect(copied.destinationOrderId).toBe('WC-1');
    const written = channel.mirroredOrders[0];
    expect(written?.paymentMethodTitle).toBe('eBay');
    expect(written?.suppressCustomerEmail).toBe(true);
    expect(written?.status).toBe('processing');
    expect(written?.suppressStockReduction).toBe('mark_order_stock_reduced');
  });

  it('carries the original identifiers onto the copy', async () => {
    const fixture = await seed();
    const proposal = await confirmed(fixture);
    const channel = adapter();

    await executeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    const written = channel.mirroredOrders[0];
    expect(written?.metadata['_eim_source_provider']).toBe('ebay');
    expect(written?.metadata['_eim_source_order_id']).toBeDefined();
    expect(written?.lines[0]?.sourceLineId).toBe('L1');
  });

  it('records the mirror so the pipeline cannot sell the goods twice', async () => {
    const fixture = await seed();
    const proposal = await confirmed(fixture);
    const channel = adapter();

    await executeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    const [mirror] = await harness.db
      .select()
      .from(mirroredOrders)
      .where(eq(mirroredOrders.operationId, proposal.operationId));

    expect(mirror?.destinationExternalOrderId).toBe('WC-1');
    expect(mirror?.suppressionConfirmed).toBe(true);
    expect(mirror?.destinationConnectionId).toBe(fixture.destinationConnectionId);
  });

  it('fails loudly when the store reduced its own stock anyway', async () => {
    // Section 11 would rather the action were unavailable than leave this in
    // place, so the failure names the order somebody now has to correct.
    const fixture = await seed();
    const proposal = await confirmed(fixture);
    const channel = adapter({ canSuppressStockReduction: false });

    await expect(
      executeOrderCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toThrow(/did not suppress its own stock reduction/);

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    expect(row?.state).toBe('failed');
    expect(row?.failureSummary).toMatch(/one sale too low/);
  });

  it('leaves a traceable record when the copy fails halfway', async () => {
    // The mirror row is written before the provider call, so a failure leaves a
    // row naming no destination order — honest, and findable.
    const fixture = await seed();
    const proposal = await confirmed(fixture);
    const channel = adapter();
    channel.failNext({ status: 'unavailable', message: 'the store did not answer' });

    await expect(
      executeOrderCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(OrderCopyRefused);

    const [mirror] = await harness.db
      .select()
      .from(mirroredOrders)
      .where(eq(mirroredOrders.operationId, proposal.operationId));

    expect(mirror).toBeDefined();
    expect(mirror?.destinationExternalOrderId).toBeNull();
    expect(mirror?.suppressionConfirmed).toBe(false);
  });

  it('copies nothing without a confirmation', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture);
    const channel = adapter();

    await expect(
      executeOrderCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(OrderCopyRefused);
    expect(channel.mirroredOrders).toHaveLength(0);
  });

  it('will not copy the same order into the same store twice', async () => {
    const fixture = await seed();
    const proposal = await confirmed(fixture);
    const channel = adapter();

    await executeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    const preview = (
      await harness.db
        .select({ preview: reviewedOperations.preview })
        .from(reviewedOperations)
        .where(eq(reviewedOperations.id, proposal.operationId))
    )[0]?.preview as { source: { orderId: string } };

    await expect(propose(fixture, { sourceOrderId: preview.source.orderId })).rejects.toThrow(
      /already been copied/,
    );
  });

  it('records who copied what', async () => {
    const fixture = await seed();
    const proposal = await confirmed(fixture);

    await executeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: adapter(),
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    const copied = events.find((event) => event.action === 'order.copied_to_woocommerce');

    expect(copied).toBeDefined();
    expect(copied?.actorUserId).toBe(fixture.userId);
    expect(copied?.detail).toMatchObject({ destinationOrderId: 'WC-1', status: 'processing' });
  });
});
