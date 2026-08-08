import { describe, expect, it } from 'vitest';

import { planAllocation, type AllocationInput } from './allocation';
import { DomainError } from './errors';

const ITEM = 'item';
const BOLT = 'bolt';
const PLATE = 'plate';

function availability(
  entries: Readonly<Record<string, Readonly<Record<string, number>>>>,
): AllocationInput['available'] {
  return new Map(
    Object.entries(entries).map(([itemId, byLocation]) => [
      itemId,
      new Map(Object.entries(byLocation)),
    ]),
  );
}

function plain(
  overrides: Partial<AllocationInput> & Pick<AllocationInput, 'available'>,
): AllocationInput {
  return {
    quantity: 1,
    components: [{ canonicalItemId: ITEM, unitsPerOrderedUnit: 1 }],
    locationOrder: ['a', 'b'],
    splitFulfillment: false,
    ...overrides,
  };
}

describe('preferring a single location', () => {
  it('takes the whole line from the highest-priority location that can supply it', () => {
    const plan = planAllocation(
      plain({ quantity: 3, available: availability({ [ITEM]: { a: 2, b: 10 } }) }),
    );

    expect(plan).toMatchObject({ allocated: 3, shortage: 0, splitBlocked: false });
    expect(plan.takes).toEqual([{ canonicalItemId: ITEM, locationId: 'b', quantity: 3 }]);
  });

  it('prefers priority order over the larger pile', () => {
    // Section 9 configures priority for a reason; picking the fullest shelf
    // would quietly override the operator's decision.
    const plan = planAllocation(
      plain({ quantity: 2, available: availability({ [ITEM]: { a: 5, b: 50 } }) }),
    );

    expect(plan.takes).toEqual([{ canonicalItemId: ITEM, locationId: 'a', quantity: 2 }]);
  });

  it('flags the conflict when splitting would have filled the order', () => {
    // Section 9: no single location can fulfil and splitting is disabled, so a
    // high-priority allocation conflict is owed. Units are still allocated —
    // section 11 records the order and allocates what exists.
    const plan = planAllocation(
      plain({ quantity: 5, available: availability({ [ITEM]: { a: 3, b: 4 } }) }),
    );

    expect(plan).toMatchObject({ allocated: 4, shortage: 1, splitBlocked: true });
    expect(plan.takes).toEqual([{ canonicalItemId: ITEM, locationId: 'b', quantity: 4 }]);
  });

  it('does not blame splitting when there is simply not enough stock', () => {
    const plan = planAllocation(
      plain({ quantity: 10, available: availability({ [ITEM]: { a: 1, b: 2 } }) }),
    );

    expect(plan).toMatchObject({ allocated: 2, shortage: 8, splitBlocked: false });
  });

  it('allocates nothing when there is nothing anywhere', () => {
    const plan = planAllocation(plain({ quantity: 2, available: availability({}) }));

    expect(plan).toMatchObject({ allocated: 0, shortage: 2, takes: [] });
  });

  it('allocates nothing when no location is eligible', () => {
    // A mapping whose only selected location has been archived. The line is
    // still recorded; there is simply nowhere for it to come from.
    const plan = planAllocation(
      plain({
        quantity: 2,
        locationOrder: [],
        available: availability({ [ITEM]: { a: 100 } }),
      }),
    );

    expect(plan).toMatchObject({ allocated: 0, shortage: 2, splitBlocked: false, takes: [] });
  });
});

describe('splitting across locations', () => {
  it('walks the priority order taking what each location holds', () => {
    const plan = planAllocation(
      plain({
        quantity: 5,
        splitFulfillment: true,
        available: availability({ [ITEM]: { a: 3, b: 4 } }),
      }),
    );

    expect(plan).toMatchObject({ allocated: 5, shortage: 0, splitBlocked: false });
    expect(plan.takes).toEqual([
      { canonicalItemId: ITEM, locationId: 'a', quantity: 3 },
      { canonicalItemId: ITEM, locationId: 'b', quantity: 2 },
    ]);
  });

  it('stops as soon as the line is filled', () => {
    const plan = planAllocation(
      plain({
        quantity: 4,
        splitFulfillment: true,
        locationOrder: ['a', 'b', 'c'],
        available: availability({ [ITEM]: { a: 3, b: 4, c: 9 } }),
      }),
    );

    // The third location is never touched, so a split is as narrow as it can be.
    expect(plan.takes.map((take) => take.locationId)).toEqual(['a', 'b']);
  });

  it('still reports a shortage when the total is not enough', () => {
    const plan = planAllocation(
      plain({
        quantity: 9,
        splitFulfillment: true,
        available: availability({ [ITEM]: { a: 3, b: 4 } }),
      }),
    );

    expect(plan).toMatchObject({ allocated: 7, shortage: 2, splitBlocked: false });
  });
});

