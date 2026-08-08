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
