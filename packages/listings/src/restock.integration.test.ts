import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { businesses, connections, providerItems, reviewedOperations, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  proposeMapping,
} from '@eim/inventory';
import { FakeChannelAdapter, type FakeAdapterOptions } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RestockRefused, executeRestockToLive, proposeRestockToLive } from './restock';
import { confirmOperation } from './review';

/**
 * Returning a hidden listing to sale (sections 6, 7, 13, 30).
 *
 * The stock figure is the most volatile thing this application holds, which is
 * why the interesting assertions are about the confirmation going stale: a
 * quantity read five minutes ago may already be somebody else's order, and a
 * confirmation against it must be refused rather than applied.
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
  readonly mappingId: string;
  readonly canonicalItemId: string;
  readonly connectionId: string;
}

/**
 * A real activated mapping, not a made-up identifier.
 *
 * The operation table's foreign key insists on one, and rightly: an operation
 * pointing at a mapping that does not exist is an operation nobody can trace
 * back to an item, a connection, or a reason it was allowed.
 */
async function seed(): Promise<Fixture> {
  const slug = `restock-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Stockkeeper' })
    .returning({ id: users.id });

  const userId = user!.id;
  const businessId = business!.id;

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `acct-${slug}`,
      displayName: 'Test seller',
      status: 'active',
    })
    .returning({ id: connections.id });
  const connectionId = connection!.id;

  const location = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const locationId = location.outcome === 'created' ? location.locationId : '';

  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });
  const canonicalItemId = item.outcome === 'created' ? item.canonicalItemId : '';

  const [providerItem] = await harness.db
    .insert(providerItems)
    .values({
      businessId,
      connectionId,
      externalId: `listing-${slug}`,
      title: 'Widget',
      kind: 'listing',
      inventoryEligible: true,
      quantity: 0,
    })
    .returning({ id: providerItems.id });

  const proposed = await proposeMapping(harness.db, {
    businessId,
    connectionId,
    canonicalItemId,
    providerItemId: providerItem!.id,
    locationIds: [locationId],
    createdByUserId: userId,
  });
  const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

  await approveMapping(harness.db, { businessId, mappingId, approvedByUserId: userId });
  await activateMapping(harness.db, { businessId, mappingId, actorUserId: userId });

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    mappingId,
    canonicalItemId,
    connectionId,
  };
}

const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;

const entity = { externalId: 'LISTING-1' };

function adapter(options: FakeAdapterOptions = {}): FakeChannelAdapter {
  return new FakeChannelAdapter({
    listingOperations: true,
    initialQuantities: new Map([['LISTING-1', 0]]),
    listingStates: new Map([['LISTING-1', 'out_of_stock']]),
    ...options,
  });
}

async function propose(
  fixture: Fixture,
  channel: FakeChannelAdapter,
  overrides: Partial<Parameters<typeof proposeRestockToLive>[2]> = {},
) {
  return proposeRestockToLive(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    mappingId: fixture.mappingId,
    canonicalItemId: fixture.canonicalItemId,
    connectionId: fixture.connectionId,
    entity,
    adapter: channel,
    availableToSell: 6,
    mappingStatus: 'active',
    actorUserId: fixture.userId,
    now: base,
    ...overrides,
  });
}

describe('proposeRestockToLive', () => {
  it('asks the provider what the listing is before deciding anything', async () => {
    // Nothing on this side can tell a hidden listing from an ended one.
    const fixture = await seed();
    const channel = adapter();

    const proposal = await propose(fixture, channel);

    expect(channel.calls).toContain('readListingState');
    expect(proposal.quantity).toBe(6);
  });

  it('refuses an ended listing without touching it', async () => {
    const fixture = await seed();
    const channel = adapter({ listingStates: new Map([['LISTING-1', 'ended']]) });

    await expect(propose(fixture, channel)).rejects.toThrow(/relisting is a separate decision/);
    expect(channel.calls).not.toContain('restockToLive');
  });

  it('refuses when the seller never enabled out-of-stock control', async () => {
    const fixture = await seed();
    const channel = adapter({ outOfStockControlEnabled: false });

    await expect(propose(fixture, channel)).rejects.toBeInstanceOf(RestockRefused);
  });

  it('refuses a paused mapping', async () => {
    // A mapping was paused for a reason, and this is the write that reason was
    // meant to prevent.
    const fixture = await seed();

    await expect(propose(fixture, adapter(), { mappingStatus: 'paused' })).rejects.toThrow(
      /only an active mapping/,
    );
  });

  it('demands a publication permission and a recent authentication', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, adapter());

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    // This changes what the public can buy, not what a number says.
    expect(row?.requiredPermission).toBe('publish_listings');
    expect(row?.requiresRecentAuthentication).toBe(true);
  });
});

describe('confirming a restock', () => {
  it('refuses a confirmation more than five minutes after the read', async () => {
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

  it('expires the proposal entirely after ten', async () => {
    const fixture = await seed();
    const proposal = await propose(fixture, adapter());

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(11 * MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'expired' });
  });
});

describe('executeRestockToLive', () => {
  async function confirmed(fixture: Fixture, channel: FakeChannelAdapter) {
    const proposal = await propose(fixture, channel);
    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });
    if (!outcome.confirmed) {
      throw new Error(`expected a confirmation, got ${outcome.reason}`);
    }
    return proposal;
  }

  it('puts the listing back on sale at the confirmed quantity', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await confirmed(fixture, channel);

    const applied = await executeRestockToLive(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    expect(applied).toEqual({ quantity: 6, state: 'active' });
    expect(channel.quantityOf(entity)).toBe(6);

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    expect(events.map((event) => event.action)).toContain('listing.restocked_to_live');
  });

  it('does nothing without a confirmation', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await propose(fixture, channel);

    await expect(
      executeRestockToLive(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(RestockRefused);
    expect(channel.quantityOf(entity)).toBe(0);
  });

  it('refuses when the listing moved between the confirmation and the write', async () => {
    // The version read at proposal time is sent as the expected version, so a
    // listing somebody else changed produces a conflict rather than an
    // overwrite of a state nobody looked at.
    const fixture = await seed();
    const channel = adapter();
    const proposal = await confirmed(fixture, channel);

    channel.setQuantityOutOfBand(entity, 2);

    await expect(
      executeRestockToLive(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toThrow(/changed during the write/);

    const [row] = await harness.db
      .select({ state: reviewedOperations.state })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));
    expect(row?.state).toBe('failed');
  });

  it('runs once per confirmation', async () => {
    const fixture = await seed();
    const channel = adapter();
    const proposal = await confirmed(fixture, channel);

    const run = async () =>
      executeRestockToLive(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      });

    await run();
    await expect(run()).rejects.toBeInstanceOf(RestockRefused);
    expect(channel.calls.filter((call) => call === 'restockToLive')).toHaveLength(1);
  });
});
