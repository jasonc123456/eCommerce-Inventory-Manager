import { businessInventorySettings, type ConsumptionMode, type Database } from '@eim/db';
import { eq } from 'drizzle-orm';

/**
 * Per-business inventory policy (sections 8, 9, 11).
 *
 * A business has these settings from the moment it exists, whether or not a row
 * has been written for it. Reading returns the defaults for a business that has
 * never been configured, so that every caller downstream — availability, kit
 * capacity, allocation — receives a number rather than a null it would have to
 * invent a meaning for.
 */

export type SettingsReader = Pick<Database, 'select'>;
export type SettingsWriter = Pick<Database, 'select' | 'insert' | 'update'>;

export interface InventorySettings {
  readonly businessId: string;
  /** Section 8: one unit unless the owner changed it. */
  readonly defaultSafetyStock: number;
  readonly consumptionMode: ConsumptionMode;
  /** Section 9: splitting one order across locations is opt-in. */
  readonly splitFulfillment: boolean;
  /** False when this business has never been configured and is on defaults. */
  readonly configured: boolean;
}

export const DEFAULT_SAFETY_STOCK = 1;
export const DEFAULT_CONSUMPTION_MODE: ConsumptionMode = 'reserve_until_fulfilled';

export function defaultSettings(businessId: string): InventorySettings {
  return {
    businessId,
    defaultSafetyStock: DEFAULT_SAFETY_STOCK,
    consumptionMode: DEFAULT_CONSUMPTION_MODE,
    splitFulfillment: false,
    configured: false,
  };
}

export async function readSettings(
  db: SettingsReader,
  businessId: string,
): Promise<InventorySettings> {
  const [row] = await db
    .select({
      defaultSafetyStock: businessInventorySettings.defaultSafetyStock,
      consumptionMode: businessInventorySettings.consumptionMode,
      splitFulfillment: businessInventorySettings.splitFulfillment,
    })
    .from(businessInventorySettings)
    .where(eq(businessInventorySettings.businessId, businessId))
    .limit(1);

  if (row === undefined) {
    return defaultSettings(businessId);
  }

  return { businessId, ...row, configured: true };
}

export interface SettingsChange {
  readonly businessId: string;
  readonly defaultSafetyStock?: number;
  readonly splitFulfillment?: boolean;
  readonly now?: Date;
}

export type SettingsUpdateResult =
  | { readonly outcome: 'updated'; readonly settings: InventorySettings }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Changes the settings a business can change freely.
 *
 * The consumption mode is deliberately absent. Section 11 allows a switch only
 * after an impact preview and either no open reservations or a confirmed
 * migration of the ones that exist, so it is a workflow rather than a field
 * assignment and lives with reservations.
 */
export async function updateSettings(
  db: SettingsWriter,
  change: SettingsChange,
): Promise<SettingsUpdateResult> {
  if (change.defaultSafetyStock !== undefined && !isWholeNonNegative(change.defaultSafetyStock)) {
    return { outcome: 'invalid', reason: 'default safety stock must be a whole number of units' };
  }

  const current = await readSettings(db, change.businessId);
  const next = {
    defaultSafetyStock: change.defaultSafetyStock ?? current.defaultSafetyStock,
    splitFulfillment: change.splitFulfillment ?? current.splitFulfillment,
  };

  await db
    .insert(businessInventorySettings)
    .values({
      businessId: change.businessId,
      ...next,
      consumptionMode: current.consumptionMode,
      ...(change.now === undefined ? {} : { updatedAt: change.now }),
    })
    .onConflictDoUpdate({
      target: businessInventorySettings.businessId,
      set: { ...next, updatedAt: change.now ?? new Date() },
    });

  return {
    outcome: 'updated',
    settings: {
      businessId: change.businessId,
      consumptionMode: current.consumptionMode,
      ...next,
      configured: true,
    },
  };
}

function isWholeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
