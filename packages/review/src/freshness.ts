import type { ReviewedOperationKind } from '@eim/db';

/**
 * How long a review stays valid (sections 13, 14, 21, 30).
 *
 * Two clocks, not one, and conflating them is the mistake this module exists to
 * avoid.
 *
 * Source freshness asks whether the numbers are still true. It runs from the
 * moment the provider values were read, and it is short: a price copy confirmed
 * against a price read an hour ago proposes to overwrite whatever the price is
 * now with whatever it was then, which is precisely the "recurring price
 * synchronization" section 3 excludes, arriving by accident.
 *
 * Proposal expiry asks whether the intent is still current. It runs from the
 * proposal and it is longer, because reviewing a draft's fields or an order's
 * addresses and lines is real work and being timed out mid-read teaches people
 * to confirm without reading — which defeats the entire point of a reviewed
 * operation.
 *
 * The windows below are deliberate rather than uniform, and each is set by how
 * fast the thing being agreed to actually moves. Nothing here reads a clock; the
 * caller supplies `now`, which is what makes these rules testable as properties
 * rather than by waiting.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export interface ReviewWindow {
  /** How old the provider read behind the preview may be at confirmation. */
  readonly sourceMaxAgeMs: number;
  /** How long the proposal itself may sit unconfirmed. */
  readonly proposalTtlMs: number;
}

const WINDOWS: Readonly<Record<ReviewedOperationKind, ReviewWindow>> = {
  // A catalog record: title, description, images, categories. It changes when
  // somebody edits it, which is rarely, and the review is long because every
  // field is being checked against the other platform's requirements.
  draft_create: { sourceMaxAgeMs: 30 * MINUTE, proposalTtlMs: 60 * MINUTE },

  // Publication is what the public sees, so the draft being published must
  // still be the draft that was reviewed. Shorter than creating it: the review
  // already happened, and this confirmation is about the act, not the fields.
  draft_publish: { sourceMaxAgeMs: 15 * MINUTE, proposalTtlMs: 30 * MINUTE },

  // The shortest source window of the five. A price is the value most likely to
  // have been edited on the channel while somebody was looking at a comparison
  // of it, and section 14 is explicit that "external price edits refresh
  // comparisons and are not overwritten automatically" — a stale confirmation
  // would overwrite exactly such an edit.
  price_copy: { sourceMaxAgeMs: 5 * MINUTE, proposalTtlMs: 15 * MINUTE },

  // Quantity moves faster than anything else here; a sale can invalidate this
  // between the read and the click. Section 6 allows "confirmed positive stock"
  // to return a listing to sale, and stock confirmed from a five-minute-old read
  // is the most this can honestly claim.
  restock_to_live: { sourceMaxAgeMs: 5 * MINUTE, proposalTtlMs: 10 * MINUTE },

  // The order's own values barely move once it is paid, but the review is the
  // longest of the five: section 11 requires the user to see "all customer,
  // address, line, amount, tax, shipping, and status data" before confirming.
  order_copy: { sourceMaxAgeMs: 15 * MINUTE, proposalTtlMs: 60 * MINUTE },

  // Postage. The source read is a rate quote, and what makes it go stale is the
  // provider withdrawing it rather than the world moving: carriers reprice
  // slowly, but both providers hold a quote open for a bounded time and will
  // refuse to sell an expired one. Ten minutes is comfortably inside that and
  // leaves room for somebody who is weighing a parcel between the quote and the
  // click.
  //
  // This window is a ceiling, not the whole rule. Where the provider publishes
  // its own expiry, the earlier of the two decides, because a quote this
  // application still considers fresh is worth nothing if the carrier has
  // already withdrawn it.
  label_purchase: { sourceMaxAgeMs: 10 * MINUTE, proposalTtlMs: 20 * MINUTE },
};

export function reviewWindowFor(kind: ReviewedOperationKind): ReviewWindow {
  return WINDOWS[kind];
}

export type FreshnessVerdict = 'fresh' | 'stale_source' | 'expired';

export interface FreshnessInput {
  readonly sourceObservedAt: Date;
  readonly sourceMaxAgeMs: number;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * Whether a proposal may still be confirmed.
 *
 * Expiry is reported before staleness when both apply. They usually arrive
 * together — a proposal old enough to expire normally has a source read old
 * enough to be stale — and the honest thing to tell somebody is the one they can
 * act on: an expired proposal needs to be made again, while a stale source needs
 * a re-read, and the first subsumes the second.
 *
 * The boundaries are exclusive on both sides: a proposal is live until its
 * expiry instant, and a read is fresh until exactly its maximum age. A window
 * described as five minutes that refuses at four minutes fifty-nine is a window
 * nobody can reason about.
 */
export function assessFreshness(input: FreshnessInput): FreshnessVerdict {
  const now = input.now.getTime();

  if (now >= input.expiresAt.getTime()) {
    return 'expired';
  }

  if (sourceAgeMs(input.sourceObservedAt, input.now) > input.sourceMaxAgeMs) {
    return 'stale_source';
  }

  return 'fresh';
}

/**
 * How old a source read is, with a read from the future treated as this instant.
 *
 * Provider clocks disagree with ours, and a timestamp a few seconds ahead is
 * ordinary skew rather than evidence of anything. The clamp only ever makes a
 * read look older than the raw arithmetic would, which is the safe direction:
 * the unclamped alternative would report a negative age and quietly extend the
 * freshness window by however far the provider's clock ran ahead.
 */
export function sourceAgeMs(sourceObservedAt: Date, now: Date): number {
  return Math.max(0, now.getTime() - sourceObservedAt.getTime());
}
