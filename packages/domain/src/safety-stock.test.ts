import { describe, expect, it } from 'vitest';

import { DomainError } from './errors';
import { effectiveSafetyStock, safetyStockSource } from './safety-stock';

describe('resolving safety stock', () => {
  it('uses the business default when nothing narrower is set', () => {
    expect(
      effectiveSafetyStock({ businessDefault: 1, itemOverride: null, locationOverride: null }),
    ).toBe(1);
  });

  it('prefers an item override to the business default', () => {
    expect(
      effectiveSafetyStock({ businessDefault: 1, itemOverride: 5, locationOverride: null }),
    ).toBe(5);
  });

  it('prefers a location override to an item override', () => {
    expect(effectiveSafetyStock({ businessDefault: 1, itemOverride: 5, locationOverride: 2 })).toBe(
      2,
    );
  });

  it('treats an override of zero as a decision, not as absence', () => {
    // The whole reason the narrower levels are nullable. Under a default of one
    // unit, reading a stored 0 as "unset" would withhold a unit the operator
    // deliberately released, on every location of every channel.
    expect(
      effectiveSafetyStock({ businessDefault: 1, itemOverride: 0, locationOverride: null }),
    ).toBe(0);
    expect(effectiveSafetyStock({ businessDefault: 1, itemOverride: 5, locationOverride: 0 })).toBe(
      0,
    );
  });

  it('rejects a fractional or negative figure at any level', () => {
    expect(() =>
      effectiveSafetyStock({ businessDefault: -1, itemOverride: null, locationOverride: null }),
    ).toThrow(DomainError);
    expect(() =>
      effectiveSafetyStock({ businessDefault: 1, itemOverride: 1.5, locationOverride: null }),
    ).toThrow(DomainError);
    expect(() =>
      effectiveSafetyStock({ businessDefault: 1, itemOverride: null, locationOverride: -2 }),
    ).toThrow(DomainError);
  });
});

describe('explaining where a figure came from', () => {
  it('names the level that supplied it', () => {
    expect(
      safetyStockSource({ businessDefault: 1, itemOverride: null, locationOverride: null }),
    ).toBe('business');
    expect(safetyStockSource({ businessDefault: 1, itemOverride: 0, locationOverride: null })).toBe(
      'item',
    );
    expect(safetyStockSource({ businessDefault: 1, itemOverride: 0, locationOverride: 0 })).toBe(
      'location',
    );
  });
});
