/**
 * What this application asks eBay for, and what it refuses to ask for
 * (section 13).
 *
 * Two lists, because they answer different questions.
 *
 * The ceiling is everything the finished product will ever need. It is written
 * down so that a future milestone adding a capability has to notice it is
 * widening the ask, rather than adding a scope string next to a call site.
 *
 * The requested set is what a connection is created with today. M2 is read-only
 * by definition (section 36), so it asks for read scopes and identity, and
 * nothing that could change a seller's listings. That is not merely tidy: an
 * operator who connects during M2 and then reads the consent screen should see
 * a request that matches what the software can currently do.
 *
 * Section 13's exclusions are permanent rather than deferred — marketing,
 * advertising, finances, analytics, buying, and messaging are not part of this
 * product — and are listed here so that a scope arriving from eBay in that
 * family is recognised as one we never asked for.
 */

/** Every scope the product will need by version 1. */
export const SCOPE_CEILING: readonly string[] = [
  // Base API access. Everything else is additional to this.
  'https://api.ebay.com/oauth/api_scope',
  // Inventory: items, offers, drafts, quantities, prices, and locations.
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  // Orders, packages, fulfillments, and tracking.
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  // Business policies and seller preferences. Write is present for the
  // separately confirmed policy actions section 13 allows, and for nothing else.
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  // The immutable seller identity a connection is bound to.
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];

/**
 * What a connection is created with in M2.
 *
 * Read-only, plus identity. Note that the scope strings say `api.ebay.com` in
 * both environments: they are identifiers rather than addresses, and sandbox
 * uses the same ones.
 */
export const REQUESTED_SCOPES: readonly string[] = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];

/** Scope families this product does not use and will not request. */
const EXCLUDED_FAMILIES: readonly string[] = [
  'sell.marketing',
  'sell.analytics',
  'sell.finances',
  'sell.payment',
  'buy.',
  'commerce.notification.subscription', // Managed with an application token, not a user one.
  'sell.item.draft',
  'sell.reputation',
];

/** Whether a scope is one section 13 excludes. */
export function isExcluded(scope: string): boolean {
  return EXCLUDED_FAMILIES.some((family) => scope.includes(family));
}

/**
 * What a capability needs, so a missing scope can be explained in terms of what
 * stopped working rather than in terms of a URL.
 */
export const CAPABILITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  import_catalog: ['https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'],
  import_orders: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'],
  import_policies: ['https://api.ebay.com/oauth/api_scope/sell.account.readonly'],
  identify_seller: ['https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'],
  write_quantities: ['https://api.ebay.com/oauth/api_scope/sell.inventory'],
  write_fulfillments: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment'],
};

export interface ScopeComparison {
  /** Scopes held before that are not held now. */
  readonly lost: readonly string[];
  /** Scopes held now that were not held before. */
  readonly gained: readonly string[];
  /** Capabilities that stop working because a scope they need was lost. */
  readonly impairedCapabilities: readonly string[];
}

/**
 * What changed between one grant and the next.
 *
 * Section 13 pauses affected capabilities after an impact preview when a
 * reauthorization returns fewer scopes. That preview is only possible if the
 * comparison names capabilities rather than scopes: "you will stop importing
 * orders" is a sentence an operator can act on, and a URL is not.
 *
 * A read scope implied by a write scope is deliberately *not* inferred. eBay
 * grants what it grants, and inferring an implication we were not given is how
 * a capability appears to work until the first call fails.
 */
export function compareScopes(
  previous: readonly string[],
  current: readonly string[],
): ScopeComparison {
  const before = new Set(previous);
  const after = new Set(current);

  const lost = previous.filter((scope) => !after.has(scope));
  const gained = current.filter((scope) => !before.has(scope));

  const impairedCapabilities = Object.entries(CAPABILITY_SCOPES)
    .filter(
      ([, required]) =>
        // Was usable, and is not any more. A capability that never worked is
        // not an impact of this reauthorization.
        required.every((scope) => before.has(scope)) && required.some((scope) => !after.has(scope)),
    )
    .map(([capability]) => capability);

  return { lost, gained, impairedCapabilities };
}

/** Whether every scope a capability needs is present. */
export function supports(granted: readonly string[], capability: string): boolean {
  const required = CAPABILITY_SCOPES[capability];

  if (required === undefined) {
    // An unknown capability is not supported, rather than trivially supported
    // by an empty requirement list. A typo must not read as permission.
    return false;
  }

  const held = new Set(granted);

  return required.every((scope) => held.has(scope));
}

/**
 * Reads the space-separated scope list eBay returns with a token.
 *
 * Excluded scopes are dropped rather than stored. If eBay ever grants one — a
 * keyset configured with more than we asked for, an application-level default —
 * recording it would make this application appear to hold an authority it has
 * decided not to have, and something would eventually use it.
 */
export function parseGrantedScopes(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0 && !isExcluded(scope)),
    ),
  ];
}
