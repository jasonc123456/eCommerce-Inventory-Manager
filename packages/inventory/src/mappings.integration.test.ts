import {
  businesses,
  channelMappingVersions,
  channelMappings,
  connections,
  providerItems,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCanonicalItem } from './items';
import { createLocation } from './locations';
import {
  approveMapping,
  archiveMapping,
  proposeMapping,
  readLiveMappings,
  readMapping,
  readMappingHistory,
  readMappingsForItem,
  reviseMapping,
} from './mappings';

/**
 * The mapping record: what a canonical item is sold as, and where (section 7).
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
  readonly connectionId: string;
  readonly canonicalItemId: string;
  readonly secondItemId: string;
  readonly providerItemId: string;
  readonly secondProviderItemId: string;
  readonly locationId: string;
  readonly otherLocationId: string;
  readonly userId: string;
}

async function seed(): Promise<Fixture> {
  const slug = `map-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Manager' })
    .returning({ id: users.id });
  const businessId = business!.id;

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `https://${slug}.example`,
      displayName: slug,
      status: 'active',
      connectedAt: new Date(),
    })
    .returning({ id: connections.id });
  const connectionId = connection!.id;

  const items = await harness.db
    .insert(providerItems)
    .values([
      {
        businessId,
        connectionId,
        externalId: `${slug}-101`,
        kind: 'product',
        sku: `${slug}-a`,
        inventoryEligible: true,
      },
      {
        businessId,
        connectionId,
        externalId: `${slug}-102`,
        kind: 'product',
        sku: `${slug}-b`,
        inventoryEligible: true,
      },
    ])
    .returning({ id: providerItems.id });

  const main = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const spare = await createLocation(harness.db, { businessId, code: 'SPARE', name: 'Spare' });
  const first = await createCanonicalItem(harness.db, {
    businessId,
    sku: `${slug}-1`,
    name: 'One',
  });
  const second = await createCanonicalItem(harness.db, {
    businessId,
    sku: `${slug}-2`,
    name: 'Two',
  });

  return {
    businessId,
    connectionId,
    userId: user!.id,
    providerItemId: items[0]!.id,
    secondProviderItemId: items[1]!.id,
    locationId: main.outcome === 'created' ? main.locationId : '',
    otherLocationId: spare.outcome === 'created' ? spare.locationId : '',
    canonicalItemId: first.outcome === 'created' ? first.canonicalItemId : '',
    secondItemId: second.outcome === 'created' ? second.canonicalItemId : '',
  };
}

async function propose(ref: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await proposeMapping(harness.db, {
    businessId: ref.businessId,
    connectionId: ref.connectionId,
    providerItemId: ref.providerItemId,
    canonicalItemId: ref.canonicalItemId,
    locationIds: [ref.locationId],
    createdByUserId: ref.userId,
    ...overrides,
  });

  return result.outcome === 'proposed' ? result.mappingId : '';
}

describe('proposing a mapping', () => {
  it('starts as a draft that has approved nothing', async () => {
    // Section 7: every mapping requires approval, and a new one synchronizes
    // nothing until it has been previewed and activated.
    const ref = await seed();
    const mappingId = await propose(ref);

    await expect(
      readMapping(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toMatchObject({ status: 'draft', version: 1, locationIds: [ref.locationId] });

    const [row] = await harness.db
      .select({ approvedAt: channelMappings.approvedAt })
      .from(channelMappings)
      .where(eq(channelMappings.id, mappingId));

    expect(row?.approvedAt).toBeNull();
  });

  it('records the first version', async () => {
    const ref = await seed();
    const mappingId = await propose(ref, { channelBuffer: 2, channelCap: 10 });

    await expect(
      readMappingHistory(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toMatchObject([{ version: 1, status: 'draft', channelBuffer: 2, channelCap: 10 }]);
  });

  it('refuses a second live mapping of one channel entity', async () => {
    // Section 7: a channel entity belongs to only one canonical item at a time.
    const ref = await seed();
    const first = await propose(ref);

    const second = await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: ref.providerItemId,
      canonicalItemId: ref.secondItemId,
      locationIds: [ref.locationId],
    });

    expect(second).toEqual({ outcome: 'entity_already_mapped', mappingId: first });
  });

  it('lets several channel entities share one canonical item', async () => {
    // The asymmetry is deliberate: one item may be sold in many places.
    const ref = await seed();

    await propose(ref);

    await expect(
      proposeMapping(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        providerItemId: ref.secondProviderItemId,
        canonicalItemId: ref.canonicalItemId,
        locationIds: [ref.locationId],
      }),
    ).resolves.toMatchObject({ outcome: 'proposed' });

    await expect(
      readMappingsForItem(harness.db, {
        businessId: ref.businessId,
        canonicalItemId: ref.canonicalItemId,
      }),
    ).resolves.toHaveLength(2);
  });

  it('refuses a mapping with no location', async () => {
    const ref = await seed();

    await expect(
      proposeMapping(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        providerItemId: ref.providerItemId,
        canonicalItemId: ref.canonicalItemId,
        locationIds: [],
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('refuses a location belonging to another business', async () => {
    const ref = await seed();
    const stranger = await seed();

    await expect(
      proposeMapping(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        providerItemId: ref.providerItemId,
        canonicalItemId: ref.canonicalItemId,
        locationIds: [stranger.locationId],
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('refuses a negative buffer or cap', async () => {
    const ref = await seed();

    await expect(
      proposeMapping(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        providerItemId: ref.providerItemId,
        canonicalItemId: ref.canonicalItemId,
        locationIds: [ref.locationId],
        channelCap: -1,
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

describe('approving a mapping', () => {
  it('records who decided and when', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await expect(
      approveMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        approvedByUserId: ref.userId,
        reason: 'checked against the store',
      }),
    ).resolves.toMatchObject({ outcome: 'approved', version: 2 });

    const [row] = await harness.db
      .select({
        status: channelMappings.status,
        approvedByUserId: channelMappings.approvedByUserId,
      })
      .from(channelMappings)
      .where(eq(channelMappings.id, mappingId));

    expect(row).toMatchObject({ status: 'approved', approvedByUserId: ref.userId });
  });

  it('does not approve the same mapping twice', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await approveMapping(harness.db, { businessId: ref.businessId, mappingId });

    await expect(
      approveMapping(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'not_approvable', status: 'approved' });
  });

  it('does not approve a mapping in another business', async () => {
    const ref = await seed();
    const stranger = await seed();
    const mappingId = await propose(ref);

    await expect(
      approveMapping(harness.db, { businessId: stranger.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('revising a mapping', () => {
  it('changes a buffer without pausing anything', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await approveMapping(harness.db, { businessId: ref.businessId, mappingId });

    await expect(
      reviseMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        channelBuffer: 5,
        reason: 'holding some back over the sale',
      }),
    ).resolves.toMatchObject({ outcome: 'revised', status: 'approved' });
  });

  it('pauses an active mapping that is repointed at a different item', async () => {
    // Section 7: affected synchronization pauses during reassignment. The next
    // write would otherwise advertise a different item's stock against the same
    // listing with nobody having seen the change.
    const ref = await seed();
    const mappingId = await propose(ref);

    await approveMapping(harness.db, { businessId: ref.businessId, mappingId });
    await harness.db
      .update(channelMappings)
      .set({ status: 'active', activatedAt: new Date() })
      .where(eq(channelMappings.id, mappingId));

    const revised = await reviseMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      canonicalItemId: ref.secondItemId,
      reason: 'mapped to the wrong item',
      actorUserId: ref.userId,
    });

    expect(revised).toMatchObject({ outcome: 'revised', status: 'paused' });

    const mapping = await readMapping(harness.db, { businessId: ref.businessId, mappingId });

    expect(mapping?.pauseReason).toMatch(/repointed/);
  });

  it('replaces the selected locations', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await reviseMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      locationIds: [ref.otherLocationId],
      reason: 'moved warehouses',
    });

    const mapping = await readMapping(harness.db, { businessId: ref.businessId, mappingId });

    expect(mapping?.locationIds).toEqual([ref.otherLocationId]);
  });

  it('refuses a change with no stated reason', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await expect(
      reviseMapping(harness.db, { businessId: ref.businessId, mappingId, reason: '  ' }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('leaves the mapping untouched when the change is refused', async () => {
    const ref = await seed();
    const stranger = await seed();
    const mappingId = await propose(ref);

    await reviseMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      locationIds: [stranger.locationId],
      reason: 'wrong warehouse',
    });

    const mapping = await readMapping(harness.db, { businessId: ref.businessId, mappingId });

    // The rollback covers the locations the revision had already replaced.
    expect(mapping).toMatchObject({ version: 1, locationIds: [ref.locationId] });
  });
});

describe('the version history', () => {
  it('keeps what the mapping used to point at', async () => {
    // Section 7: historical sales keep the mapping version active at purchase,
    // so the earlier version must still name the earlier item.
    const ref = await seed();
    const mappingId = await propose(ref);

    await approveMapping(harness.db, { businessId: ref.businessId, mappingId });
    await reviseMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      canonicalItemId: ref.secondItemId,
      reason: 'repointed',
    });

    const history = await readMappingHistory(harness.db, {
      businessId: ref.businessId,
      mappingId,
    });

    expect(history.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history.at(-1)?.canonicalItemId).toBe(ref.canonicalItemId);
    expect(history[0]?.canonicalItemId).toBe(ref.secondItemId);
  });

  it('refuses to be rewritten', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    const failure = await harness.db
      .update(channelMappingVersions)
      .set({ changeReason: 'a tidier story' })
      .where(eq(channelMappingVersions.mappingId, mappingId))
      .catch((error: unknown) => error);

    const messages: string[] = [];
    for (
      let current: unknown = failure, depth = 0;
      current instanceof Error && depth < 5;
      depth++
    ) {
      messages.push(current.message);
      current = current.cause;
    }

    expect(messages.join(' | ')).toMatch(/append-only/);
  });
});

describe('archiving a mapping', () => {
  it('frees the channel entity to be mapped again', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await expect(
      archiveMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        reason: 'no longer sold',
      }),
    ).resolves.toMatchObject({ outcome: 'archived' });

    await expect(
      proposeMapping(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        providerItemId: ref.providerItemId,
        canonicalItemId: ref.secondItemId,
        locationIds: [ref.locationId],
      }),
    ).resolves.toMatchObject({ outcome: 'proposed' });
  });

  it('keeps the archived mapping and its history', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await archiveMapping(harness.db, { businessId: ref.businessId, mappingId });

    await expect(
      readMapping(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toMatchObject({ status: 'archived' });
    await expect(
      readMappingHistory(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toHaveLength(2);
    await expect(
      readLiveMappings(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
      }),
    ).resolves.toEqual([]);
  });

  it('does not archive the same mapping twice', async () => {
    const ref = await seed();
    const mappingId = await propose(ref);

    await archiveMapping(harness.db, { businessId: ref.businessId, mappingId });

    await expect(
      archiveMapping(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});
