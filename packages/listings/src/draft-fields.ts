import type { DraftPlatform } from './draft-eligibility';

/**
 * What a draft would say, and what it cannot (sections 6, 13, 14, 30).
 *
 * Section 30's US-11 asks that "unsupported/unknown fields are highlighted".
 * That sentence is the whole design here. A conversion between two catalogues
 * that do not agree about what a product is will always lose something, and the
 * only safe version of losing something is saying so on the screen where
 * somebody is deciding. So this module produces four lists rather than one
 * object:
 *
 *   fields             what the draft would carry
 *   missing            what the destination needs and the source cannot give
 *   requiresSelection  what the destination needs and only a person can choose
 *   unsupported        what the source carries and the destination has nowhere
 *                      to put, which will therefore be dropped
 *
 * `missing` and `requiresSelection` are separated deliberately. Both block, but
 * they ask for different things: `missing` means go and fix the source, and
 * `requiresSelection` means answer a question on this form. Collapsing them into
 * "incomplete" produces a screen that tells somebody to fix twelve things
 * without saying which four of them they can fix here.
 *
 * Nothing in this module publishes, and nothing in it decides that a draft is
 * good enough to publish. It reports what is absent; whether to go ahead is a
 * separate confirmed operation with a separate permission.
 */

export interface Money {
  /** Decimal string. A price that has been through a float is not the price. */
  readonly amount: string;
  readonly currency: string;
}

export type ItemCondition = 'new' | 'refurbished' | 'used' | 'for_parts';

/**
 * The subject in terms neither platform owns.
 *
 * Deliberately smaller than either catalogue. Everything not modelled here is
 * reported as unsupported rather than guessed at, because a guessed category or
 * an invented condition is a listing somebody has to find and correct after a
 * customer has already seen it.
 */
export interface DraftSubject {
  readonly title: string;
  readonly description?: string;
  readonly sku?: string;
  readonly price?: Money;
  readonly quantity?: number;
  readonly imageUrls: readonly string[];
  readonly condition?: ItemCondition;
  readonly weightGrams?: number;
  readonly lengthMm?: number;
  readonly widthMm?: number;
  readonly heightMm?: number;
  /** Free-text category names from the source, as hints for the reviewer. */
  readonly categoryHints: readonly string[];
  /**
   * Named source fields this application does not model.
   *
   * The caller collects these from the provider record it read. Listing them is
   * not an apology — it is the difference between a reviewer who knows the
   * bundled warranty metadata will not survive the conversion and one who finds
   * out from a customer.
   */
  readonly unmodelledFields: readonly string[];
}

export type DraftFieldValue = string | number | boolean | readonly string[];

