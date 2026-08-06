import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_SCOPES,
  REQUESTED_SCOPES,
  SCOPE_CEILING,
  compareScopes,
  isExcluded,
  parseGrantedScopes,
  supports,
} from './scopes';

/**
 * What we ask eBay for (section 13).
 *
 * The tests that matter are about asking for less than we could: a scope
 * requested during a read-only milestone is authority nobody reviewed, and a
 * scope silently recorded because eBay handed it over is authority nobody
 * asked for.
 */

const READ_INVENTORY = 'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly';
const WRITE_INVENTORY = 'https://api.ebay.com/oauth/api_scope/sell.inventory';
const READ_ORDERS = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';

describe('the requested set', () => {
  it('asks for nothing that can change a seller’s listings', () => {
    // M2 is read-only by definition (section 36). An operator reading the
    // consent screen should see a request that matches what the software can
    // currently do.
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.endsWith('.readonly') || scope === 'https://api.ebay.com/oauth/api_scope').toBe(
        true,
      );
    }
  });

  it('stays inside the ceiling', () => {
    for (const scope of REQUESTED_SCOPES) {
      expect(SCOPE_CEILING).toContain(scope);
    }
  });

  it('asks for nothing section 13 excludes', () => {
    for (const scope of [...SCOPE_CEILING, ...REQUESTED_SCOPES]) {
      expect(isExcluded(scope)).toBe(false);
    }
  });

  it('recognises the families this product does not use', () => {
    for (const scope of [
      'https://api.ebay.com/oauth/api_scope/sell.marketing',
      'https://api.ebay.com/oauth/api_scope/sell.finances',
      'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
      'https://api.ebay.com/oauth/api_scope/buy.order.readonly',
    ]) {
      expect(isExcluded(scope)).toBe(true);
    }
  });
});

describe('parseGrantedScopes', () => {
  it('reads the space-separated list', () => {
    expect(parseGrantedScopes(`${READ_INVENTORY} ${READ_ORDERS}`)).toEqual([
      READ_INVENTORY,
      READ_ORDERS,
    ]);
  });

  it('drops a scope we never asked for rather than recording it', () => {
    // A keyset configured with more than we requested would otherwise leave the
    // application appearing to hold an authority it decided not to have, and
    // something would eventually use it.
    const granted = parseGrantedScopes(
      `${READ_INVENTORY} https://api.ebay.com/oauth/api_scope/sell.marketing`,
    );

    expect(granted).toEqual([READ_INVENTORY]);
  });

  it('collapses duplicates and tolerates odd spacing', () => {
    expect(parseGrantedScopes(`  ${READ_INVENTORY}   ${READ_INVENTORY}\n${READ_ORDERS}  `)).toEqual(
      [READ_INVENTORY, READ_ORDERS],
    );
  });

  it('treats an absent scope claim as no scopes', () => {
    expect(parseGrantedScopes(undefined)).toEqual([]);
    expect(parseGrantedScopes('')).toEqual([]);
  });
});

describe('supports', () => {
  it('answers for a capability whose scopes are all held', () => {
    expect(supports([READ_INVENTORY], 'import_catalog')).toBe(true);
    expect(supports([READ_ORDERS], 'import_catalog')).toBe(false);
  });

  it('does not infer a read scope from a write scope', () => {
    // eBay grants what it grants. An inferred implication is how a capability
    // appears to work until the first call fails.
    expect(supports([WRITE_INVENTORY], 'import_catalog')).toBe(false);
  });

  it('refuses an unknown capability rather than trivially allowing it', () => {
    // An empty requirement list would make every typo a permission.
    expect(supports([READ_INVENTORY], 'import_ctalog')).toBe(false);
    expect(supports([], 'anything')).toBe(false);
  });

  it('names a scope set for every capability it claims to know', () => {
    for (const [capability, required] of Object.entries(CAPABILITY_SCOPES)) {
      expect(required.length, capability).toBeGreaterThan(0);
    }
  });
});

describe('compareScopes', () => {
  it('reports what a reauthorization took away', () => {
    const comparison = compareScopes([READ_INVENTORY, READ_ORDERS], [READ_INVENTORY]);

    expect(comparison.lost).toEqual([READ_ORDERS]);
    expect(comparison.gained).toEqual([]);
    expect(comparison.impairedCapabilities).toEqual(['import_orders']);
  });

  it('reports what it added', () => {
    const comparison = compareScopes([READ_INVENTORY], [READ_INVENTORY, READ_ORDERS]);

    expect(comparison.gained).toEqual([READ_ORDERS]);
    expect(comparison.impairedCapabilities).toEqual([]);
  });

  it('does not call a capability impaired when it never worked', () => {
    // Section 13 pauses *affected* capabilities. Something that was never
    // available was not affected by this reauthorization, and listing it in the
    // impact preview would send an operator looking for a regression that is
    // not there.
    const comparison = compareScopes([READ_INVENTORY], [READ_INVENTORY]);

    expect(comparison.impairedCapabilities).toEqual([]);
  });

  it('says nothing changed when nothing changed', () => {
    const scopes = [READ_INVENTORY, READ_ORDERS];

    expect(compareScopes(scopes, scopes)).toEqual({
      lost: [],
      gained: [],
      impairedCapabilities: [],
    });
  });

  it('treats a total loss as impairing everything that worked', () => {
    const comparison = compareScopes([READ_INVENTORY, READ_ORDERS], []);

    expect([...comparison.impairedCapabilities].sort()).toEqual([
      'import_catalog',
      'import_orders',
    ]);
  });
});
