import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  fingerprintMatches,
  fingerprintOf,
  type FingerprintValue,
} from './fingerprint';

/**
 * What a person agreed to (section 30, AC-10).
 *
 * The two properties that matter pull against each other, which is why both are
 * asserted rather than one. The hash must be blind to everything that is not
 * meaning — otherwise confirmations fail at random and people learn to click
 * again rather than to read — and it must be sensitive to everything that is,
 * because a preview whose price changed without changing its fingerprint is a
 * confirmation of one number applied to another.
 */

const value: fc.Arbitrary<FingerprintValue> = fc.letrec<{ node: FingerprintValue }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('node'), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('node'), { maxKeys: 4 }),
  ),
})).node;

describe('canonicalize', () => {
  it('ignores the order keys were written in', () => {
    expect(canonicalize({ price: '10.00', currency: 'GBP' })).toBe(
      canonicalize({ currency: 'GBP', price: '10.00' }),
    );
  });

  it('does not ignore the order of a list', () => {
    // Two order lines swapped are a different order to read.
    expect(canonicalize(['a', 'b'])).not.toBe(canonicalize(['b', 'a']));
  });

  it('keeps a nested object distinguishable from the text of one', () => {
    // Without quoting, {"a":"1"} and {"a":1} would both render a:1.
    expect(canonicalize({ a: '1' })).not.toBe(canonicalize({ a: 1 }));
  });

  it('treats the two spellings of zero as one number', () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it('refuses a number that cannot survive being written down', () => {
    // Both would otherwise become `null` and make two different previews agree.
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('distinguishes an absent key from a null one', () => {
    expect(canonicalize({ salePrice: null })).not.toBe(canonicalize({}));
  });
});

describe('fingerprintOf', () => {
  it('is stable across key order, whatever the shape', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), value, { maxKeys: 6 }), (record) => {
        const shuffled = Object.fromEntries(Object.entries(record).reverse());
        expect(fingerprintOf(shuffled)).toBe(fingerprintOf(record));
      }),
    );
  });

  it('changes whenever any value changes', () => {
    fc.assert(
      fc.property(value, value, (left, right) => {
        fc.pre(canonicalize(left) !== canonicalize(right));
        expect(fingerprintOf(left)).not.toBe(fingerprintOf(right));
      }),
    );
  });

  it('is hexadecimal, so it survives a form field unaltered', () => {
    expect(fingerprintOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates a price that moved', () => {
    const before = fingerprintOf({ destination: { price: '10.00', currency: 'GBP' } });
    const after = fingerprintOf({ destination: { price: '10.01', currency: 'GBP' } });
    expect(after).not.toBe(before);
  });
});

describe('fingerprintMatches', () => {
  it('accepts the fingerprint on record', () => {
    const hash = fingerprintOf({ a: 1 });
    expect(fingerprintMatches(hash, hash)).toBe(true);
  });

  it('refuses anything else, including a prefix of the right one', () => {
    const hash = fingerprintOf({ a: 1 });
    expect(fingerprintMatches(hash, fingerprintOf({ a: 2 }))).toBe(false);
    expect(fingerprintMatches(hash, hash.slice(0, 32))).toBe(false);
    expect(fingerprintMatches(hash, '')).toBe(false);
  });
});
