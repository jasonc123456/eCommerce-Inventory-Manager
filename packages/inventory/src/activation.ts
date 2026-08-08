import {
  canonicalItems,
  channelMappingLocations,
  channelMappingVersions,
  channelMappings,
  locationBalances,
  locations,
  providerItems,
  type Database,
  type MappingStatus,
} from '@eim/db';
import {
  availableToSellAcrossLocations,
  channelTarget,
  effectiveSafetyStock,
  type LocationBalance,
} from '@eim/domain';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';

import { postMovements, transactionally } from './ledger';
import { readSettings } from './settings';

/**
 * Turning an approved mapping into a synchronizing one (sections 6, 7, 8).
 *
 * Section 7 will not let a mapping start until a preview has shown "all current
 * quantities, initialization source, outbound writes, safety stock, caps,
 * unsupported entities, variation completeness, kit effects, and conflicts", and
 * blocks activation outright while quantities disagree. That list is not a UI
 * specification. It is the set of things that can be true at the moment a
 * mapping goes live and would each, on their own, cause this application to
 * write a wrong number to a live storefront a few seconds later.
 *
 * So activation is where the checks live, and `resolveWriteTarget` at the bottom
 * of this file is the only supported way to find out whether a provider write is
 * permitted. Section 36's exit gate for this milestone — no provider write
 * without an eligible approved mapping — is that function refusing.
 */

export type ActivationReader = Pick<Database, 'select'>;
export type ActivationDatabase = Pick<Database, 'select' | 'transaction'>;

/** Where the authoritative starting quantity comes from (sections 7, 8). */
export type InitializationSource =
  /** The ledger is already right; the channel will be corrected to match. */
  | { readonly from: 'canonical' }
  /** The store's figure is the true one; a ledger adjustment records it. */
  | { readonly from: 'channel'; readonly locationId?: string }
  /** Neither was right; an operator counted (section 8's wizard step 3). */
  | { readonly from: 'explicit'; readonly quantity: number; readonly locationId?: string };

export interface ActivationPreview {
  readonly mappingId: string;
  readonly status: MappingStatus;
  readonly canonicalItemId: string;
  readonly sku: string;
  readonly externalId: string;

  /** Section 8's figures, per selected location and in total. */
  readonly locations: readonly {
    readonly locationId: string;
    readonly code: string;
    readonly onHand: number;
    readonly reserved: number;
    readonly safetyStock: number;
    readonly availableToSell: number;
  }[];
  readonly availableToSell: number;
  readonly channelBuffer: number;
  readonly channelCap: number | null;
  /** The absolute quantity that would be written once this mapping is live. */
  readonly outboundTarget: number;

  /** What the provider currently advertises, as of the last import. */
  readonly channelQuantity: number | null;

  /** Section 6: why this entity cannot be synchronized, if it cannot. */
  readonly ineligibleReason: string | null;
  /** Section 6: the channel entity has disappeared from a complete scan. */
  readonly missing: boolean;

  /** Section 7's strict variation rule. */
  readonly variations: VariationCompleteness | null;

  /**
   * Section 7: quantity disagreements block activation until resolved. True
   * when the store's figure and the computed target differ and the caller has
   * not said which one to believe.
   */
  readonly quantitiesDisagree: boolean;

  /** Everything above, reduced to whether activation may proceed. */
  readonly blockers: readonly string[];
}

export interface VariationCompleteness {
  readonly parentExternalId: string;
  readonly total: number;
  readonly mapped: number;
  /** Sellable siblings with no live mapping. Section 7 blocks on any of these. */
  readonly unmapped: readonly { readonly externalId: string; readonly sku: string | null }[];
}

export type ActivationPreviewResult =
  | { readonly outcome: 'previewed'; readonly preview: ActivationPreview }
  | { readonly outcome: 'not_found' };

/**
 * Everything section 7 requires an operator to see before a mapping goes live.
 *
 * Computes the outbound target the same way the projection will, rather than
 * describing it in words. A preview that explains the rules and a writer that
 * applies them are two implementations of one calculation, and they drift.
 */