export interface DraftProjection {
  readonly destination: DraftPlatform;
  readonly fields: Readonly<Record<string, DraftFieldValue>>;
  /** Required by the destination, absent from the source. Go and fix the source. */
  readonly missing: readonly string[];
  /** Required by the destination, only a person can choose. Answer it here. */
  readonly requiresSelection: readonly string[];
  /** Carried by the source, nowhere to put it. It will be dropped. */
  readonly unsupported: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Fields a person must choose because the source cannot imply them.
 *
 * eBay's are section 13's publication requirements minus the ones a product
 * record can supply. Category and aspects are here rather than in `missing`
 * because eBay's taxonomy has no WooCommerce equivalent to derive from — a
 * category picked by string-matching a shop's own category names is how a garden
 * hose ends up under "Medical Supplies".
 */
const EBAY_SELECTIONS = [
  'category',
  'itemAspects',
  'marketplace',
  'listingDuration',
  'inventoryLocation',
  'paymentPolicy',
  'returnPolicy',
  'fulfillmentPolicy',
] as const;

/**
 * WooCommerce's are shorter, because a WooCommerce product is publishable with
 * far less. Visibility and tax status are choices rather than derivations: eBay
 * has no tax-status concept to carry, and defaulting visibility to `publish`
 * would be an automatic publication by another name.
 */
const WOOCOMMERCE_SELECTIONS = ['categories', 'taxStatus', 'catalogVisibility'] as const;

export interface ProjectDraftInput {
  readonly subject: DraftSubject;
  readonly destination: DraftPlatform;
}

export function projectDraft(input: ProjectDraftInput): DraftProjection {
  return input.destination === 'ebay' ? projectToEbay(input.subject) : projectToWoo(input.subject);
}

function projectToEbay(subject: DraftSubject): DraftProjection {
  const fields: Record<string, DraftFieldValue> = { title: subject.title };
  const missing: string[] = [];
  const unsupported: string[] = [...subject.unmodelledFields];
  const warnings: string[] = [];

  if (subject.description !== undefined && subject.description !== '') {
    fields['description'] = subject.description;
  } else {
    missing.push('description');
  }

  // Section 13 lists SKU among the publication requirements, and it is also what
  // ties the resulting listing back to a canonical item. A listing published
  // without one is a listing nobody can map afterwards.
  if (subject.sku !== undefined && subject.sku !== '') {
    fields['sku'] = subject.sku;
  } else {
    missing.push('sku');
  }

  if (subject.price === undefined) {
    missing.push('price');
  } else {
    fields['price'] = subject.price.amount;
    fields['currency'] = subject.price.currency;
  }

  if (subject.imageUrls.length === 0) {
    missing.push('images');
  } else {
    fields['imageUrls'] = subject.imageUrls;
  }

  if (subject.condition === undefined) {
    // WooCommerce has no condition field, so this is the ordinary case coming
    // from a shop rather than an error. It is still required by eBay, and
    // guessing "new" on a reseller's catalogue would be a policy violation
    // written by this application.
    missing.push('condition');
    warnings.push(
      'WooCommerce does not record a condition, so eBay’s must be chosen before the draft can be published',
    );
  } else {
    fields['condition'] = subject.condition;
  }

  // Quantity is carried as a starting figure only. Once the mapping is active
  // the ledger owns it, and section 8 makes every subsequent write absolute.
  if (subject.quantity !== undefined) {
    fields['quantity'] = subject.quantity;
    warnings.push(
      'the quantity is a starting figure; once the mapping is active this application owns it',
    );
  }

  if (subject.weightGrams !== undefined) {
    fields['weightGrams'] = subject.weightGrams;
  }
  for (const [name, value] of [
    ['lengthMm', subject.lengthMm],
    ['widthMm', subject.widthMm],
    ['heightMm', subject.heightMm],
  ] as const) {
    if (value !== undefined) {
      fields[name] = value;
    }
  }

  if (subject.categoryHints.length > 0) {
    // Reported rather than applied. See EBAY_SELECTIONS.
    warnings.push(
      `the source categories (${subject.categoryHints.join(', ')}) are shown as hints; eBay’s category must be chosen deliberately`,
    );
  }

  return {
    destination: 'ebay',
    fields,
    missing,
    requiresSelection: [...EBAY_SELECTIONS],
    unsupported,
    warnings,
  };
}

function projectToWoo(subject: DraftSubject): DraftProjection {
  const fields: Record<string, DraftFieldValue> = {
    name: subject.title,
    // Always simple. Section 6 excludes variable products from conversion in
    // both directions, and section 10 says a kit "may create a normal simple
    // WooCommerce draft" — so there is no other type this can produce.
    type: 'simple',
    // A draft, and stated in the projection rather than left to the caller.
    // Section 30's US-11 requires that "publication is impossible from the draft
    // action", and a projection that could carry `publish` would be one edit
    // away from doing it.
    status: 'draft',
    manageStock: true,
  };
  const missing: string[] = [];
  const unsupported: string[] = [...subject.unmodelledFields];
  const warnings: string[] = [];

  if (subject.description !== undefined && subject.description !== '') {
    fields['description'] = subject.description;
  } else {
    // WooCommerce will publish without one. It is still worth saying.
    warnings.push('the source has no description, so the draft will have an empty one');
  }

  if (subject.sku !== undefined && subject.sku !== '') {
    fields['sku'] = subject.sku;
  } else {
    missing.push('sku');
  }

  if (subject.price === undefined) {
    missing.push('regularPrice');
  } else {
    fields['regularPrice'] = subject.price.amount;
    fields['currency'] = subject.price.currency;
    warnings.push(
      'the currency comes from the source; WooCommerce uses the store currency and will not convert',
    );
  }

  if (subject.imageUrls.length > 0) {
    fields['imageUrls'] = subject.imageUrls;
  } else {
    warnings.push('the source has no images, so the draft will have none');
  }

  if (subject.quantity !== undefined) {
    fields['stockQuantity'] = subject.quantity;
    warnings.push(
      'the quantity is a starting figure; once the mapping is active this application owns it',
    );
  }

  if (subject.weightGrams !== undefined) {
    fields['weightGrams'] = subject.weightGrams;
  }
  for (const [name, value] of [
    ['lengthMm', subject.lengthMm],
    ['widthMm', subject.widthMm],
    ['heightMm', subject.heightMm],
  ] as const) {
    if (value !== undefined) {
      fields[name] = value;
    }
  }

  if (subject.condition !== undefined) {
    // WooCommerce has no condition field. Carrying it into the description would
    // be this application editing somebody's copy.
    unsupported.push('condition');
  }

  if (subject.categoryHints.length > 0) {
    warnings.push(
      `the source categories (${subject.categoryHints.join(', ')}) are shown as hints; WooCommerce categories must be chosen from this store`,
    );
  }

  return {
    destination: 'woocommerce',
    fields,
    missing,
    requiresSelection: [...WOOCOMMERCE_SELECTIONS],
    unsupported,
    warnings,
  };
}

/**
 * Whether a projection could be published if somebody chose to.
 *
 * Answers a question; does not act on it. Both lists must be empty, because
 * "required" means required whether the gap is the source's fault or the
 * reviewer's.
 */
export function draftIsComplete(projection: DraftProjection): boolean {
  return projection.missing.length === 0 && projection.requiresSelection.length === 0;
}

/**
 * A projection with the reviewer's choices filled in.
 *
 * Selections are applied here rather than being merged into the projection by
 * the caller, so that a choice can only ever satisfy a selection the projection
 * actually asked for. A caller that could add arbitrary keys could satisfy
 * `draftIsComplete` by supplying fields eBay never asked about while the
 * category was still unset.
 */
export function applySelections(
  projection: DraftProjection,
  selections: Readonly<Record<string, DraftFieldValue>>,
): DraftProjection {
  const applied: Record<string, DraftFieldValue> = { ...projection.fields };
  const outstanding: string[] = [];

  for (const name of projection.requiresSelection) {
    const value = selections[name];
    if (value === undefined) {
      outstanding.push(name);
      continue;
    }
    applied[name] = value;
  }

  return { ...projection, fields: applied, requiresSelection: outstanding };
}
