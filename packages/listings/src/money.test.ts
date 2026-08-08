import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AmountError,
  compareAmounts,
  isAmount,
  isSameAmount,
  percentageDifference,
  subtractAmounts,
} from './money';

/**
 * Prices, without floating point (sections 4, 14).
 *
 * The property worth proving is that nothing here goes through a `number`. The
 * cheapest demonstration is 12.50 minus 10.30, which binary floating point
 * answers with 2.1999999999999993 — a figure that would go straight onto a
 * confirmation screen and undo the reason prices are stored as strings.
 */

describe('isAmount', () => {
  it('accepts the shapes a provider quotes', () => {
    for (const text of ['0', '10', '10.5', '10.50', '0.01', '-3.25', ' 12.00 ']) {
      expect(isAmount(text)).toBe(true);
    }
  });

  it('refuses everything else, including the ones that look close', () => {
    for (const text of ['', '.5', '10.', '1e3', '1,000.00', '£10.00', '10.00 GBP', 'NaN']) {
      expect(isAmount(text)).toBe(false);
    }
  });
});

describe('subtractAmounts', () => {
  it('does not go through a float', () => {
    // 12.50 - 10.30 is 2.1999999999999993 in binary floating point.
    expect(subtractAmounts('12.50', '10.30')).toBe('2.20');
  });

  it('keeps the wider of the two scales', () => {
    expect(subtractAmounts('10.5', '10.25')).toBe('0.25');
    expect(subtractAmounts('10', '2')).toBe('8');
  });

  it('reports a decrease as negative', () => {
    expect(subtractAmounts('10.00', '12.50')).toBe('-2.50');
  });

  it('handles amounts far beyond what a double holds exactly', () => {
    expect(subtractAmounts('90071992547409910.01', '0.01')).toBe('90071992547409910.00');
  });

  it('refuses to guess at something that is not an amount', () => {
    expect(() => subtractAmounts('ten', '1')).toThrow(AmountError);
  });
});

describe('compareAmounts', () => {
  it('compares by value, not by text', () => {
    // 10.5 and 10.50 are the same price written twice. A comparison that said
    // otherwise would offer to copy a price onto itself.
    expect(compareAmounts('10.5', '10.50')).toBe(0);
    expect(isSameAmount('10.5', '10.50')).toBe(true);
  });

  it('orders correctly across scales', () => {
    expect(compareAmounts('10.5', '10.45')).toBe(1);
    expect(compareAmounts('9.99', '10')).toBe(-1);
  });

  it('agrees with subtraction, whatever the amounts', () => {
    const amount = fc
      .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 99 }))
      .map(([whole, pence]) => `${String(whole)}.${String(pence).padStart(2, '0')}`);

    fc.assert(
      fc.property(amount, amount, (left, right) => {
        const difference = subtractAmounts(left, right);
        const order = compareAmounts(left, right);

        if (order === 0) {
          expect(Number(difference)).toBe(0);
        } else if (order === 1) {
          expect(Number(difference)).toBeGreaterThan(0);
        } else {
          expect(Number(difference)).toBeLessThan(0);
        }
      }),
    );
  });
});

describe('percentageDifference', () => {
  it('reports a rise and a fall', () => {
    expect(percentageDifference('10.00', '12.50')).toBe('25.00');
    expect(percentageDifference('12.50', '10.00')).toBe('-20.00');
  });

  it('reports no change as zero rather than as nothing', () => {
    expect(percentageDifference('10.00', '10.00')).toBe('0.00');
  });

  it('rounds rather than truncating', () => {
    // A third more, which is 33.333…%.
    expect(percentageDifference('3.00', '4.00')).toBe('33.33');
  });

  it('declines to answer when the starting price is zero', () => {
    // The change from nothing to something has no percentage, and every
    // alternative — infinity, 100% — is a number somebody might act on.
    expect(percentageDifference('0.00', '10.00')).toBeNull();
  });
});