export async function previewActivation(
  db: ActivationReader,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly initialization?: InitializationSource;
  },
): Promise<ActivationPreviewResult> {
  const [mapping] = await db
    .select({
      status: channelMappings.status,
      canonicalItemId: channelMappings.canonicalItemId,
      connectionId: channelMappings.connectionId,
      providerItemId: channelMappings.providerItemId,
      channelBuffer: channelMappings.channelBuffer,
      channelCap: channelMappings.channelCap,
      sku: canonicalItems.sku,
      safetyStockOverride: canonicalItems.safetyStockOverride,
      externalId: providerItems.externalId,
      parentExternalId: providerItems.parentExternalId,
      channelQuantity: providerItems.quantity,
      inventoryEligible: providerItems.inventoryEligible,
      ineligibleReason: providerItems.ineligibleReason,
      missingSince: providerItems.missingSince,
    })
    .from(channelMappings)
    .innerJoin(canonicalItems, eq(canonicalItems.id, channelMappings.canonicalItemId))
    .innerJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
    .where(
      and(
        eq(channelMappings.businessId, input.businessId),
        eq(channelMappings.id, input.mappingId),
      ),
    )
    .limit(1);

  if (mapping === undefined) {
    return { outcome: 'not_found' };
  }

  const settings = await readSettings(db, input.businessId);

  const selected = await db
    .select({
      locationId: channelMappingLocations.locationId,
      code: locations.code,
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
      locationOverride: locationBalances.safetyStock,
    })
    .from(channelMappingLocations)
    .innerJoin(locations, eq(locations.id, channelMappingLocations.locationId))
    .leftJoin(
      locationBalances,
      and(
        eq(locationBalances.businessId, channelMappingLocations.businessId),
        eq(locationBalances.locationId, channelMappingLocations.locationId),
        eq(locationBalances.canonicalItemId, mapping.canonicalItemId),
      ),
    )
    .where(eq(channelMappingLocations.mappingId, input.mappingId))
    .orderBy(locations.priority, locations.code);

  const balances: LocationBalance[] = selected.map((row) => ({
    locationId: row.locationId,
    onHand: row.onHand ?? 0,
    reserved: row.reserved ?? 0,
    safetyStock: effectiveSafetyStock({
      businessDefault: settings.defaultSafetyStock,
      itemOverride: mapping.safetyStockOverride,
      locationOverride: row.locationOverride,
    }),
  }));

  const availableToSell = availableToSellAcrossLocations(balances);
  const outboundTarget = channelTarget(availableToSell, {
    channelBuffer: mapping.channelBuffer,
    channelCap: mapping.channelCap,
  });

  const variations =
    mapping.parentExternalId === null
      ? null
      : await assessVariationCompleteness(db, {
          businessId: input.businessId,
          connectionId: mapping.connectionId,
          parentExternalId: mapping.parentExternalId,
        });

  // Section 7: a disagreement between what the store advertises and what the
  // ledger would advertise is a conflict, not a value to overwrite quietly. It
  // stops being a blocker once the caller has said which figure to believe.
  const quantitiesDisagree =
    input.initialization === undefined &&
    mapping.channelQuantity !== null &&
    mapping.channelQuantity !== outboundTarget;

  const blockers: string[] = [];
  if (!mapping.inventoryEligible) {
    blockers.push(
      mapping.ineligibleReason ?? 'this channel entity cannot be synchronized in version 1',
    );
  }
  if (mapping.missingSince !== null) {
    blockers.push('this channel entity was not found by the last complete catalog scan');
  }
  if (variations !== null && variations.unmapped.length > 0) {
    blockers.push(
      `${String(variations.unmapped.length)} of ${String(variations.total)} variations on this listing are not mapped, and section 7 synchronizes a variation listing only in full`,
    );
  }
  if (quantitiesDisagree) {
    blockers.push(
      `the store advertises ${String(mapping.channelQuantity)} and this ledger would advertise ${String(outboundTarget)}; choose which figure is authoritative`,
    );
  }
  if (selected.length === 0) {
    blockers.push('this mapping draws stock from no location');
  }

  return {
    outcome: 'previewed',
    preview: {
      mappingId: input.mappingId,
      status: mapping.status,
      canonicalItemId: mapping.canonicalItemId,
      sku: mapping.sku,
      externalId: mapping.externalId,
      locations: selected.map((row, index) => ({
        locationId: row.locationId,
        code: row.code,
        onHand: row.onHand ?? 0,
        reserved: row.reserved ?? 0,
        safetyStock: balances[index]?.safetyStock ?? 0,
        availableToSell: Math.max(
          0,
          (row.onHand ?? 0) - (row.reserved ?? 0) - (balances[index]?.safetyStock ?? 0),
        ),
      })),
      availableToSell,
      channelBuffer: mapping.channelBuffer,
      channelCap: mapping.channelCap,
      outboundTarget,
      channelQuantity: mapping.channelQuantity,
      ineligibleReason: mapping.inventoryEligible ? null : mapping.ineligibleReason,
      missing: mapping.missingSince !== null,
      variations,
      quantitiesDisagree,
      blockers,
    },
  };
}

