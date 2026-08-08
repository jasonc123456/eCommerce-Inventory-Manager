import { assertWholeNonNegative } from './errors';

/**
 * Which safety-stock figure applies where (section 8).
 *
 * Section 8 states three things about safety stock that only make sense
 * together: the business default is one unit, a per-item override is allowed
 * *including zero*, and the withheld figure is subtracted per location. So there
 * are three levels and the most specific one that has been set wins.
 *
 * The distinction that does the work is between zero and unset. Withholding
 * nothing is a decision an operator is entitled to make, and it looks nothing
 * like never having been asked — under a default of one unit, the two differ by
 * a real unit of stock on every location of every channel. That is why the
 * narrower levels are nullable rather than defaulting to zero.
 */

export interface SafetyStockLevels {
  /** The business default. One unit unless the owner changed it. */
  readonly businessDefault: number;
  /** Set on the canonical item, applying at every location. */
  readonly itemOverride: number | null;
  /** Set on one item at one location. */
  readonly locationOverride: number | null;
}

/** The number of units actually withheld at one item and one location. */
export function effectiveSafetyStock(levels: SafetyStockLevels): number {
  assertWholeNonNegative(levels.businessDefault, 'businessDefault');
  if (levels.itemOverride !== null) {
    assertWholeNonNegative(levels.itemOverride, 'itemOverride');
  }
  if (levels.locationOverride !== null) {
    assertWholeNonNegative(levels.locationOverride, 'locationOverride');
  }

  return levels.locationOverride ?? levels.itemOverride ?? levels.businessDefault;
}

/** Which level supplied the answer, for explaining a number in the UI. */
export type SafetyStockSource = 'location' | 'item' | 'business';

export function safetyStockSource(levels: SafetyStockLevels): SafetyStockSource {
  if (levels.locationOverride !== null) {
    return 'location';
  }

  return levels.itemOverride !== null ? 'item' : 'business';
}
