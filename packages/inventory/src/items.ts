import { canonicalItems, locationBalances, locations, type Database } from '@eim/db';
import { effectiveSafetyStock, safetyStockSource, type SafetyStockSource } from '@eim/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { isUniqueViolation } from './errors';
import { readSettings, type SettingsReader } from './settings';

/**
 * Canonical items and their per-location settings (sections 7, 8).
 *
 * Section 7 makes the canonical item's UUID immutable and its SKU and name
 * mutable searchable attributes. That inversion is the point of this module: a
 * SKU can be corrected without repointing a single mapping, order line, or
 * ledger entry, because none of them were ever pointed at the SKU.
 */

export type ItemReader = Pick<Database, 'select'>;
export type ItemWriter = Pick<Database, 'select' | 'insert' | 'update'>;

export interface CanonicalItemSummary {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly safetyStockOverride: number | null;
  readonly isActive: boolean;
}

export async function listCanonicalItems(
  db: ItemReader,
  businessId: string,
  options: { readonly activeOnly?: boolean } = {},
): Promise<CanonicalItemSummary[]> {
  const conditions = [eq(canonicalItems.businessId, businessId), isNull(canonicalItems.deletedAt)];
  if (options.activeOnly === true) {
    conditions.push(eq(canonicalItems.isActive, true));
  }

  return db
    .select({
      id: canonicalItems.id,
      sku: canonicalItems.sku,
      name: canonicalItems.name,
      description: canonicalItems.description,
      safetyStockOverride: canonicalItems.safetyStockOverride,
      isActive: canonicalItems.isActive,
    })
    .from(canonicalItems)
    .where(and(...conditions))
    .orderBy(asc(canonicalItems.sku));
}

export interface CreateItemInput {
  readonly businessId: string;
  readonly sku: string;
  readonly name: string;
  readonly description?: string | null;
  /** Section 8 permits zero here; null inherits the business default. */
  readonly safetyStockOverride?: number | null;
}

export type CreateItemResult =
  | { readonly outcome: 'created'; readonly canonicalItemId: string }
  | { readonly outcome: 'sku_taken' }
  | { readonly outcome: 'invalid'; readonly reason: string };

export async function createCanonicalItem(
  db: ItemWriter,
  input: CreateItemInput,
): Promise<CreateItemResult> {
  const sku = input.sku.trim();
  const name = input.name.trim();

  if (sku.length === 0 || sku.length > 128) {
    return { outcome: 'invalid', reason: 'a SKU is between 1 and 128 characters' };
  }
  if (name.length === 0) {
    return { outcome: 'invalid', reason: 'an item needs a name' };
  }
  if (!isOptionalWholeNonNegative(input.safetyStockOverride)) {
    return { outcome: 'invalid', reason: 'safety stock must be a whole number of units' };
  }

  try {
    const [row] = await db
      .insert(canonicalItems)
      .values({
        businessId: input.businessId,
        sku,
        name,
        description: input.description ?? null,
        safetyStockOverride: input.safetyStockOverride ?? null,
      })
      .returning({ id: canonicalItems.id });

    if (row === undefined) {
      throw new Error(`the canonical item ${sku} could not be created`);
    }

    return { outcome: 'created', canonicalItemId: row.id };
  } catch (error) {
    if (isUniqueViolation(error, 'canonical_items_sku_unique')) {
      return { outcome: 'sku_taken' };
    }

    throw error;
  }
}

export interface UpdateItemInput {
  readonly businessId: string;
  readonly canonicalItemId: string;
  readonly sku?: string;
  readonly name?: string;
  readonly description?: string | null;
  /** Pass null to clear the override and inherit the business default again. */
  readonly safetyStockOverride?: number | null;
  readonly isActive?: boolean;
}

export type UpdateItemResult =
  | { readonly outcome: 'updated' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'sku_taken' }
  | { readonly outcome: 'invalid'; readonly reason: string };

