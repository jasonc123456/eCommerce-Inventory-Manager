import { DomainError, assertWholeNonNegative, assertWholePositive } from './errors';

/**
 * Deciding where an order's units come from (sections 9, 10, 11).
 *
 * Section 9 gives two rules that pull against each other: sales follow the
 * configured location priority and *prefer a single location*, and splitting
 * across locations happens only when a business setting allows it. Preferring
 * one location is not an optimization — a split order is two parcels, two
 * labels, and two shipping charges, which is a decision with a cost the operator
 * has to have agreed to.
 *
 * So with splitting disabled this does not simply walk the priority list taking
 * what it can. It looks for one location that can supply the whole line, and
 * only if none can does it fall back to the best single location, report the
 * shortage, and say whether splitting would have covered it. That last flag is
 * section 9's "high-priority allocation conflict": stock exists, the order
 * cannot be filled from one place, and a person needs to decide.
 *
 * A kit is expressed as several components per ordered unit, so one function
 * serves both an ordinary item — one component, one unit each — and a kit whose
 * capacity at a location is bounded by whichever component runs out first.
 */

/** What one ordered unit consumes. */
export interface AllocationComponent {
  readonly canonicalItemId: string;
  /** Units of this component per one ordered unit. One, for a plain item. */
  readonly unitsPerOrderedUnit: number;
}

export interface AllocationInput {
  /** Ordered units: kits, or plain units of one item. */
  readonly quantity: number;
  readonly components: readonly AllocationComponent[];
  /** Eligible locations, already in priority order (section 9). */
  readonly locationOrder: readonly string[];
  /**
   * Available-to-sell per component per location, after safety stock. Absent
   * entries are zero, which is what an item that has never been at a location
   * has.
   */
  readonly available: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly splitFulfillment: boolean;
}

export interface AllocationTake {
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly quantity: number;
}

export interface AllocationPlan {
  /** Ordered units that can be supplied. */
  readonly allocated: number;
  /** Section 11: recorded explicitly, never as a negative balance. */
  readonly shortage: number;
  /**
   * True when splitting would have filled the line and the business has it
   * disabled. Section 9 owes a high-priority allocation conflict for this.
   */
  readonly splitBlocked: boolean;
  readonly takes: readonly AllocationTake[];
}

export function planAllocation(input: AllocationInput): AllocationPlan {
  assertWholePositive(input.quantity, 'quantity');
  if (input.components.length === 0) {
    throw new DomainError('an allocation needs at least one component');
  }
  for (const component of input.components) {
    assertWholePositive(component.unitsPerOrderedUnit, 'unitsPerOrderedUnit');
  }

  const capacities = new Map<string, number>();
  for (const locationId of input.locationOrder) {
    capacities.set(locationId, capacityAt(input, locationId));
  }

  return input.splitFulfillment
    ? splitPlan(input, capacities)
    : singleLocationPlan(input, capacities);
}

/** How many complete ordered units one location could supply on its own. */
function capacityAt(input: AllocationInput, locationId: string): number {
  let capacity = Number.POSITIVE_INFINITY;

  for (const component of input.components) {
    const here = input.available.get(component.canonicalItemId)?.get(locationId) ?? 0;

    assertWholeNonNegative(here, 'available');
    capacity = Math.min(capacity, Math.floor(here / component.unitsPerOrderedUnit));
  }

  return capacity === Number.POSITIVE_INFINITY ? 0 : capacity;
}

function singleLocationPlan(
  input: AllocationInput,
  capacities: ReadonlyMap<string, number>,
): AllocationPlan {
  // First choice: the highest-priority location that can supply the whole line.
  for (const locationId of input.locationOrder) {
    if ((capacities.get(locationId) ?? 0) >= input.quantity) {
      return {
        allocated: input.quantity,
        shortage: 0,
        splitBlocked: false,
        takes: takesFor(input, locationId, input.quantity),
      };
    }
  }

  // Nothing can fill it alone. Take as much as the best single location holds —
  // section 11 allocates the units that exist rather than refusing the order —
  // and say whether splitting would have covered the rest.
  let best = input.locationOrder[0] ?? null;
  let bestCapacity = 0;
  let total = 0;

  for (const locationId of input.locationOrder) {
    const capacity = capacities.get(locationId) ?? 0;

    total += capacity;
    if (capacity > bestCapacity) {
      best = locationId;
      bestCapacity = capacity;
    }
  }

  return {
    allocated: bestCapacity,
    shortage: input.quantity - bestCapacity,
    splitBlocked: total >= input.quantity && bestCapacity < input.quantity,
    takes: best === null || bestCapacity === 0 ? [] : takesFor(input, best, bestCapacity),
  };
}

function splitPlan(
  input: AllocationInput,
  capacities: ReadonlyMap<string, number>,
): AllocationPlan {
  const takes: AllocationTake[] = [];
  let remaining = input.quantity;

  for (const locationId of input.locationOrder) {
    if (remaining === 0) {
      break;
    }

    const take = Math.min(remaining, capacities.get(locationId) ?? 0);
    if (take > 0) {
      takes.push(...takesFor(input, locationId, take));
      remaining -= take;
    }
  }

  return {
    allocated: input.quantity - remaining,
    shortage: remaining,
    // Splitting is enabled, so nothing was blocked by it being disabled.
    splitBlocked: false,
    takes,
  };
}

function takesFor(
  input: AllocationInput,
  locationId: string,
  orderedUnits: number,
): AllocationTake[] {
  return input.components.map((component) => ({
    canonicalItemId: component.canonicalItemId,
    locationId,
    quantity: orderedUnits * component.unitsPerOrderedUnit,
  }));
}