/**
 * Whether every sellable variation of one listing is accounted for (section 7).
 *
 * A variation listing synchronizes in full or not at all. Half a listing is
 * worse than none of it: the mapped variations would track the ledger while the
 * unmapped ones kept advertising a quantity nothing maintains, and the listing
 * as a whole would be quietly wrong in a way no single mapping looks wrong in.
 *
 * Only inventory-eligible siblings count. A variation the provider says cannot
 * be synchronized is not a gap an operator can close.
 */
export async function assessVariationCompleteness(
  db: ActivationReader,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly parentExternalId: string;
  },
): Promise<VariationCompleteness> {
  const siblings = await db
    .select({
      externalId: providerItems.externalId,
      sku: providerItems.sku,
      mappingStatus: channelMappings.status,
    })
    .from(providerItems)
    .leftJoin(
      channelMappings,
      and(
        eq(channelMappings.providerItemId, providerItems.id),
        ne(channelMappings.status, 'archived'),
      ),
    )
    .where(
      and(
        eq(providerItems.businessId, input.businessId),
        eq(providerItems.connectionId, input.connectionId),
        eq(providerItems.parentExternalId, input.parentExternalId),
        eq(providerItems.inventoryEligible, true),
        isNull(providerItems.missingSince),
      ),
    );

  const unmapped = siblings
    .filter((sibling) => sibling.mappingStatus === null)
    .map((sibling) => ({ externalId: sibling.externalId, sku: sibling.sku }));

  return {
    parentExternalId: input.parentExternalId,
    total: siblings.length,
    mapped: siblings.length - unmapped.length,
    unmapped,
  };
}

export type ActivationResult =
  | { readonly outcome: 'activated'; readonly outboundTarget: number }
  | { readonly outcome: 'not_found' }
  /** Section 7: approval comes first, always. */
  | { readonly outcome: 'not_approved'; readonly status: MappingStatus }
  | { readonly outcome: 'blocked'; readonly blockers: readonly string[] }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Activates an approved mapping, adopting a starting quantity if told to.
 *
 * Adopting the store's figure writes a ledger adjustment rather than setting a
 * balance directly, because section 8 has no path by which stock changes without
 * an entry explaining it — and "the store said so at activation" is exactly the
 * kind of explanation an operator needs six weeks later.
 *
 * The preview is recomputed here rather than trusted from the caller. A blocker
 * that appeared between the operator reading the preview and pressing the button
 * is precisely the case this check exists for.
 */