export async function updateCanonicalItem(
  db: ItemWriter,
  input: UpdateItemInput,
): Promise<UpdateItemResult> {
  const sku = input.sku?.trim();
  const name = input.name?.trim();

  if (sku !== undefined && (sku.length === 0 || sku.length > 128)) {
    return { outcome: 'invalid', reason: 'a SKU is between 1 and 128 characters' };
  }
  if (name?.length === 0) {
    return { outcome: 'invalid', reason: 'an item needs a name' };
  }
  if (!isOptionalWholeNonNegative(input.safetyStockOverride)) {
    return { outcome: 'invalid', reason: 'safety stock must be a whole number of units' };
  }

  try {
    const updated = await db
      .update(canonicalItems)
      .set({
        ...(sku === undefined ? {} : { sku }),
        ...(name === undefined ? {} : { name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.safetyStockOverride === undefined
          ? {}
          : { safetyStockOverride: input.safetyStockOverride }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      })
      .where(
        and(
          eq(canonicalItems.businessId, input.businessId),
          eq(canonicalItems.id, input.canonicalItemId),
          isNull(canonicalItems.deletedAt),
        ),
      )
      .returning({ id: canonicalItems.id });

    return updated.length === 0 ? { outcome: 'not_found' } : { outcome: 'updated' };
  } catch (error) {
    if (isUniqueViolation(error, 'canonical_items_sku_unique')) {
      return { outcome: 'sku_taken' };
    }

    throw error;
  }
}

export interface ItemLocationSettings {
  readonly businessId: string;
  readonly canonicalItemId: string;
  readonly locationId: string;
  /** Null clears the per-location override; see `@eim/domain`. */
  readonly safetyStock?: number | null;
  readonly bin?: string | null;
  readonly note?: string | null;
}

export type SetItemLocationResult =
  { readonly outcome: 'saved' } | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Records where an item sits at one location, and what it withholds there.
 *
 * Creates the balance row if it does not exist yet, at zero units. That is not
 * a stock movement: a shelf label and a quantity are different facts, and only
 * the second one belongs in the ledger.
 */
export async function setItemLocationSettings(
  db: ItemWriter,
  input: ItemLocationSettings,
): Promise<SetItemLocationResult> {
  if (!isOptionalWholeNonNegative(input.safetyStock)) {
    return { outcome: 'invalid', reason: 'safety stock must be a whole number of units' };
  }

  const assignments = {
    ...(input.safetyStock === undefined ? {} : { safetyStock: input.safetyStock }),
    ...(input.bin === undefined ? {} : { bin: input.bin }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };

  await db
    .insert(locationBalances)
    .values({
      businessId: input.businessId,
      canonicalItemId: input.canonicalItemId,
      locationId: input.locationId,
      onHand: 0,
      reserved: 0,
      ...assignments,
    })
    .onConflictDoUpdate({
      target: [
        locationBalances.businessId,
        locationBalances.canonicalItemId,
        locationBalances.locationId,
      ],
      set: { ...assignments, updatedAt: sql`now()` },
    });

  return { outcome: 'saved' };
}

export interface ResolvedItemLocation {
  readonly locationId: string;
  readonly locationCode: string;
  readonly onHand: number;
  readonly reserved: number;
  /** After the business default, item override, and location override resolve. */
  readonly safetyStock: number;
  readonly safetyStockFrom: SafetyStockSource;
  readonly bin: string | null;
  readonly note: string | null;
}

/**
 * One item's stock at every location, with safety stock already resolved.
 *
 * Resolution happens here rather than at each call site because there are three
 * levels and getting the precedence wrong is invisible: the number still looks
 * like a plausible quantity. Callers receive units withheld, and where the
 * figure came from so a screen can say so.
 */
export async function readItemBalances(
  db: SettingsReader & ItemReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<ResolvedItemLocation[]> {
  const settings = await readSettings(db, input.businessId);

  const [item] = await db
    .select({ safetyStockOverride: canonicalItems.safetyStockOverride })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.id, input.canonicalItemId),
      ),
    )
    .limit(1);

  if (item === undefined) {
    return [];
  }

  const rows = await db
    .select({
      locationId: locationBalances.locationId,
      locationCode: locations.code,
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
      locationOverride: locationBalances.safetyStock,
      bin: locationBalances.bin,
      note: locationBalances.note,
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

  return rows.map((row) => {
    const levels = {
      businessDefault: settings.defaultSafetyStock,
      itemOverride: item.safetyStockOverride,
      locationOverride: row.locationOverride,
    };

    return {
      locationId: row.locationId,
      locationCode: row.locationCode,
      onHand: row.onHand,
      reserved: row.reserved,
      safetyStock: effectiveSafetyStock(levels),
      safetyStockFrom: safetyStockSource(levels),
      bin: row.bin,
      note: row.note,
    };
  });
}

function isOptionalWholeNonNegative(value: number | null | undefined): boolean {
  return value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
}
