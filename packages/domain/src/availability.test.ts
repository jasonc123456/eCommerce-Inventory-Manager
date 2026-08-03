import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  availableToSellAcrossLocations,
  availableToSellAtLocation,
  channelTarget,
  kitAvailability,
  shouldSuppressWooCommerceQuantityWrite,
  type KitComponentRequirement,
  type LocationBalance,
} from './availability';
import { DomainError } from './errors';

const quantity = fc.integer({ min: 0, max: 10_000 });

const locationBalance = (locationId: string): fc.Arbitrary<LocationBalance> =>
  fc.record({
    locationId: fc.constant(locationId),
    onHand: quantity,
    reserved: quantity,
    safetyStock: fc.integer({ min: 0, max: 50 }),
  });

const balanceSet = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 5 })
  .chain((ids) => fc.tuple(...ids.map((id) => locationBalance(id))));

describe('availableToSellAtLocation', () => {
  it('subtracts reservations and safety stock', () => {
    expect(
      availableToSellAtLocation({ locationId: 'a', onHand: 10, reserved: 3, safetyStock: 1 }),
    ).toBe(6);
  });

  it('floors at zero rather than reporting negative stock', () => {
    expect(
      availableToSellAtLocation({ locationId: 'a', onHand: 2, reserved: 5, safetyStock: 1 }),
    ).toBe(0);
  });

  it('is never negative for any valid input', () => {
    fc.assert(
      fc.property(locationBalance('a'), (balance) => {
        expect(availableToSellAtLocation(balance)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('rejects fractional and negative quantities', () => {
    expect(() =>
      availableToSellAtLocation({ locationId: 'a', onHand: 1.5, reserved: 0, safetyStock: 0 }),
    ).toThrow(DomainError);
    expect(() =>
      availableToSellAtLocation({ locationId: 'a', onHand: -1, reserved: 0, safetyStock: 0 }),
    ).toThrow(DomainError);
  });
});

describe('availableToSellAcrossLocations', () => {
  it('sums per-location availability', () => {
    expect(
      availableToSellAcrossLocations([
        { locationId: 'a', onHand: 10, reserved: 0, safetyStock: 1 },
        { locationId: 'b', onHand: 5, reserved: 2, safetyStock: 1 },
      ]),
    ).toBe(9 + 2);
  });

  it('rejects a duplicated location, which would double count real stock', () => {
    expect(() =>
      availableToSellAcrossLocations([
        { locationId: 'a', onHand: 1, reserved: 0, safetyStock: 0 },
        { locationId: 'a', onHand: 1, reserved: 0, safetyStock: 0 },
      ]),
    ).toThrow(DomainError);
  });

  /** Safety stock can only ever withhold units, never conjure them. */
  it('never exceeds the same balances with no safety stock', () => {
    fc.assert(
      fc.property(balanceSet, (balances) => {
        const withSafetyStock = availableToSellAcrossLocations(balances);
        const withoutSafetyStock = availableToSellAcrossLocations(
          balances.map((balance) => ({ ...balance, safetyStock: 0 })),
        );

        expect(withSafetyStock).toBeLessThanOrEqual(withoutSafetyStock);
      }),
    );
  });

  /**
   * D-132: withholding safety stock per location before summing must never
   * advertise more than withholding it once at the aggregate would.
   *
   * Stated over balances where no location floors at zero, which is the case the
   * decision is actually about. Once a location floors, no aggregate expression
   * bounds the per-location sum at all, because flooring discards the excess
   * instead of carrying it; the two tests below pin that down rather than
   * papering over it.
   */
  it('never exceeds the aggregate-then-withhold-once alternative when no location floors', () => {
    const unflooredBalances = fc
      .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 5 })
      .chain((ids) =>
        fc.tuple(
          ...ids.map((id) =>
            fc
              .record({
                locationId: fc.constant(id),
                reserved: fc.integer({ min: 0, max: 100 }),
                safetyStock: fc.integer({ min: 0, max: 50 }),
                surplus: fc.integer({ min: 0, max: 500 }),
              })
              // Construct on-hand so the location always has something left,
              // which is what "does not floor" means.
              .map(({ locationId, reserved, safetyStock, surplus }) => ({
                locationId,
                reserved,
                safetyStock,
                onHand: reserved + safetyStock + surplus,
              })),
          ),
        ),
      );

    fc.assert(
      fc.property(unflooredBalances, (balances) => {
        const perLocationThenSum = availableToSellAcrossLocations(balances);

        const totalOnHand = balances.reduce((sum, balance) => sum + balance.onHand, 0);
        const totalReserved = balances.reduce((sum, balance) => sum + balance.reserved, 0);
        const singleSafetyStock = Math.max(...balances.map((balance) => balance.safetyStock));
        const aggregateThenWithholdOnce = Math.max(
          0,
          totalOnHand - totalReserved - singleSafetyStock,
        );

        expect(perLocationThenSum).toBeLessThanOrEqual(aggregateThenWithholdOnce);
      }),
    );
  });

  /**
   * The flip side of the rule above, and the reason it is stated so narrowly.
   *
   * A location whose safety stock exceeds its stock contributes zero rather than
   * a negative, so its unmet withholding is not carried over to another
   * location. That is correct: safety stock protects units that exist, and a
   * location cannot protect stock it does not hold.
   */
  it('does not carry one location unmet safety stock over to another', () => {
    const balances = [
      { locationId: 'north', onHand: 1, reserved: 0, safetyStock: 0 },
      { locationId: 'south', onHand: 0, reserved: 0, safetyStock: 5 },
    ];

    expect(availableToSellAcrossLocations(balances)).toBe(1);
  });

  /**
   * Flooring at zero happens per location, which means an over-reserved location
   * cannot eat into another location's stock.
   *
   * This is deliberate. Reserving more than a location holds is a shortage at
   * that location, recorded as its own quantity (section 8), not a debt that
   * quietly suppresses availability somewhere the units genuinely exist. A
   * consequence is that the aggregate figure can exceed what a naive
   * sum-the-inputs-first calculation would produce, so the two must never be
   * used interchangeably.
   */
  it('does not let an over-reserved location consume another location, and records no negative', () => {
    const balances = [
      { locationId: 'north', onHand: 10, reserved: 0, safetyStock: 0 },
      { locationId: 'south', onHand: 0, reserved: 10, safetyStock: 0 },
    ];

    expect(availableToSellAcrossLocations(balances)).toBe(10);

    const naiveAggregate = Math.max(0, 10 + 0 - (0 + 10));
    expect(naiveAggregate).toBe(0);
  });
});

describe('channelTarget', () => {
  it('applies the buffer before the cap', () => {
    expect(channelTarget(10, { channelBuffer: 3, channelCap: 5 })).toBe(5);
    expect(channelTarget(10, { channelBuffer: 8, channelCap: 5 })).toBe(2);
  });

  it('is the raw availability when there is no buffer and no cap', () => {
    fc.assert(
      fc.property(quantity, (available) => {
        expect(channelTarget(available, { channelBuffer: 0, channelCap: null })).toBe(available);
      }),
    );
  });

  it('never exceeds availability or the cap, and is never negative', () => {
    fc.assert(
      fc.property(
        quantity,
        quantity,
        fc.option(quantity, { nil: null }),
        (available, buffer, cap) => {
          const target = channelTarget(available, { channelBuffer: buffer, channelCap: cap });
          expect(target).toBeGreaterThanOrEqual(0);
          expect(target).toBeLessThanOrEqual(available);
          if (cap !== null) {
            expect(target).toBeLessThanOrEqual(cap);
          }
        },
      ),
    );
  });

  it('is monotonic in availability, so more stock never advertises less', () => {
    fc.assert(
      fc.property(
        quantity,
        quantity,
        quantity,
        fc.option(quantity, { nil: null }),
        (a, b, buffer, cap) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a];
          const rules = { channelBuffer: buffer, channelCap: cap };
          expect(channelTarget(lower, rules)).toBeLessThanOrEqual(channelTarget(higher, rules));
        },
      ),
    );
  });

  /**
   * D-129: a channel buffer withholds units from one channel only. Two channels
   * drawing on the same pool with different buffers must see different targets,
   * which is exactly what a pool-level safety stock could not express.
   */
  it('withholds from one channel without affecting another', () => {
    const available = 20;
    expect(channelTarget(available, { channelBuffer: 5, channelCap: null })).toBe(15);
    expect(channelTarget(available, { channelBuffer: 0, channelCap: null })).toBe(20);
  });
});

describe('shouldSuppressWooCommerceQuantityWrite', () => {
  it('suppresses only the downward write to zero against negative store stock', () => {
    expect(
      shouldSuppressWooCommerceQuantityWrite({
        desiredTarget: 0,
        observedStoreStock: -3,
        backordersEnabled: true,
      }),
    ).toBe(true);
  });

  it('allows the write when backorders are disabled', () => {
    expect(
      shouldSuppressWooCommerceQuantityWrite({
        desiredTarget: 0,
        observedStoreStock: -3,
        backordersEnabled: false,
      }),
    ).toBe(false);
  });

  it('allows any positive target, which is how stock comes back', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: -100, max: 100 }),
        (target, observed) => {
          expect(
            shouldSuppressWooCommerceQuantityWrite({
              desiredTarget: target,
              observedStoreStock: observed,
              backordersEnabled: true,
            }),
          ).toBe(false);
        },
      ),
    );
  });

  it('allows the write to zero when store stock is already positive', () => {
    expect(
      shouldSuppressWooCommerceQuantityWrite({
        desiredTarget: 0,
        observedStoreStock: 4,
        backordersEnabled: true,
      }),
    ).toBe(false);
  });
});

