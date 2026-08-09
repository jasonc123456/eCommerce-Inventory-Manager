import { createHash } from 'node:crypto';

/**
 * Hashing what a person was shown (sections 13, 14, 30).
 *
 * Section 30's AC-10 requires "exact confirmation": the change that happens must
 * be the change somebody read and agreed to. Comparing the whole preview at
 * confirmation time would work, but it makes the client send back a structure it
 * could edit; comparing a hash means the client can only assert "this is the
 * screen I saw", and any disagreement — a price that moved, a field that
 * changed, a line that was added — refuses the confirmation.
 *
 * The hash therefore has to be stable across everything that does not change
 * meaning, and unstable across everything that does. Key insertion order is not
 * meaning: the same preview built by two code paths that set fields in different
 * orders must hash the same, or confirmations would fail at random and the
 * refusal would teach nobody anything. Values are meaning, all of them.
 *
 * Only the decision-relevant subset is hashed, chosen by the caller. A preview
 * carries explanatory text and timestamps that are true but not what is being
 * agreed to, and hashing a "generated at" field would expire every proposal the
 * moment it was rendered twice.
 */

/** What a fingerprint may be computed over. Deliberately narrow. */
export type FingerprintValue =
  | string
  | number
  | boolean
  | null
  | readonly FingerprintValue[]
  | { readonly [key: string]: FingerprintValue };

/**
 * Canonical text for a value, from which the hash is taken.
 *
 * Exported because a failed comparison is otherwise impossible to explain: with
 * this, a refusal can say which field moved, instead of reporting two hex
 * strings that differ.
 */
export function canonicalize(value: FingerprintValue): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    // Array order is meaning. Two order lines swapped are a different order to
    // read, so they must be a different fingerprint.
    return `[${value.map((item) => canonicalize(item as FingerprintValue)).join(',')}]`;
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // Neither NaN nor an infinity survives JSON, so both would canonicalize to
      // `null` and make two different previews hash alike. Prices and quantities
      // are never either; anything that is has been built wrong upstream.
      throw new TypeError('a fingerprinted value must be a finite number');
    }
    return Object.is(value, -0) ? '0' : String(value);
  }

  const entries = Object.entries(value)
    // Sorted so that key order cannot change the hash. Codepoint order via the
    // default comparator, which is stable across locales — `localeCompare` is
    // not, and a hash that depends on the server's locale is a confirmation
    // that fails after a deployment.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);

  return `{${entries.join(',')}}`;
}

/** The fingerprint of one preview subset. Hex, so it is safe in a form field. */
export function fingerprintOf(value: FingerprintValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * Whether a confirmer's fingerprint is the one on record.
 *
 * A length-independent equality would leak nothing useful here — the value is
 * not a secret and both sides are already known to the confirmer — but the
 * comparison is written once, in one place, so no call site invents a looser
 * one.
 */
export function fingerprintMatches(expected: string, supplied: string): boolean {
  return expected.length === supplied.length && expected === supplied;
}