export async function activateMapping(
  db: ActivationDatabase,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly initialization?: InitializationSource;
    readonly actorUserId?: string | null;
    readonly now?: Date;
  },
): Promise<ActivationResult> {
  return transactionally<ActivationResult>(db, async (tx) => {
    const previewed = await previewActivation(tx, input);

    if (previewed.outcome === 'not_found') {
      return { keep: false, value: { outcome: 'not_found' } };
    }

    const preview = previewed.preview;

    if (preview.status !== 'approved' && preview.status !== 'paused') {
      return { keep: false, value: { outcome: 'not_approved', status: preview.status } };
    }
    if (preview.blockers.length > 0) {
      return { keep: false, value: { outcome: 'blocked', blockers: preview.blockers } };
    }

    if (input.initialization !== undefined && input.initialization.from !== 'canonical') {
      const adopted = await adopt(tx, {
        businessId: input.businessId,
        canonicalItemId: preview.canonicalItemId,
        locationIds: preview.locations.map((location) => location.locationId),
        onHandByLocation: new Map(
          preview.locations.map((location) => [location.locationId, location.onHand]),
        ),
        quantity:
          input.initialization.from === 'explicit'
            ? input.initialization.quantity
            : (preview.channelQuantity ?? 0),
        locationId: input.initialization.locationId,
        actorUserId: input.actorUserId ?? null,
        source: input.initialization.from,
      });

      if (adopted !== null) {
        return { keep: false, value: adopted };
      }
    }

    const now = input.now ?? new Date();
    const version = await bumpVersion(tx, input.businessId, input.mappingId, {
      status: 'active',
      changeReason:
        input.initialization === undefined
          ? 'activated'
          : `activated, starting quantity from ${input.initialization.from}`,
      createdByUserId: input.actorUserId ?? null,
    });

    await tx
      .update(channelMappings)
      .set({ status: 'active', pauseReason: null, activatedAt: now, version })
      .where(eq(channelMappings.id, input.mappingId));

    // Recomputed after adoption, since adopting moved the balance the target is
    // derived from.
    const after = await previewActivation(tx, { ...input, initialization: { from: 'canonical' } });

    return {
      keep: true,
      value: {
        outcome: 'activated',
        outboundTarget: after.outcome === 'previewed' ? after.preview.outboundTarget : 0,
      },
    };
  });
}

/**
 * Records the starting quantity an operator chose.
 *
 * Returns null when it worked, or the failure to report. Adoption needs one
 * location to put the units at: a mapping drawing on three warehouses gives no
 * basis for splitting a single figure the store reported, and guessing would put
 * stock somewhere it is not.
 */
async function adopt(
  tx: Parameters<typeof postMovements>[0],
  input: {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly locationIds: readonly string[];
    readonly onHandByLocation: ReadonlyMap<string, number>;
    readonly quantity: number;
    readonly locationId: string | undefined;
    readonly actorUserId: string | null;
    readonly source: 'channel' | 'explicit';
  },
): Promise<ActivationResult | null> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
    return { outcome: 'invalid', reason: 'a starting quantity is a whole number of units' };
  }

  const locationId =
    input.locationId ?? (input.locationIds.length === 1 ? input.locationIds[0] : undefined);

  if (locationId === undefined) {
    return {
      outcome: 'invalid',
      reason:
        'this mapping draws on more than one location, so say which one the starting quantity is at',
    };
  }
  if (!input.locationIds.includes(locationId)) {
    return { outcome: 'invalid', reason: 'that location is not one this mapping draws from' };
  }

  const quantityDelta = input.quantity - (input.onHandByLocation.get(locationId) ?? 0);

  if (quantityDelta === 0) {
    return null;
  }

  const posted = await postMovements(tx, {
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    movements: [
      {
        canonicalItemId: input.canonicalItemId,
        locationId,
        kind: 'adjustment',
        quantityDelta,
        reason:
          input.source === 'channel'
            ? 'starting quantity adopted from the channel at mapping activation'
            : 'starting quantity entered by an operator at mapping activation',
      },
    ],
  });

  if (posted.outcome === 'posted') {
    return null;
  }

  return posted.outcome === 'insufficient'
    ? {
        outcome: 'invalid',
        reason: 'the starting quantity would take a location below zero',
      }
    : { outcome: 'invalid', reason: posted.reason };
}

export type PauseResult =
  | { readonly outcome: 'paused' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_active'; readonly status: MappingStatus };

/**
 * Stops a mapping writing, with a reason an operator can read.
 *
 * The reason is not optional and the database agrees: a mapping that has
 * silently stopped synchronizing is indistinguishable from one that is working,
 * right up until someone notices the store is a week out of date.
 */
export async function pauseMapping(
  db: ActivationDatabase,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly reason: string;
    readonly actorUserId?: string | null;
  },
): Promise<PauseResult> {
  return transactionally<PauseResult>(db, async (tx) => {
    const [current] = await tx
      .select({ status: channelMappings.status })
      .from(channelMappings)
      .where(
        and(
          eq(channelMappings.businessId, input.businessId),
          eq(channelMappings.id, input.mappingId),
        ),
      )
      .limit(1);

    if (current === undefined) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (current.status !== 'active') {
      return { keep: false, value: { outcome: 'not_active', status: current.status } };
    }

    const version = await bumpVersion(tx, input.businessId, input.mappingId, {
      status: 'paused',
      changeReason: input.reason,
      createdByUserId: input.actorUserId ?? null,
    });

    await tx
      .update(channelMappings)
      .set({ status: 'paused', pauseReason: input.reason, version })
      .where(eq(channelMappings.id, input.mappingId));

    return { keep: true, value: { outcome: 'paused' } };
  });
}

