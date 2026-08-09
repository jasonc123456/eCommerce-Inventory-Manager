/**
 * One gate, for every operation a person authorizes one at a time.
 *
 * This package was `packages/listings` until milestone 6 needed the same thing
 * for buying a shipping label, and the choice was between a second
 * implementation and a shared one. The guarantees are identical — somebody with
 * the right permission, authenticated recently enough, agreed to this exact set
 * of values, which were read recently enough to still be true, and the effect
 * happens once — and none of them is about listings.
 *
 * What is deliberately absent is any way to carry an operation out. This package
 * decides whether one may proceed and records that it did; reaching a provider
 * lives with the feature that knows how to talk to one. That is what makes it
 * safe for the automatic tier to import: a background job may expire abandoned
 * proposals, and cannot publish a listing or spend money on postage, because
 * nothing here can.
 */

export {
  canonicalize,
  fingerprintMatches,
  fingerprintOf,
  type FingerprintValue,
} from './fingerprint';

export {
  assessFreshness,
  reviewWindowFor,
  sourceAgeMs,
  type FreshnessInput,
  type FreshnessVerdict,
  type ReviewWindow,
} from './freshness';

export {
  ReviewedOperationError,
  beginExecution,
  cancelOperation,
  completeExecution,
  confirmOperation,
  expireProposals,
  failExecution,
  proposeOperation,
  type ConfirmOperationInput,
  type ConfirmOutcome,
  type ConfirmedOperation,
  type ProposeOperationInput,
  type ProposedOperation,
  type RefusedOperation,
} from './review';
