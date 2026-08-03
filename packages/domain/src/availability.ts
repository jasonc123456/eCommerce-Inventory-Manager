import { DomainError, assertWholeNonNegative, assertWholePositive } from './errors';

/**
 * Canonical availability calculation.
 *
 * Every number here is a whole count of physical units. Availability is never
 * negative: a shortage is recorded as its own quantity elsewhere in the ledger
 * rather than as negative stock (section 8).
 *
 * The order of operations matters and is fixed by D-132. Safety stock is
 * withheld per location, then locations are summed, and only then does a
 * per-channel buffer or cap apply. Withholding safety stock once at the
 * aggregate would advertise units that no single location can actually supply.
 */

/** Stock held for one canonical item at one location. */
export interface LocationBalance {
  readonly locationId: string;
  /** Physical units believed to exist at this location. */
  readonly onHand: number;
  /** Units committed to qualifying orders but not yet consumed or shipped. */
  readonly reserved: number;
  /** Units withheld from sale at this location. Defaults to one per business. */
  readonly safetyStock: number;
}

/** How one channel mapping narrows the shared pool for its own channel. */
export interface ChannelProjectionRules {
  /**
   * Units withheld from this channel only (D-129). A per-channel override is a
   * buffer, not a second pool-level safety stock: it hides units from one
   * channel without hiding them from the others.
   */
  readonly channelBuffer: number;
  /** Hard ceiling on advertised quantity, or null when the channel has no cap. */
  readonly channelCap: number | null;
}

/**
 * `available_to_sell` for a single location.
 *
 * Note that reserved and safety stock are both subtracted, so a location whose
 * entire stock is reserved contributes nothing even before safety stock applies.
 */
export function availableToSellAtLocation(balance: LocationBalance): number {
  assertWholeNonNegative(balance.onHand, 'onHand');
  assertWholeNonNegative(balance.reserved, 'reserved');
  assertWholeNonNegative(balance.safetyStock, 'safetyStock');

  return Math.max(0, balance.onHand - balance.reserved - balance.safetyStock);
}

/**
 * Availability across the locations a mapping has selected.
 *
 * Sums the per-location results rather than aggregating the inputs first, per
 * D-132. Duplicate location identifiers are rejected because they would double
 * count real stock.
 */
export function availableToSellAcrossLocations(balances: readonly LocationBalance[]): number {
  const seen = new Set<string>();
  let total = 0;

  for (const balance of balances) {
    if (seen.has(balance.locationId)) {
      throw new DomainError(
        `location ${balance.locationId} appears more than once in one calculation`,
      );
    }
    seen.add(balance.locationId);
    total += availableToSellAtLocation(balance);
  }

  return total;
}

/**
 * The absolute quantity to advertise on one channel.
 *
 * `channel_target = min(max(0, available_to_sell - channel_buffer), channel_cap)`
 */
export function channelTarget(availableToSell: number, rules: ChannelProjectionRules): number {
  assertWholeNonNegative(availableToSell, 'availableToSell');
  assertWholeNonNegative(rules.channelBuffer, 'channelBuffer');
  if (rules.channelCap !== null) {
    assertWholeNonNegative(rules.channelCap, 'channelCap');
  }

  const afterBuffer = Math.max(0, availableToSell - rules.channelBuffer);
  return rules.channelCap === null ? afterBuffer : Math.min(afterBuffer, rules.channelCap);
}

/**
 * Whether a WooCommerce quantity write must be suppressed to preserve the
 * store's backorder demand count (D-130).
 *
 * A backorder-enabled product records unfulfilled demand as negative store
 * stock. Writing an absolute zero over that erases the merchant's record of how
 * many units they owe. Upward writes and writes to a positive target are always
 * allowed; only the downward write to zero against already-negative stock is
 * held back, and the canonical shortage record remains authoritative either way.
 */
export function shouldSuppressWooCommerceQuantityWrite(params: {
  readonly desiredTarget: number;
  readonly observedStoreStock: number;
  readonly backordersEnabled: boolean;
}): boolean {
  assertWholeNonNegative(params.desiredTarget, 'desiredTarget');

  return params.backordersEnabled && params.desiredTarget === 0 && params.observedStoreStock <= 0;
}

/** One line of a kit recipe. */
export interface KitComponentRequirement {
  readonly canonicalItemId: string;
  /** Positive whole number of component units consumed by one kit. */
  readonly requiredQuantity: number;
}

export interface KitAvailabilityInput {
  readonly components: readonly KitComponentRequirement[];
  /** Per-component location balances, keyed by canonical item identifier. */
  readonly componentBalances: ReadonlyMap<string, readonly LocationBalance[]>;
  /**
   * When false, one kit must be satisfied entirely from a single location, so
   * capacity is computed per location and then summed. When true, components may
   * come from different locations, so each component is aggregated first.
   */
  readonly splitFulfillment: boolean;
}

/**
 * How many kits can be assembled from current component availability.
 *
 * A kit has no independent physical stock. Capacity divides each component's
 * `available_to_sell` after that component's safety stock (D-133), so kits
 * inherit component protection and can never consume protected units.
 */
export function kitAvailability(input: KitAvailabilityInput): number {
  if (input.components.length === 0) {
    throw new DomainError('a kit recipe must contain at least one component');
  }

  const componentIds = new Set<string>();
  for (const component of input.components) {
    assertWholePositive(component.requiredQuantity, 'requiredQuantity');
    if (componentIds.has(component.canonicalItemId)) {
      throw new DomainError(
        `component ${component.canonicalItemId} appears more than once in one recipe`,
      );
    }
    componentIds.add(component.canonicalItemId);
  }

  return input.splitFulfillment ? kitAvailabilityPooled(input) : kitAvailabilityPerLocation(input);
}

/** Split fulfillment enabled: aggregate each component, then take the minimum. */
function kitAvailabilityPooled(input: KitAvailabilityInput): number {
  let capacity = Number.POSITIVE_INFINITY;

  for (const component of input.components) {
    const balances = input.componentBalances.get(component.canonicalItemId) ?? [];
    const available = availableToSellAcrossLocations(balances);
    capacity = Math.min(capacity, Math.floor(available / component.requiredQuantity));
  }

  return capacity === Number.POSITIVE_INFINITY ? 0 : capacity;
}

/**
 * Split fulfillment disabled: each kit is satisfied from one location, so
 * capacity is the minimum across components at that location, summed over
 * locations. This is deliberately more conservative than pooling.
 */
function kitAvailabilityPerLocation(input: KitAvailabilityInput): number {
  const locationIds = new Set<string>();
  for (const component of input.components) {
    for (const balance of input.componentBalances.get(component.canonicalItemId) ?? []) {
      locationIds.add(balance.locationId);
    }
  }

  let total = 0;

  for (const locationId of locationIds) {
    let capacityHere = Number.POSITIVE_INFINITY;

    for (const component of input.components) {
      const balances = input.componentBalances.get(component.canonicalItemId) ?? [];
      const balance = balances.find((candidate) => candidate.locationId === locationId);
      const available = balance === undefined ? 0 : availableToSellAtLocation(balance);
      capacityHere = Math.min(capacityHere, Math.floor(available / component.requiredQuantity));
    }

    total += capacityHere === Number.POSITIVE_INFINITY ? 0 : capacityHere;
  }

  return total;
}
