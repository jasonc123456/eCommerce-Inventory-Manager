import type { ListingLifecycleState } from '@eim/providers';

/**
 * Which listings may be returned to sale (sections 6, 7, 13).
 *
 * Section 6 grants exactly one sentence of permission — "confirmed positive
 * stock can return eligible listing to sale" — and the word carrying the weight
 * is *eligible*. The row above it in the same table is the one this module
 * mostly exists to refuse: "ended eBay listing … never automatically relisted".
 *
 * The two look almost identical from the outside. Both are listings a customer
 * cannot buy from. The difference is that a listing hidden by eBay's
 * out-of-stock control is still a listing — its identifier, its history, its
 * fees, and its duration all continue — while an ended one is over, and putting
 * it back means creating something new, paying an insertion fee, and starting a
 * fresh duration. Section 6 keeps those apart on purpose, and confusing them
 * would let a screen labelled "back in stock" quietly relist things.
 *
 * The other refusal worth stating: without out-of-stock control enabled, hitting
 * zero *ends* an eBay listing rather than hiding it, so a seller who has not
 * enabled it has nothing to return to sale however much stock arrives. Section
 * 13's operator checklist asks for it to be turned on; this is what happens when
 * it has not been.
 */

export type RestockVerdict =
  | 'eligible'
  | 'already_live'
  | 'listing_ended'
  | 'out_of_stock_control_disabled'
  | 'no_stock'
  | 'mapping_not_active';

export interface RestockSubject {
  readonly listingState: ListingLifecycleState;
  readonly outOfStockControlEnabled: boolean;
  /** What the ledger says can be sold through this mapping right now. */
  readonly availableToSell: number;
  /** The mapping's status. Only an active mapping may write to a channel. */
  readonly mappingStatus: 'draft' | 'approved' | 'active' | 'paused' | 'archived';
}

export interface RestockEligibility {
  readonly verdict: RestockVerdict;
  readonly reason: string;
  /** The quantity to return to sale with. Present only when eligible. */
  readonly quantity?: number;
}

export function assessRestockEligibility(subject: RestockSubject): RestockEligibility {
  // Ended first, because it is the answer that sends somebody to a different
  // screen entirely. Telling them the mapping is paused when the listing is over
  // would have them fix the mapping and try again for nothing.
  if (subject.listingState === 'ended') {
    return {
      verdict: 'listing_ended',
      reason:
        'this listing has ended; ending is not undone by stock arriving, and relisting is a separate decision with its own fees and duration',
    };
  }

  if (subject.listingState === 'active') {
    return {
      verdict: 'already_live',
      reason:
        'this listing is already on sale; its quantity is carried by ordinary synchronization rather than by this action',
    };
  }

  if (!subject.outOfStockControlEnabled) {
    return {
      verdict: 'out_of_stock_control_disabled',
      reason:
        'this seller account does not have eBay’s out-of-stock control enabled, so a listing that reached zero was ended rather than hidden',
    };
  }

  // Section 7's activation gate, restated here rather than assumed. A mapping
  // that is paused was paused for a reason, and returning its listing to sale
  // would be the one write that reason was meant to prevent.
  if (subject.mappingStatus !== 'active') {
    return {
      verdict: 'mapping_not_active',
      reason: `this mapping is ${subject.mappingStatus}; only an active mapping may write to a channel`,
    };
  }

  if (subject.availableToSell <= 0) {
    return {
      verdict: 'no_stock',
      reason:
        'there is nothing available to sell, and a listing returned to sale with no stock would be hidden again immediately',
    };
  }

  return {
    verdict: 'eligible',
    reason: 'this listing can be returned to sale',
    quantity: subject.availableToSell,
  };
}

export function mayRestock(eligibility: RestockEligibility): boolean {
  return eligibility.verdict === 'eligible';
}
