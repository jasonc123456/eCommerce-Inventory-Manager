import { businesses, channelMappings, connections, providerItems, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activateMapping,
  assessVariationCompleteness,
  pauseIncompleteVariationListings,
  pauseMapping,
  previewActivation,
  resolveWriteTarget,
  writableMappingsForItem,
} from './activation';
import { createCanonicalItem } from './items';
import { postMovements, readTimeline } from './ledger';
import { createLocation } from './locations';
import { approveMapping, archiveMapping, proposeMapping } from './mappings';
import { updateSettings } from './settings';

/**
 * Activation and the write gate (sections 6, 7, 8, 36).
 *
 * The last describe block is the one that matters most: section 36's exit gate
 * for this milestone is that no provider write can occur without an eligible
 * approved mapping, and `resolveWriteTarget` is the only function that answers
 * the question.
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
  readonly providerItemId: string;
  readonly locationId: string;
  readonly otherLocationId: string;
  readonly userId: string;
  readonly slug: string;
}

async function seed(
  itemOverrides: { readonly quantity?: number | null; readonly eligible?: boolean } = {},
): Promise<Fixture> {
  const slug = `act-${String((counter += 1))}`;

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

  const [item] = await harness.db
    .insert(providerItems)
    .values({
      businessId,
      connectionId,
      externalId: `${slug}-1`,
      kind: 'product',
      sku: slug,
      quantity: itemOverrides.quantity === undefined ? null : itemOverrides.quantity,
      inventoryEligible: itemOverrides.eligible ?? true,
      ineligibleReason:
        itemOverrides.eligible === false
          ? 'this product does not manage stock in WooCommerce'
          : null,
    })
    .returning({ id: providerItems.id });

  const main = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const spare = await createLocation(harness.db, { businessId, code: 'SPARE', name: 'Spare' });
  const canonical = await createCanonicalItem(harness.db, {
    businessId,
    sku: slug,
    name: 'Widget',
  });

  return {
    businessId,
    connectionId,
    slug,
    userId: user!.id,
    providerItemId: item!.id,
    locationId: main.outcome === 'created' ? main.locationId : '',
    otherLocationId: spare.outcome === 'created' ? spare.locationId : '',
    canonicalItemId: canonical.outcome === 'created' ? canonical.canonicalItemId : '',
  };
}

async function approvedMapping(
  ref: Fixture,
  overrides: { readonly locationIds?: readonly string[]; readonly channelCap?: number } = {},
): Promise<string> {
  const proposed = await proposeMapping(harness.db, {
    businessId: ref.businessId,
    connectionId: ref.connectionId,
    providerItemId: ref.providerItemId,
    canonicalItemId: ref.canonicalItemId,
    locationIds: overrides.locationIds ?? [ref.locationId],
    ...(overrides.channelCap === undefined ? {} : { channelCap: overrides.channelCap }),
  });
  const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

  await approveMapping(harness.db, {
    businessId: ref.businessId,
    mappingId,
    approvedByUserId: ref.userId,
  });

  return mappingId;
}

async function stock(ref: Fixture, quantity: number, locationId = ref.locationId): Promise<void> {
  await harness.db.transaction(async (tx) => {
    await postMovements(tx, {
      businessId: ref.businessId,
      movements: [
        {
          canonicalItemId: ref.canonicalItemId,
          locationId,
          kind: 'receipt',
          quantityDelta: quantity,
        },
      ],
    });
  });
}

describe('the activation preview', () => {
  it('computes the outbound target the way the projection will', async () => {
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 2 });
    await stock(ref, 10);
    const mappingId = await approvedMapping(ref, { channelCap: 5 });

    const result = await previewActivation(harness.db, {
      businessId: ref.businessId,
      mappingId,
    });

    expect(result).toMatchObject({
      outcome: 'previewed',
      preview: {
        // 10 on hand, 2 withheld per location, capped at 5.
        availableToSell: 8,
        channelCap: 5,
        outboundTarget: 5,
        blockers: [],
      },
    });
  });

  it('sums each location after its own safety stock', async () => {
    // Section 9, D-132: withholding once at the total would advertise units no
    // single location can supply.
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 2 });
    await stock(ref, 3);
    await stock(ref, 3, ref.otherLocationId);
    const mappingId = await approvedMapping(ref, {
      locationIds: [ref.locationId, ref.otherLocationId],
    });

    const result = await previewActivation(harness.db, { businessId: ref.businessId, mappingId });

    // (3 - 2) + (3 - 2), not (6 - 2).
    expect(result).toMatchObject({ preview: { availableToSell: 2 } });
  });

  it('blocks on an entity the provider cannot hold inventory for', async () => {
    const ref = await seed({ eligible: false });

    const mappingId = await approvedMapping(ref);
    const result = await previewActivation(harness.db, { businessId: ref.businessId, mappingId });

    expect(result).toMatchObject({
      preview: { ineligibleReason: expect.stringContaining('does not manage stock') },
    });
    expect(result.outcome === 'previewed' ? result.preview.blockers : []).toHaveLength(1);
  });

  it('blocks while the store and the ledger disagree', async () => {
    // Section 7: quantity disagreements block activation until resolved.
    const ref = await seed({ quantity: 4 });

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, 10);
    const mappingId = await approvedMapping(ref);

    const result = await previewActivation(harness.db, { businessId: ref.businessId, mappingId });

    expect(result).toMatchObject({
      preview: { channelQuantity: 4, outboundTarget: 10, quantitiesDisagree: true },
    });
  });

  it('stops blocking once the caller says which figure to believe', async () => {
    const ref = await seed({ quantity: 4 });

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, 10);
    const mappingId = await approvedMapping(ref);

    const result = await previewActivation(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });

    expect(result).toMatchObject({ preview: { quantitiesDisagree: false, blockers: [] } });
  });

  it('blocks on a channel entity a complete scan did not find', async () => {
    const ref = await seed();

    await harness.db
      .update(providerItems)
      .set({ missingSince: new Date() })
      .where(eq(providerItems.id, ref.providerItemId));

    const mappingId = await approvedMapping(ref);
    const result = await previewActivation(harness.db, { businessId: ref.businessId, mappingId });

    expect(result).toMatchObject({ preview: { missing: true } });
  });

  it('reports nothing for a mapping in another business', async () => {
    const ref = await seed();
    const stranger = await seed();
    const mappingId = await approvedMapping(ref);

    await expect(
      previewActivation(harness.db, { businessId: stranger.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('strict variation completeness', () => {
  async function withVariations(
    ref: Fixture,
    count: number,
  ): Promise<{ readonly ids: string[]; readonly parentExternalId: string }> {
    const parentExternalId = `${ref.slug}-parent`;
    const rows = await harness.db
      .insert(providerItems)
      .values(
        Array.from({ length: count }, (_unused, index) => ({
          businessId: ref.businessId,
          connectionId: ref.connectionId,
          externalId: `${parentExternalId}-v${String(index)}`,
          parentExternalId,
          kind: 'variation' as const,
          sku: `${ref.slug}-v${String(index)}`,
          inventoryEligible: true,
        })),
      )
      .returning({ id: providerItems.id });

    return { ids: rows.map((row) => row.id), parentExternalId };
  }

  it('counts the siblings that have no mapping', async () => {
    const ref = await seed();
    const { ids, parentExternalId } = await withVariations(ref, 3);

    await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: ids[0]!,
      canonicalItemId: ref.canonicalItemId,
      locationIds: [ref.locationId],
    });

    await expect(
      assessVariationCompleteness(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        parentExternalId,
      }),
    ).resolves.toMatchObject({ total: 3, mapped: 1 });
  });

  it('blocks activation while a sibling is unmapped', async () => {
    // Section 7: a variation listing synchronizes in full or not at all. Half a
    // listing is worse than none of it.
    const ref = await seed();
    const { ids } = await withVariations(ref, 2);

    const proposed = await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: ids[0]!,
      canonicalItemId: ref.canonicalItemId,
      locationIds: [ref.locationId],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

    await approveMapping(harness.db, { businessId: ref.businessId, mappingId });

    const activated = await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });

    expect(activated).toMatchObject({ outcome: 'blocked' });
    expect(activated.outcome === 'blocked' ? activated.blockers.join(' ') : '').toMatch(
      /variations on this listing are not mapped/,
    );
  });

  it('pauses the whole listing when a new variation appears', async () => {
    const ref = await seed();
    const { ids, parentExternalId } = await withVariations(ref, 2);
    const mappingIds: string[] = [];

    // Every sibling is mapped and approved before any of them is activated. The
    // first activation would otherwise be blocked by the second variation being
    // unmapped, which is section 7 working rather than a fixture problem.
    for (const providerItemId of ids) {
      const item = await createCanonicalItem(harness.db, {
        businessId: ref.businessId,
        sku: `${ref.slug}-${providerItemId.slice(0, 8)}`,
        name: 'Variation',
      });
      const proposed = await proposeMapping(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        providerItemId,
        canonicalItemId: item.outcome === 'created' ? item.canonicalItemId : '',
        locationIds: [ref.locationId],
      });
      const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

      await approveMapping(harness.db, { businessId: ref.businessId, mappingId });
      mappingIds.push(mappingId);
    }

    for (const mappingId of mappingIds) {
      await expect(
        activateMapping(harness.db, {
          businessId: ref.businessId,
          mappingId,
          initialization: { from: 'canonical' },
        }),
      ).resolves.toMatchObject({ outcome: 'activated' });
    }

    // An import discovers a third variation nobody has mapped.
    await harness.db.insert(providerItems).values({
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      externalId: `${parentExternalId}-v2`,
      parentExternalId,
      kind: 'variation',
      sku: `${ref.slug}-v2`,
      inventoryEligible: true,
    });

    const result = await pauseIncompleteVariationListings(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
    });

    expect(new Set(result.paused)).toEqual(new Set(mappingIds));

    for (const mappingId of mappingIds) {
      await expect(
        resolveWriteTarget(harness.db, { businessId: ref.businessId, mappingId }),
      ).resolves.toMatchObject({ outcome: 'not_active', status: 'paused' });
    }
  });

  it('ignores a sibling the provider says cannot be synchronized', async () => {
    // Not a gap an operator can close, so not a reason to hold the listing.
    const ref = await seed();
    const { ids, parentExternalId } = await withVariations(ref, 2);

    await harness.db
      .update(providerItems)
      .set({ inventoryEligible: false, ineligibleReason: 'stock is managed at the parent' })
      .where(eq(providerItems.id, ids[1]!));

    await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: ids[0]!,
      canonicalItemId: ref.canonicalItemId,
      locationIds: [ref.locationId],
    });

    await expect(
      assessVariationCompleteness(harness.db, {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        parentExternalId,
      }),
    ).resolves.toMatchObject({ total: 1, mapped: 1, unmapped: [] });
  });
});

describe('activating', () => {
  it('refuses a mapping nobody approved', async () => {
    // Section 7's rule, and the reason the exit gate is checkable: a draft
    // cannot become writable by any path through this module.
    const ref = await seed();
    const proposed = await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: ref.providerItemId,
      canonicalItemId: ref.canonicalItemId,
      locationIds: [ref.locationId],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

    await expect(
      activateMapping(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'not_approved', status: 'draft' });
  });

  it('adopts the store figure as a ledger adjustment, not a silent balance', async () => {
    // Section 8 has no path by which stock changes without an entry explaining
    // it, and "the store said so at activation" is that explanation.
    const ref = await seed({ quantity: 7 });

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, 2);
    const mappingId = await approvedMapping(ref);

    await expect(
      activateMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        initialization: { from: 'channel' },
        actorUserId: ref.userId,
      }),
    ).resolves.toMatchObject({ outcome: 'activated', outboundTarget: 7 });

    const timeline = await readTimeline(harness.db, {
      businessId: ref.businessId,
      canonicalItemId: ref.canonicalItemId,
    });

    expect(timeline[0]).toMatchObject({
      kind: 'adjustment',
      quantityDelta: 5,
      reason: expect.stringContaining('adopted from the channel'),
    });
  });

  it('records a figure an operator counted themselves', async () => {
    const ref = await seed({ quantity: 7 });

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 0 });
    await stock(ref, 2);
    const mappingId = await approvedMapping(ref);

    await expect(
      activateMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        initialization: { from: 'explicit', quantity: 4 },
      }),
    ).resolves.toMatchObject({ outcome: 'activated', outboundTarget: 4 });
  });

  it('will not guess which location a single figure belongs at', async () => {
    const ref = await seed({ quantity: 7 });
    const mappingId = await approvedMapping(ref, {
      locationIds: [ref.locationId, ref.otherLocationId],
    });

    await expect(
      activateMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        initialization: { from: 'channel' },
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('leaves the mapping alone when activation is refused', async () => {
    const ref = await seed({ eligible: false });
    const mappingId = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });

    const [row] = await harness.db
      .select({ status: channelMappings.status, version: channelMappings.version })
      .from(channelMappings)
      .where(eq(channelMappings.id, mappingId));

    expect(row).toMatchObject({ status: 'approved', version: 2 });
  });

  it('reactivates a paused mapping', async () => {
    const ref = await seed();
    const mappingId = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });
    await pauseMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      reason: 'investigating a discrepancy',
    });

    await expect(
      activateMapping(harness.db, {
        businessId: ref.businessId,
        mappingId,
        initialization: { from: 'canonical' },
      }),
    ).resolves.toMatchObject({ outcome: 'activated' });
  });
});

describe('the write gate', () => {
  it('permits a write only through an active, eligible, present mapping', async () => {
    const ref = await seed();
    const mappingId = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });

    await expect(
      resolveWriteTarget(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toMatchObject({
      outcome: 'writable',
      target: { externalId: `${ref.slug}-1`, locationIds: [ref.locationId] },
    });
  });

  it('refuses a draft, an approved-but-inactive, a paused, and an archived mapping', async () => {
    const ref = await seed();
    const proposed = await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: ref.providerItemId,
      canonicalItemId: ref.canonicalItemId,
      locationIds: [ref.locationId],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';
    const seen: string[] = [];

    const record = async (): Promise<void> => {
      const resolved = await resolveWriteTarget(harness.db, {
        businessId: ref.businessId,
        mappingId,
      });

      seen.push(resolved.outcome === 'not_active' ? resolved.status : resolved.outcome);
    };

    await record();
    await approveMapping(harness.db, { businessId: ref.businessId, mappingId });
    await record();
    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });
    await pauseMapping(harness.db, { businessId: ref.businessId, mappingId, reason: 'holding' });
    await record();
    await archiveMapping(harness.db, { businessId: ref.businessId, mappingId });
    await record();

    expect(seen).toEqual(['draft', 'approved', 'paused', 'archived']);
  });

  it('refuses once the store turns stock management off again', async () => {
    // Eligibility is checked at write time rather than trusted from activation:
    // a product that was eligible last week may not be today, and a write
    // authorized by a week-old approval would push quantities at a product that
    // no longer has any.
    const ref = await seed();
    const mappingId = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });
    await harness.db
      .update(providerItems)
      .set({ inventoryEligible: false, ineligibleReason: 'stock management was turned off' })
      .where(eq(providerItems.id, ref.providerItemId));

    await expect(
      resolveWriteTarget(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'ineligible', reason: 'stock management was turned off' });
  });

  it('refuses once the entity disappears from a complete scan', async () => {
    const ref = await seed();
    const mappingId = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });
    await harness.db
      .update(providerItems)
      .set({ missingSince: new Date() })
      .where(eq(providerItems.id, ref.providerItemId));

    await expect(
      resolveWriteTarget(harness.db, { businessId: ref.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'missing' });
  });

  it('refuses a mapping belonging to another business', async () => {
    const ref = await seed();
    const stranger = await seed();
    const mappingId = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });

    await expect(
      resolveWriteTarget(harness.db, { businessId: stranger.businessId, mappingId }),
    ).resolves.toEqual({ outcome: 'no_mapping' });
  });

  it('lists only the writable mappings of one item', async () => {
    const ref = await seed();
    const writable = await approvedMapping(ref);

    await activateMapping(harness.db, {
      businessId: ref.businessId,
      mappingId: writable,
      initialization: { from: 'canonical' },
    });

    const [second] = await harness.db
      .insert(providerItems)
      .values({
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        externalId: `${ref.slug}-2`,
        kind: 'product',
        inventoryEligible: true,
      })
      .returning({ id: providerItems.id });

    await proposeMapping(harness.db, {
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      providerItemId: second!.id,
      canonicalItemId: ref.canonicalItemId,
      locationIds: [ref.locationId],
    });

    const targets = await writableMappingsForItem(harness.db, {
      businessId: ref.businessId,
      canonicalItemId: ref.canonicalItemId,
    });

    expect(targets.map((target) => target.mappingId)).toEqual([writable]);
  });
});