describe('kitAvailability', () => {
  const balances = (entries: readonly LocationBalance[]): readonly LocationBalance[] => entries;

  it('is limited by the scarcest component', () => {
    const components: KitComponentRequirement[] = [
      { canonicalItemId: 'body', requiredQuantity: 1 },
      { canonicalItemId: 'screw', requiredQuantity: 4 },
    ];
    const componentBalances = new Map([
      ['body', balances([{ locationId: 'main', onHand: 10, reserved: 0, safetyStock: 0 }])],
      ['screw', balances([{ locationId: 'main', onHand: 10, reserved: 0, safetyStock: 0 }])],
    ]);

    expect(kitAvailability({ components, componentBalances, splitFulfillment: false })).toBe(2);
  });

  /** D-133: components keep their safety stock when consumed by a kit. */
  it('respects component safety stock', () => {
    const components: KitComponentRequirement[] = [
      { canonicalItemId: 'body', requiredQuantity: 1 },
    ];
    const componentBalances = new Map([
      ['body', balances([{ locationId: 'main', onHand: 10, reserved: 0, safetyStock: 3 }])],
    ]);

    expect(kitAvailability({ components, componentBalances, splitFulfillment: false })).toBe(7);
  });

  it('returns zero when a component is stocked nowhere', () => {
    const components: KitComponentRequirement[] = [
      { canonicalItemId: 'body', requiredQuantity: 1 },
      { canonicalItemId: 'missing', requiredQuantity: 1 },
    ];
    const componentBalances = new Map([
      ['body', balances([{ locationId: 'main', onHand: 10, reserved: 0, safetyStock: 0 }])],
    ]);

    expect(kitAvailability({ components, componentBalances, splitFulfillment: false })).toBe(0);
  });

  it('cannot assemble across locations unless split fulfillment is enabled', () => {
    const components: KitComponentRequirement[] = [
      { canonicalItemId: 'body', requiredQuantity: 1 },
      { canonicalItemId: 'lid', requiredQuantity: 1 },
    ];
    const componentBalances = new Map([
      ['body', balances([{ locationId: 'north', onHand: 5, reserved: 0, safetyStock: 0 }])],
      ['lid', balances([{ locationId: 'south', onHand: 5, reserved: 0, safetyStock: 0 }])],
    ]);

    expect(kitAvailability({ components, componentBalances, splitFulfillment: false })).toBe(0);
    expect(kitAvailability({ components, componentBalances, splitFulfillment: true })).toBe(5);
  });

  it('never reports less capacity with split fulfillment enabled', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.record({
            onHandNorth: fc.integer({ min: 0, max: 100 }),
            onHandSouth: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (requiredQuantity, componentSpecs) => {
          const components = componentSpecs.map((_, index) => ({
            canonicalItemId: `component-${String(index)}`,
            requiredQuantity,
          }));
          const componentBalances = new Map(
            componentSpecs.map((spec, index) => [
              `component-${String(index)}`,
              balances([
                { locationId: 'north', onHand: spec.onHandNorth, reserved: 0, safetyStock: 0 },
                { locationId: 'south', onHand: spec.onHandSouth, reserved: 0, safetyStock: 0 },
              ]),
            ]),
          );

          const strict = kitAvailability({
            components,
            componentBalances,
            splitFulfillment: false,
          });
          const pooled = kitAvailability({ components, componentBalances, splitFulfillment: true });

          expect(pooled).toBeGreaterThanOrEqual(strict);
          expect(strict).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('never promises more kits than the components can supply', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            onHand: fc.integer({ min: 0, max: 200 }),
            requiredQuantity: fc.integer({ min: 1, max: 6 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (specs) => {
          const components = specs.map((spec, index) => ({
            canonicalItemId: `component-${String(index)}`,
            requiredQuantity: spec.requiredQuantity,
          }));
          const componentBalances = new Map(
            specs.map((spec, index) => [
              `component-${String(index)}`,
              balances([{ locationId: 'main', onHand: spec.onHand, reserved: 0, safetyStock: 0 }]),
            ]),
          );

          const kits = kitAvailability({ components, componentBalances, splitFulfillment: true });

          for (const [index, spec] of specs.entries()) {
            expect(kits * components[index]!.requiredQuantity).toBeLessThanOrEqual(spec.onHand);
          }
        },
      ),
    );
  });

  it('rejects an empty recipe, a duplicated component, and a non-positive quantity', () => {
    const componentBalances = new Map<string, readonly LocationBalance[]>();

    expect(() =>
      kitAvailability({ components: [], componentBalances, splitFulfillment: false }),
    ).toThrow(DomainError);

    expect(() =>
      kitAvailability({
        components: [
          { canonicalItemId: 'a', requiredQuantity: 1 },
          { canonicalItemId: 'a', requiredQuantity: 2 },
        ],
        componentBalances,
        splitFulfillment: false,
      }),
    ).toThrow(DomainError);

    expect(() =>
      kitAvailability({
        components: [{ canonicalItemId: 'a', requiredQuantity: 0 }],
        componentBalances,
        splitFulfillment: false,
      }),
    ).toThrow(DomainError);
  });
});
