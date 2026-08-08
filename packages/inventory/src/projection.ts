import {
  canonicalItems,
  channelMappingLocations,
  channelMappings,
  connections,
  locationBalances,
  locations,
  providerItems,
  type Database,
  type MappingStatus,
  type providerNames,
} from '@eim/db';
import {
  availableToSellAcrossLocations,
  channelTarget,
  effectiveSafetyStock,
  shouldSuppressWooCommerceQuantityWrite,
  type LocationBalance,
} from '@eim/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { kitCapacity, kitsUsingComponent } from './kits';
import { readSettings } from './settings';

/**
 * What every channel would advertise, and what a change would do to it
 * (sections 8, 10, 21).
 *
 * This is the dry run. Section 8 requires a manual adjustment to preview "every
 * affected channel, location, and kit" before it is confirmed, and section 7
 * requires the same of a mapping activation. Both are this function with a
 * hypothetical movement applied.
 *
 * It computes rather than describes. The alternative — a preview that explains
 * the rules in prose while the writer applies them in code — is two
 * implementations of one calculation, and they drift the first time a rule
 * changes. So the preview and the eventual write derive their number from the
 * same `channelTarget`, and a mistake in it shows up in the preview too.
 *
 * Nothing here contacts a provider. `channelQuantity` is what the last import
 * recorded, which is exactly what an operator wants during an outage.
 */

export type ProjectionReader = Pick<Database, 'select'>;

/** A hypothetical movement, to see what it would do before doing it. */
export interface HypotheticalChange {
  readonly locationId: string;
  readonly quantityDelta: number;
}

export interface LocationProjection {
  readonly locationId: string;
  readonly code: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly safetyStock: number;
  readonly availableToSell: number;
  /** After the hypothetical change, if one was given. */
  readonly projectedOnHand: number;
  readonly projectedAvailableToSell: number;
}

export interface ChannelProjection {
  readonly mappingId: string;
  readonly connectionId: string;
  readonly provider: (typeof providerNames)[number];
  readonly externalId: string;
  readonly status: MappingStatus;
  readonly channelBuffer: number;
  readonly channelCap: number | null;
  /** What the provider advertised at the last import. */
  readonly channelQuantity: number | null;
  /** What this ledger says it should advertise now. */
  readonly currentTarget: number;
  /** What it would advertise after the hypothetical change. */
  readonly projectedTarget: number;
  /** False when the mapping is not active, ineligible, or missing. */
  readonly writable: boolean;
  readonly notWritableBecause: string | null;
  /**
   * Section 8: a downward write to zero is held back while a backorder-enabled
   * WooCommerce product already shows negative stock, so the store's record of
   * what it owes customers survives.
   */
  readonly suppressed: boolean;
}

export interface KitEffect {
  readonly kitCanonicalItemId: string;
  readonly sku: string;
  readonly currentCapacity: number;
  readonly projectedCapacity: number;
}

export interface ItemProjection {
  readonly canonicalItemId: string;
  readonly sku: string;
  readonly name: string;
  readonly isKit: boolean;
  readonly locations: readonly LocationProjection[];
  readonly availableToSell: number;
  readonly projectedAvailableToSell: number;
  /** Set when this item is itself a kit; null when it is an ordinary item. */
  readonly kitCapacity: number | null;
  readonly channels: readonly ChannelProjection[];
  /** Section 10: the kits this item is a component of, and what changes. */
  readonly affectedKits: readonly KitEffect[];
}

/**
 * Everything a confirmation screen has to show before a change is made.
 *
 * The hypothetical is applied to a copy of the balances, never to the database.
 * Reading is the only thing this does.
 */