/**
 * Pauses every mapping on a variation listing that has gained a variation
 * nobody has mapped (section 7).
 *
 * Section 7 pauses "synchronization for the entire variation listing" when a
 * variation is added, removed, or materially changed, and creates a remapping
 * task. This is the pause half; the alert and the task belong with
 * notifications. It runs after an import, which is when a new variation can
 * first be known about.
 */
export async function pauseIncompleteVariationListings(
  db: ActivationDatabase,
  input: { readonly businessId: string; readonly connectionId: string },
): Promise<{ readonly paused: readonly string[] }> {
  const listings = await db
    .select({ parentExternalId: providerItems.parentExternalId })
    .from(providerItems)
    .innerJoin(channelMappings, eq(channelMappings.providerItemId, providerItems.id))
    .where(
      and(
        eq(providerItems.businessId, input.businessId),
        eq(providerItems.connectionId, input.connectionId),
        isNotNull(providerItems.parentExternalId),
        eq(channelMappings.status, 'active'),
      ),
    );

  const paused: string[] = [];
  const parents = new Set(
    listings
      .map((listing) => listing.parentExternalId)
      .filter((parentExternalId): parentExternalId is string => parentExternalId !== null),
  );

  for (const parentExternalId of parents) {
    const completeness = await assessVariationCompleteness(db, {
      businessId: input.businessId,
      connectionId: input.connectionId,
      parentExternalId,
    });

    if (completeness.unmapped.length === 0) {
      continue;
    }

    const affected = await db
      .select({ id: channelMappings.id })
      .from(channelMappings)
      .innerJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
      .where(
        and(
          eq(channelMappings.businessId, input.businessId),
          eq(channelMappings.status, 'active'),
          eq(providerItems.parentExternalId, parentExternalId),
        ),
      );

    for (const mapping of affected) {
      const result = await pauseMapping(db, {
        businessId: input.businessId,
        mappingId: mapping.id,
        reason: `a variation of this listing is not mapped (${String(completeness.unmapped.length)} of ${String(completeness.total)}), and section 7 synchronizes a variation listing only in full`,
      });

      if (result.outcome === 'paused') {
        paused.push(mapping.id);
      }
    }
  }

  return { paused };
}

export interface WriteTarget {
  readonly mappingId: string;
  readonly connectionId: string;
  readonly providerItemId: string;
  readonly externalId: string;
  readonly canonicalItemId: string;
  readonly channelBuffer: number;
  readonly channelCap: number | null;
  readonly locationIds: readonly string[];
}

export type WriteTargetResult =
  | { readonly outcome: 'writable'; readonly target: WriteTarget }
  | { readonly outcome: 'no_mapping' }
  /** Approved but not synchronizing: a draft, a pause, an archived mapping. */
  | {
      readonly outcome: 'not_active';
      readonly status: MappingStatus;
      readonly reason: string | null;
    }
  /** Section 6: the entity is not one this version can hold inventory for. */
  | { readonly outcome: 'ineligible'; readonly reason: string }
  /** Section 6: a complete scan did not find it. */
  | { readonly outcome: 'missing' };

/**
 * The only supported way to ask whether a provider write is permitted.
 *
 * Section 36's exit gate for this milestone is that no provider write can occur
 * without an eligible approved mapping. That is enforced by there being one
 * function that answers the question and by it checking all three things at
 * once: the mapping is active, which implies it was approved and activated, and
 * the channel entity is both eligible and still there.
 *
 * Checking eligibility here rather than trusting what it was at activation is
 * deliberate. A store can turn stock management off on a product that was
 * eligible last week, and the next import records that; a write authorized by a
 * week-old approval would then be pushing quantities at a product that no longer
 * has any.
 */
