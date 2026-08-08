import { describe, expect, it } from 'vitest';

import { fingerprintOf } from './events';

/**
 * The fallback identity for events a provider does not number (section 12).
 *
 * Worth its own test because it is the only part of deduplication that is a
 * judgement rather than a database constraint: what counts as "the same
 * payload" decides which redeliveries are collapsed, and a fingerprint that
 * disagreed with itself over key order would let every one of them through.
 */

describe('fingerprintOf', () => {
  it('does not care what order the keys arrived in', () => {
    expect(fingerprintOf({ id: 1, status: 'processing' })).toBe(
      fingerprintOf({ status: 'processing', id: 1 }),
    );
  });

  it('does care what order a list arrived in', () => {
    // A list is ordered by the provider's choice, and two orderings of the same
    // lines are not obviously the same event.
    expect(fingerprintOf([1, 2])).not.toBe(fingerprintOf([2, 1]));
  });

  it('separates values that differ only in type', () => {
    expect(fingerprintOf({ quantity: 1 })).not.toBe(fingerprintOf({ quantity: '1' }));
  });

  it('treats an absent key and an explicitly undefined one as the same', () => {
    expect(fingerprintOf({ id: 1, note: undefined })).toBe(fingerprintOf({ id: 1 }));
  });

  it('distinguishes null from absence', () => {
    // A provider that sends `sku: null` is saying something; one that omits the
    // key is saying nothing.
    expect(fingerprintOf({ sku: null })).not.toBe(fingerprintOf({}));
  });

  it('reaches into nested structures', () => {
    expect(fingerprintOf({ lines: [{ b: 2, a: 1 }] })).toBe(
      fingerprintOf({ lines: [{ a: 1, b: 2 }] }),
    );
    expect(fingerprintOf({ lines: [{ a: 1 }] })).not.toBe(fingerprintOf({ lines: [{ a: 2 }] }));
  });

  it('hashes something for a payload that is not an object at all', () => {
    expect(fingerprintOf(undefined)).toHaveLength(64);
    expect(fingerprintOf('order-1')).not.toBe(fingerprintOf(undefined));
    expect(fingerprintOf(true)).not.toBe(fingerprintOf('true'));
  });
});