describe('a kit line', () => {
  const kit: readonly { canonicalItemId: string; unitsPerOrderedUnit: number }[] = [
    { canonicalItemId: BOLT, unitsPerOrderedUnit: 2 },
    { canonicalItemId: PLATE, unitsPerOrderedUnit: 1 },
  ];

  it('is bounded by whichever component runs out first', () => {
    const plan = planAllocation({
      quantity: 4,
      components: kit,
      locationOrder: ['a'],
      splitFulfillment: false,
      available: availability({ [BOLT]: { a: 10 }, [PLATE]: { a: 2 } }),
    });

    // Bolts allow five kits, plates allow two.
    expect(plan).toMatchObject({ allocated: 2, shortage: 2 });
    expect(plan.takes).toEqual([
      { canonicalItemId: BOLT, locationId: 'a', quantity: 4 },
      { canonicalItemId: PLATE, locationId: 'a', quantity: 2 },
    ]);
  });

  it('will not assemble one kit from two locations while splitting is disabled', () => {
    // Section 10: components from multiple locations satisfy one kit only when
    // split fulfillment is enabled.
    const plan = planAllocation({
      quantity: 1,
      components: kit,
      locationOrder: ['a', 'b'],
      splitFulfillment: false,
      available: availability({ [BOLT]: { a: 2 }, [PLATE]: { b: 5 } }),
    });

    expect(plan).toMatchObject({ allocated: 0, shortage: 1, takes: [] });
  });

  it('assembles from two locations once splitting is enabled', () => {
    const plan = planAllocation({
      quantity: 3,
      components: kit,
      locationOrder: ['a', 'b'],
      splitFulfillment: true,
      available: availability({ [BOLT]: { a: 4, b: 20 }, [PLATE]: { a: 9, b: 9 } }),
    });

    // Two kits at a, limited by four bolts; the third at b.
    expect(plan.allocated).toBe(3);
    expect(plan.takes).toEqual([
      { canonicalItemId: BOLT, locationId: 'a', quantity: 4 },
      { canonicalItemId: PLATE, locationId: 'a', quantity: 2 },
      { canonicalItemId: BOLT, locationId: 'b', quantity: 2 },
      { canonicalItemId: PLATE, locationId: 'b', quantity: 1 },
    ]);
  });
});

describe('rejecting nonsense', () => {
  it('refuses a zero or fractional order quantity', () => {
    expect(() => planAllocation(plain({ quantity: 0, available: availability({}) }))).toThrow(
      DomainError,
    );
    expect(() => planAllocation(plain({ quantity: 1.5, available: availability({}) }))).toThrow(
      DomainError,
    );
  });

  it('refuses a line with no components', () => {
    expect(() => planAllocation(plain({ components: [], available: availability({}) }))).toThrow(
      DomainError,
    );
  });

  it('refuses a negative availability figure', () => {
    // Section 8 forbids negative physical stock, so a negative figure reaching
    // here means the caller computed availability wrongly rather than that a
    // location owes units.
    expect(() =>
      planAllocation(plain({ quantity: 1, available: availability({ [ITEM]: { a: -3 } }) })),
    ).toThrow(DomainError);
  });

  it('refuses a component that consumes no units', () => {
    expect(() =>
      planAllocation(
        plain({
          components: [{ canonicalItemId: ITEM, unitsPerOrderedUnit: 0 }],
          available: availability({}),
        }),
      ),
    ).toThrow(DomainError);
  });
});
