/**
 * Facts a model may not state (sections 7, 10, 18, 30).
 *
 * Section 18 lists them: "AI cannot silently change SKU, inventory, price,
 * currency, condition, legal claims, shipping policy, return policy, or payment
 * policy." Section 30's requirement 25 says the same from the other direction —
 * "protected facts remain source-bound".
 *
 * Two ways to honour that were available, and only one of them survives an edit
 * six months from now. The weak version validates the answer and rejects it when
 * a price appears. The strong version is what is written here: the accepted
 * suggestion types have no field to put a price in, so a model that returns one
 * is not rejected, it is *unable to be recorded*. This module is what turns the
 * second version into a message somebody can read — it names what was dropped,
 * so the screen can say "the model also suggested a price, which was discarded"
 * rather than silently disagreeing with the model in the dark.
 *
 * Matching fails closed on names, exactly as `@eim/audit`'s detail sanitizer
 * does, and for the same reason: the alternative is an allowlist of every name a
 * model might invent, which is not a list anybody can finish. A dropped field
 * that was harmless costs a warning nobody needed. A kept field that was a price
 * costs a listing sold below cost.
 *
 * Nothing here decides whether a suggestion is good. It decides only which parts
 * of it this application refuses to carry, and it does so before the answer
 * reaches any code that could act on it.
 */

/**
 * Name fragments that mark a field as a protected fact.
 *
 * Matched against the key with separators and case removed, so `sku`,
 * `SKU`, `item_sku`, and `itemSku` all match. Some entries are deliberately
 * broad. `policy` catches shipping, return, and payment policy without needing
 * to guess which nouns a model will pair them with, and it is broad in the safe
 * direction: a suggestion has no legitimate policy field of any kind, because
 * every policy on a listing is chosen by a person from what the seller's account
 * actually offers.
 *
 * The identifier fragments — barcode, GTIN, EAN, UPC, MPN — are here because a
 * fabricated product identifier is a legal claim about somebody else's goods,
 * which is the category section 18 names last and cares about most.
 */
const PROTECTED_NAME_FRAGMENTS = [
  'sku',
  'price',
  'pricing',
  'cost',
  'currency',
  'quantity',
  'stock',
  'inventory',
  'available',
  'condition',
  'policy',
  'warranty',
  'guarantee',
  'certification',
  'compliance',
  'barcode',
  'gtin',
  'ean',
  'upc',
  'mpn',
  'isbn',
  'brand',
] as const;

/** The section 18 list in the words a screen should use. */
export const PROTECTED_FACTS = [
  'SKU',
  'inventory and stock quantities',
  'price and currency',
  'item condition',
  'legal and compliance claims',
  'shipping, return, and payment policies',
  'product identifiers such as GTIN, EAN, UPC, and MPN',
] as const;

export function isProtectedFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');

  return PROTECTED_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export interface ProtectedFieldScan {
  /** The names the model used, in the order it used them. */
  readonly names: readonly string[];
  /** A sentence for the screen, or null when the model behaved. */
  readonly summary: string | null;
}

/**
 * Finds every protected name anywhere in a parsed answer.
 *
 * Walks the whole document rather than its top level, because a model asked for
 * item specifics will happily return `[{ name: 'Price', value: '£12' }]`, and a
 * check that only looked at object keys would call that clean. Values are read
 * as well as keys for exactly that shape: a name/value pair whose *name* is a
 * protected fact is the same problem wearing a different hat.
 *
 * Depth-bounded, because the input is untrusted and a deeply nested answer is
 * either a mistake or an attempt to make this walk expensive.
 */
export function scanForProtectedFields(value: unknown): ProtectedFieldScan {
  const found: string[] = [];
  walk(value, 0, found);

  const names = [...new Set(found)];

  return {
    names,
    summary:
      names.length === 0
        ? null
        : `the model also returned ${names.join(', ')}, which this application never takes from a model`,
  };
}

const MAX_DEPTH = 6;

function walk(value: unknown, depth: number, found: string[]): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, depth + 1, found);
    }
    return;
  }

  const record = value as Record<string, unknown>;

  for (const [key, entry] of Object.entries(record)) {
    if (isProtectedFieldName(key)) {
      found.push(key);
    }

    // The name/value shape. `{ name: 'Condition', value: 'New' }` is how every
    // marketplace models an attribute, and it is how a protected fact arrives
    // when the top-level keys are all innocent.
    if (key.toLowerCase() === 'name' && typeof entry === 'string' && isProtectedFieldName(entry)) {
      found.push(entry);
    }

    walk(entry, depth + 1, found);
  }
}