export async function resolveWriteTarget(
  db: ActivationReader,
  input: { readonly businessId: string; readonly mappingId: string },
): Promise<WriteTargetResult> {
  const [row] = await db
    .select({
      status: channelMappings.status,
      pauseReason: channelMappings.pauseReason,
      connectionId: channelMappings.connectionId,
      providerItemId: channelMappings.providerItemId,
      canonicalItemId: channelMappings.canonicalItemId,
      channelBuffer: channelMappings.channelBuffer,
      channelCap: channelMappings.channelCap,
      externalId: providerItems.externalId,
      inventoryEligible: providerItems.inventoryEligible,
      ineligibleReason: providerItems.ineligibleReason,
      missingSince: providerItems.missingSince,
    })
    .from(channelMappings)
    .innerJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
    .where(
      and(
        eq(channelMappings.businessId, input.businessId),
        eq(channelMappings.id, input.mappingId),
      ),
    )
    .limit(1);

  if (row === undefined) {
    return { outcome: 'no_mapping' };
  }
  if (row.status !== 'active') {
    return { outcome: 'not_active', status: row.status, reason: row.pauseReason };
  }
  if (!row.inventoryEligible) {
    return {
      outcome: 'ineligible',
      reason: row.ineligibleReason ?? 'this channel entity cannot be synchronized in version 1',
    };
  }
  if (row.missingSince !== null) {
    return { outcome: 'missing' };
  }

  const selected = await db
    .select({ locationId: channelMappingLocations.locationId })
    .from(channelMappingLocations)
    .where(eq(channelMappingLocations.mappingId, input.mappingId));

  return {
    outcome: 'writable',
    target: {
      mappingId: input.mappingId,
      connectionId: row.connectionId,
      providerItemId: row.providerItemId,
      externalId: row.externalId,
      canonicalItemId: row.canonicalItemId,
      channelBuffer: row.channelBuffer,
      channelCap: row.channelCap,
      locationIds: selected.map((location) => location.locationId),
    },
  };
}

/** Every mapping that may currently be written to, for one canonical item. */
export async function writableMappingsForItem(
  db: ActivationReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<WriteTarget[]> {
  const rows = await db
    .select({ id: channelMappings.id })
    .from(channelMappings)
    .where(
      and(
        eq(channelMappings.businessId, input.businessId),
        eq(channelMappings.canonicalItemId, input.canonicalItemId),
        eq(channelMappings.status, 'active'),
      ),
    );

  const targets: WriteTarget[] = [];
  for (const row of rows) {
    const resolved = await resolveWriteTarget(db, {
      businessId: input.businessId,
      mappingId: row.id,
    });

    if (resolved.outcome === 'writable') {
      targets.push(resolved.target);
    }
  }

  return targets;
}

async function bumpVersion(
  tx: Pick<Database, 'select' | 'insert'>,
  businessId: string,
  mappingId: string,
  change: {
    readonly status: MappingStatus;
    readonly changeReason: string;
    readonly createdByUserId: string | null;
  },
): Promise<number> {
  const [current] = await tx
    .select({
      version: channelMappings.version,
      canonicalItemId: channelMappings.canonicalItemId,
      channelBuffer: channelMappings.channelBuffer,
      channelCap: channelMappings.channelCap,
    })
    .from(channelMappings)
    .where(and(eq(channelMappings.businessId, businessId), eq(channelMappings.id, mappingId)))
    .limit(1);

  if (current === undefined) {
    throw new Error('the mapping disappeared while it was being changed');
  }

  const selected = await tx
    .select({ locationId: channelMappingLocations.locationId })
    .from(channelMappingLocations)
    .where(eq(channelMappingLocations.mappingId, mappingId));

  const version = current.version + 1;

  await tx.insert(channelMappingVersions).values({
    businessId,
    mappingId,
    version,
    canonicalItemId: current.canonicalItemId,
    channelBuffer: current.channelBuffer,
    channelCap: current.channelCap,
    locationIds: selected.map((location) => location.locationId),
    ...change,
  });

  return version;
}