export async function projectItem(
  db: ProjectionReader,
  input: {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly hypothetical?: readonly HypotheticalChange[];
  },
): Promise<ItemProjection | null> {
  const [item] = await db
    .select({
      sku: canonicalItems.sku,
      name: canonicalItems.name,
      isKit: canonicalItems.isKit,
      safetyStockOverride: canonicalItems.safetyStockOverride,
    })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.id, input.canonicalItemId),
        isNull(canonicalItems.deletedAt),
      ),
    )
    .limit(1);

  if (item === undefined) {
    return null;
  }

  const settings = await readSettings(db, input.businessId);
  const deltas = new Map<string, number>();
  for (const change of input.hypothetical ?? []) {
    deltas.set(change.locationId, (deltas.get(change.locationId) ?? 0) + change.quantityDelta);
  }

  const rows = await db
    .select({
      locationId: locationBalances.locationId,
      code: locations.code,
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
      locationOverride: locationBalances.safetyStock,
    })
    .from(locationBalances)
    .innerJoin(locations, eq(locations.id, locationBalances.locationId))
    .where(
      and(
        eq(locationBalances.businessId, input.businessId),
        eq(locationBalances.canonicalItemId, input.canonicalItemId),
        isNull(locations.deletedAt),
      ),
    )
    .orderBy(asc(locations.priority), asc(locations.code));

  const projections: LocationProjection[] = rows.map((row) => {
    const safetyStock = effectiveSafetyStock({
      businessDefault: settings.defaultSafetyStock,
      itemOverride: item.safetyStockOverride,
      locationOverride: row.locationOverride,
    });
    // Never below zero, because the ledger would refuse the movement that took
    // it there. Showing a negative would preview something that cannot happen.
    const projectedOnHand = Math.max(0, row.onHand + (deltas.get(row.locationId) ?? 0));

    return {
      locationId: row.locationId,
      code: row.code,
      onHand: row.onHand,
      reserved: row.reserved,
      safetyStock,
      availableToSell: Math.max(0, row.onHand - row.reserved - safetyStock),
      projectedOnHand,
      projectedAvailableToSell: Math.max(0, projectedOnHand - row.reserved - safetyStock),
    };
  });

  const mappings = await db
    .select({
      mappingId: channelMappings.id,
      connectionId: channelMappings.connectionId,
      provider: connections.provider,
      status: channelMappings.status,
      channelBuffer: channelMappings.channelBuffer,
      channelCap: channelMappings.channelCap,
      pauseReason: channelMappings.pauseReason,
      externalId: providerItems.externalId,
      channelQuantity: providerItems.quantity,
      backordersEnabled: providerItems.backordersEnabled,
      inventoryEligible: providerItems.inventoryEligible,
      ineligibleReason: providerItems.ineligibleReason,
      missingSince: providerItems.missingSince,
    })
    .from(channelMappings)
    .innerJoin(connections, eq(connections.id, channelMappings.connectionId))
    .innerJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
    .where(
      and(
        eq(channelMappings.businessId, input.businessId),
        eq(channelMappings.canonicalItemId, input.canonicalItemId),
      ),
    )
    .orderBy(asc(channelMappings.createdAt));

  const selectedByMapping = await readSelectedLocations(
    db,
    mappings.map((mapping) => mapping.mappingId),
  );

  const channels: ChannelProjection[] = [];

  for (const mapping of mappings) {
    if (mapping.status === 'archived') {
      continue;
    }

    const selected = selectedByMapping.get(mapping.mappingId) ?? [];
    const chosen = projections.filter((projection) => selected.includes(projection.locationId));
    const rules = { channelBuffer: mapping.channelBuffer, channelCap: mapping.channelCap };

    const current = channelTarget(availableToSellAcrossLocations(asBalances(chosen, false)), rules);
    const projected = channelTarget(
      availableToSellAcrossLocations(asBalances(chosen, true)),
      rules,
    );

    channels.push({
      mappingId: mapping.mappingId,
      connectionId: mapping.connectionId,
      provider: mapping.provider,
      externalId: mapping.externalId,
      status: mapping.status,
      channelBuffer: mapping.channelBuffer,
      channelCap: mapping.channelCap,
      channelQuantity: mapping.channelQuantity,
      currentTarget: current,
      projectedTarget: projected,
      writable:
        mapping.status === 'active' && mapping.inventoryEligible && mapping.missingSince === null,
      notWritableBecause: whyNot(mapping),
      suppressed:
        mapping.provider === 'woocommerce' &&
        shouldSuppressWooCommerceQuantityWrite({
          desiredTarget: projected,
          observedStoreStock: mapping.channelQuantity ?? 0,
          backordersEnabled: mapping.backordersEnabled,
        }),
    });
  }

  const affectedKits = await projectKits(db, {
    businessId: input.businessId,
    canonicalItemId: input.canonicalItemId,
    isKit: item.isKit,
  });

  const ownCapacity = item.isKit
    ? await kitCapacity(db, {
        businessId: input.businessId,
        kitCanonicalItemId: input.canonicalItemId,
      })
    : null;

  return {
    canonicalItemId: input.canonicalItemId,
    sku: item.sku,
    name: item.name,
    isKit: item.isKit,
    locations: projections,
    availableToSell: availableToSellAcrossLocations(asBalances(projections, false)),
    projectedAvailableToSell: availableToSellAcrossLocations(asBalances(projections, true)),
    kitCapacity:
      ownCapacity !== null && ownCapacity.outcome === 'computed'
        ? ownCapacity.capacity.capacity
        : null,
    channels,
    affectedKits,
  };
}

