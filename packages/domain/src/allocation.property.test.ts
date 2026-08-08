import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { planAllocation, type AllocationInput } from './allocation';
import { effectiveSafetyStock } from './safety-stock';

/**
 * Properties of allocation and safety stock (sections 8, 9, 11, 36).
 *
 * Section 36's exit gate for this milestone names property invariants. The ones
 * worth stating are the ones an example test cannot reach: that no plan ever
 * takes more than exists anywhere, whatever the shape of the stock; that
 * allocated and short always account for exactly the order; and that turning
 * splitting on can never fill less of an order than leaving it off.
 *
 * That last one is the interesting one. It is not obvious — splitting changes
 * which locations are chosen, not merely how many — and it is the property that
 * would break if the single-location path ever preferred priority over quantity
 * when it had already given up on filling the line from one place.
 */

const locationIds = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), {
  minLength: 1,
  maxLength: 4,
});

const componentIds = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), {
  minLength: 1,
  maxLength: 3,
});

/** An order line over some components and some locations, with stock at each. */
const scenario = fc
  .tuple(locationIds, componentIds, fc.integer({ min: 1, max: 40 }), fc.boolean())
  .chain(([locations, components, quantity, splitFulfillment]) =>
    fc
      .tuple(
        fc.array(fc.integer({ min: 1, max: 4 }), {
          minLength: components.length,
          maxLength: components.length,
        }),
        fc.array(fc.integer({ min: 0, max: 60 }), {
          minLength: components.length * locations.length,
          maxLength: components.length * locations.length,
        }),
      )
      .map(([perUnit, stock]): AllocationInput => {
        const available = new Map<string, Map<string, number>>();

        components.forEach((componentId, componentIndex) => {
          const byLocation = new Map<string, number>();

          locations.forEach((locationId, locationIndex) => {
            byLocation.set(
              locationId,
              stock[componentIndex * locations.length + locationIndex] ?? 0,
            );
          });
          available.set(componentId, byLocation);
        });

        return {
          quantity,
          components: components.map((canonicalItemId, index) => ({
            canonicalItemId,
            unitsPerOrderedUnit: perUnit[index] ?? 1,
          })),
          locationOrder: locations,
          available,
          splitFulfillment,
        };
      }),
  );

function takenPerLocation(
  input: AllocationInput,
  componentId: string,
  locationId: string,
  plan: ReturnType<typeof planAllocation>,
): number {
  return plan.takes
    .filter((take) => take.canonicalItemId === componentId && take.locationId === locationId)
    .reduce((total, take) => total + take.quantity, 0);
}

describe('an allocation plan', () => {
  it('never takes more than a location holds', () => {
    // The invariant the database would otherwise have to catch, and the one
    // that decides whether this system oversells.
    fc.assert(
      fc.property(scenario, (input) => {
        const plan = planAllocation(input);

        for (const component of input.components) {
          for (const locationId of input.locationOrder) {
            const held = input.available.get(component.canonicalItemId)?.get(locationId) ?? 0;

            expect(
              takenPerLocation(input, component.canonicalItemId, locationId, plan),
            ).toBeLessThanOrEqual(held);
          }
        }
      }),
    );
  });

  it('accounts for exactly the order', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const plan = planAllocation(input);

        expect(plan.allocated + plan.shortage).toBe(input.quantity);
        expect(plan.allocated).toBeGreaterThanOrEqual(0);
        expect(plan.shortage).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('takes exactly the units the allocated quantity requires', () => {
    // A plan that allocated three kits but took components for two would ship a
    // box with a part missing.
    fc.assert(
      fc.property(scenario, (input) => {
        const plan = planAllocation(input);

        for (const component of input.components) {
          const taken = plan.takes
            .filter((take) => take.canonicalItemId === component.canonicalItemId)
            .reduce((total, take) => total + take.quantity, 0);

          expect(taken).toBe(plan.allocated * component.unitsPerOrderedUnit);
        }
      }),
    );
  });

  it('fills at least as much when splitting is allowed', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const withoutSplitting = planAllocation({ ...input, splitFulfillment: false });
        const withSplitting = planAllocation({ ...input, splitFulfillment: true });

        expect(withSplitting.allocated).toBeGreaterThanOrEqual(withoutSplitting.allocated);
      }),
    );
  });

  it('only reports a blocked split when splitting would actually have helped', () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const plan = planAllocation({ ...input, splitFulfillment: false });

        if (!plan.splitBlocked) {
          return;
        }

        const split = planAllocation({ ...input, splitFulfillment: true });

        expect(split.allocated).toBeGreaterThan(plan.allocated);
      }),
    );
  });

  it('keeps one kit whole at one location while splitting is off', () => {
    // Section 10: components from multiple locations satisfy one kit only when
    // split fulfillment is enabled.
    fc.assert(
      fc.property(scenario, (input) => {
        const plan = planAllocation({ ...input, splitFulfillment: false });
        const locationsUsed = new Set(plan.takes.map((take) => take.locationId));

        expect(locationsUsed.size).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('safety stock resolution', () => {
  it('always answers with one of the three levels', () => {
    fc.assert(
      fc.property(
        fc.record({
          businessDefault: fc.integer({ min: 0, max: 20 }),
          itemOverride: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
          locationOverride: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
        }),
        (levels) => {
          const resolved = effectiveSafetyStock(levels);

          expect([levels.locationOverride, levels.itemOverride, levels.businessDefault]).toContain(
            resolved,
          );
        },
      ),
    );
  });

  it('ignores wider levels once a narrower one is set', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (businessDefault, itemOverride, locationOverride) => {
          expect(effectiveSafetyStock({ businessDefault, itemOverride, locationOverride })).toBe(
            locationOverride,
          );
          expect(
            effectiveSafetyStock({ businessDefault, itemOverride, locationOverride: null }),
          ).toBe(itemOverride);
        },
      ),
    );
  });
});
