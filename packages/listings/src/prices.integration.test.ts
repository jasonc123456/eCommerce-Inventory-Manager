import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { businesses, reviewedOperations, users } from '@eim/db';
import { FakeChannelAdapter, type FakeAdapterOptions } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PriceCopyRefused,
  comparePrices,
  executePriceCopy,
  proposePriceCopy,
  type PriceSide,
} from './prices';
import { confirmOperation } from './review';

/**
 * One price, once (sections 4, 14, 30).
 *
 * Section 30's AC-10 is the checklist this file works through: "a one-time copy
 * requires permission, fee/currency impact, fresh source value, exact
 * confirmation, idempotency, and audit". Each of those is a way for the copy to
 * be refused, and the refusals are what the tests are about.
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
}

async function seed(): Promise<Fixture> {
  const slug = `price-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Pricer' })
    .returning({ id: users.id });

  const userId = user!.id;
  const businessId = business!.id;

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
  };
}

const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;

const entity = { externalId: 'ITEM-1' };

function adapter(options: FakeAdapterOptions = {}): FakeChannelAdapter {
  return new FakeChannelAdapter({
    listingOperations: true,
    initialPrices: new Map([['ITEM-1', { amount: '15.00', currency: 'GBP' }]]),
    ...options,
  });
}

const source: PriceSide = { label: 'eBay', amount: '12.50', currency: 'GBP' };

async function propose(
  fixture: Fixture,
  channel: FakeChannelAdapter,
  overrides: Partial<Parameters<typeof proposePriceCopy>[2]> = {},
) {
  return proposePriceCopy(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    source,
    destinationConnectionId: crypto.randomUUID(),
    destinationEntity: entity,
    destinationLabel: 'the shop',
    adapter: channel,
    actorUserId: fixture.userId,
    now: base,
    ...overrides,
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

describe('comparePrices', () => {
  it('shows the difference and how far apart the two are', () => {
    const comparison = comparePrices(source, {
      label: 'the shop',
      amount: '15.00',
      currency: 'GBP',
    });

    expect(comparison.difference).toBe('-2.50');
    expect(comparison.percentageDifference).toBe('-16.67');
    expect(comparison.identical).toBe(false);
    expect(comparison.currenciesMatch).toBe(true);
  });

  it('declines to subtract across currencies', () => {
    const comparison = comparePrices(source, {
      label: 'the shop',
      amount: '15.00',
      currency: 'USD',
    });

    expect(comparison.currenciesMatch).toBe(false);
    expect(comparison.difference).toBeUndefined();
    expect(comparison.warnings.join(' ')).toMatch(/different currencies/);
  });

  it('says when a sale price is already overriding the one being compared', () => {
    // Raising a regular price that a sale price is undercutting changes nothing
    // a customer sees, and somebody confirming that should know it.
    const comparison = comparePrices(source, {
      label: 'the shop',
      amount: '15.00',
      currency: 'GBP',
      salePriceAmount: '9.99',
    });

    expect(comparison.warnings.join(' ')).toMatch(/sale price of 9\.99/);
  });

  it('treats two spellings of one price as identical', () => {
    const comparison = comparePrices(
      { label: 'eBay', amount: '10.5', currency: 'GBP' },
      { label: 'the shop', amount: '10.50', currency: 'GBP' },
    );

    expect(comparison.identical).toBe(true);
  });
});

describe('proposePriceCopy', () => {
  it('reads the destination price now rather than trusting an import', async () => {
    const fixture = await seed();
    const channel = adapter();

    const proposal = await propose(fixture, channel);

    expect(channel.calls).toContain('readPrice');
    expect(proposal.comparison.destination.amount).toBe('15.00');
    expect(proposal.newAmount).toBe('12.50');
  });

  it('quotes what the change would cost', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, adapter());

    // AC-10's fee impact, shown before the confirmation rather than after it.
    expect(proposal.fees).toHaveLength(1);
    expect(proposal.totalFees).toBe('1.25');
  });

  it('refuses a copy that would change nothing', async () => {
    // A confirmation that changes nothing trains people to confirm without
    // reading, which is the failure this whole mechanism exists to prevent.
    const fixture = await seed();
    const channel = adapter({
      initialPrices: new Map([['ITEM-1', { amount: '12.50', currency: 'GBP' }]]),
    });

    await expect(propose(fixture, channel)).rejects.toThrow(/already what it would be changed to/);
  });

  it('refuses to copy a number across currencies', async () => {
    // Section 4: cross-currency changes require a manually entered amount.
    const fixture = await seed();
    const channel = adapter({
      initialPrices: new Map([['ITEM-1', { amount: '15.00', currency: 'USD' }]]),
    });

    await expect(propose(fixture, channel)).rejects.toThrow(/must be entered/);
  });

  it('accepts a typed amount when the currencies differ', async () => {
    const fixture = await seed();
    const channel = adapter({
      initialPrices: new Map([['ITEM-1', { amount: '15.00', currency: 'USD' }]]),
    });

    const proposal = await propose(fixture, channel, { destinationAmount: '16.40' });

    expect(proposal.newAmount).toBe('16.40');
    expect(proposal.comparison.currenciesMatch).toBe(false);
  });

  it('refuses a typed amount when the currencies match', async () => {
    // Otherwise a screen could quietly substitute a different number for the one
    // it was comparing.
    const fixture = await seed();

    await expect(propose(fixture, adapter(), { destinationAmount: '9.99' })).rejects.toThrow(
      /copied directly rather than typed/,
    );
  });

  it('refuses an amount that is not one', async () => {
    const fixture = await seed();
    const channel = adapter({
      initialPrices: new Map([['ITEM-1', { amount: '15.00', currency: 'USD' }]]),
    });

    await expect(propose(fixture, channel, { destinationAmount: '£16' })).rejects.toBeInstanceOf(
      PriceCopyRefused,
    );
  });

  it('demands change_prices and a recent authentication', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, adapter());

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    expect(row?.requiredPermission).toBe('change_prices');
    expect(row?.requiresRecentAuthentication).toBe(true);
  });

  it('refuses one proposal per listing at a time', async () => {
    const fixture = await seed();
    const channel = adapter();
    await propose(fixture, channel);

    // Four confirmable proposals for one listing is a recurring price change
    // assembled by hand.
    await expect(propose(fixture, channel, { now: at(MINUTE) })).rejects.toThrow();
  });
});

describe('confirming a price copy', () => {
  it('refuses once the channel price has moved underneath it', async () => {
    // Section 14: "external price edits refresh comparisons and are not
    // overwritten automatically." A confirmation from before the edit must not
    // undo it.
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);

    channel.setPriceOutOfBand(entity, '19.99', 'GBP');

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      // What a refreshed screen would send back.
      fingerprint: 'the fingerprint of a screen quoting 19.99',
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_preview' });
    expect(channel.priceOf(entity)).toEqual({ amount: '19.99', currency: 'GBP' });
  });

  it('refuses a read that has aged past five minutes', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, adapter());

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(6 * MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_source' });
  });

  it('refuses somebody who only holds change_prices over one connection', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, adapter());

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: {
        userId: fixture.userId,
        isOwner: false,
        grants: [
          { permission: 'change_prices', scope: { kind: 'connections', connectionIds: ['one'] } },
        ],
      },
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'not_permitted' });
  });
});

describe('executePriceCopy', () => {
  it('writes the confirmed price and records it', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);
    await confirm(fixture, proposal.operationId, proposal.fingerprint);

    const applied = await executePriceCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    expect(applied).toMatchObject({ amount: '12.50', currency: 'GBP', unchanged: false });
    expect(channel.priceOf(entity)).toEqual({ amount: '12.50', currency: 'GBP' });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    expect(events.map((event) => event.action)).toContain('listing.price.changed');
  });

  it('writes nothing without a confirmation', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);

    await expect(
      executePriceCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(PriceCopyRefused);
    expect(channel.priceWrites).toHaveLength(0);
    expect(channel.priceOf(entity)).toEqual({ amount: '15.00', currency: 'GBP' });
  });

  it('applies one confirmation once, however many times it is retried', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);
    await confirm(fixture, proposal.operationId, proposal.fingerprint);

    const run = async () =>
      executePriceCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      });

    await run();
    await expect(run()).rejects.toBeInstanceOf(PriceCopyRefused);
    expect(channel.priceWrites).toHaveLength(1);
  });

  it('records why the provider refused, and leaves the price alone', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);
    await confirm(fixture, proposal.operationId, proposal.fingerprint);

    channel.failNext({ status: 'rejected', message: 'below the minimum advertised price' });

    await expect(
      executePriceCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(PriceCopyRefused);

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    expect(row?.state).toBe('failed');
    expect(row?.failureSummary).toMatch(/rejected/);
    expect(channel.priceOf(entity)).toEqual({ amount: '15.00', currency: 'GBP' });
  });

  it('leaves no schedule behind once it has run', async () => {
    // The whole of section 3's exclusion of recurring price synchronization.
    // After the copy there is a settled row and nothing that could fire again.
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);
    await confirm(fixture, proposal.operationId, proposal.fingerprint);
    await executePriceCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    channel.setPriceOutOfBand(entity, '30.00', 'GBP');

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    expect(row?.state).toBe('executed');
    // Nothing re-applied the confirmed price over the external edit.
    expect(channel.priceOf(entity)).toEqual({ amount: '30.00', currency: 'GBP' });
    expect(channel.priceWrites).toHaveLength(1);
  });
});