/**
 * The kits this movement would change (section 10).
 *
 * Only the current capacity is reported for each. Projecting a kit's capacity
 * under a hypothetical component movement would mean re-deriving every other
 * component's availability as well, and section 10 already guarantees the figure
 * is recomputed the moment the movement actually commits — so an operator sees
 * which kits are affected, which is the decision-relevant part, rather than a
 * second number computed a second way.
 */
async function projectKits(
  db: ProjectionReader,
  input: {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly isKit: boolean;
  },
): Promise<KitEffect[]> {
  if (input.isKit) {
    return [];
  }

  const users = await kitsUsingComponent(db, input);
  const effects: KitEffect[] = [];

  for (const kit of users) {
    const capacity = await kitCapacity(db, {
      businessId: input.businessId,
      kitCanonicalItemId: kit.kitCanonicalItemId,
    });

    if (capacity.outcome !== 'computed') {
      continue;
    }

    const [row] = await db
      .select({ sku: canonicalItems.sku })
      .from(canonicalItems)
      .where(eq(canonicalItems.id, kit.kitCanonicalItemId))
      .limit(1);

    effects.push({
      kitCanonicalItemId: kit.kitCanonicalItemId,
      sku: row?.sku ?? '',
      currentCapacity: capacity.capacity.capacity,
      projectedCapacity: capacity.capacity.capacity,
    });
  }

  return effects;
}

async function readSelectedLocations(
  db: ProjectionReader,
  mappingIds: readonly string[],
): Promise<Map<string, string[]>> {
  const selected = new Map<string, string[]>();

  if (mappingIds.length === 0) {
    return selected;
  }

  const rows = await db
    .select({
      mappingId: channelMappingLocations.mappingId,
      locationId: channelMappingLocations.locationId,
    })
    .from(channelMappingLocations)
    .where(inArray(channelMappingLocations.mappingId, [...mappingIds]));

  for (const row of rows) {
    selected.set(row.mappingId, [...(selected.get(row.mappingId) ?? []), row.locationId]);
  }

  return selected;
}

function asBalances(
  projections: readonly LocationProjection[],
  projected: boolean,
): LocationBalance[] {
  return projections.map((projection) => ({
    locationId: projection.locationId,
    onHand: projected ? projection.projectedOnHand : projection.onHand,
    reserved: projection.reserved,
    safetyStock: projection.safetyStock,
  }));
}

function whyNot(mapping: {
  readonly status: MappingStatus;
  readonly pauseReason: string | null;
  readonly inventoryEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly missingSince: Date | null;
}): string | null {
  if (!mapping.inventoryEligible) {
    return mapping.ineligibleReason ?? 'this channel entity cannot be synchronized in version 1';
  }
  if (mapping.missingSince !== null) {
    return 'the last complete catalog scan did not find this entity';
  }
  switch (mapping.status) {
    case 'active':
      return null;
    case 'paused':
      return mapping.pauseReason ?? 'this mapping is paused';
    case 'draft':
      return 'this mapping has not been approved';
    case 'approved':
      return 'this mapping has been approved but not activated';
    case 'archived':
      return 'this mapping has been archived';
  }
}
