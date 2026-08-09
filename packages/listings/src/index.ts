/**
 * The confirmation gate itself lives in `@eim/review` and is not re-exported
 * here. Milestone 6 gave it a second caller — buying a shipping label — and a
 * package that re-exported another's gate would make `@eim/listings` look like
 * where confirmation is decided when it is only one of the things confirmed.
 */

export {
  assessDraftEligibility,
  mayConvert,
  type DraftEligibility,
  type DraftEligibilityVerdict,
  type DraftPlatform,
  type DraftSource,
  type EbayDraftSource,
  type EbayListingFormat,
  type EbayListingState,
  type KitDraftSource,
  type WooDraftSource,
  type WooProductType,
} from './draft-eligibility';

export {
  applySelections,
  draftIsComplete,
  projectDraft,
  type DraftFieldValue,
  type DraftProjection,
  type DraftSubject,
  type ItemCondition,
  type Money,
  type ProjectDraftInput,
} from './draft-fields';

export {
  DraftRefused,
  executeDraftCreation,
  executePublication,
  proposeDraft,
  proposePublication,
  type CreatedDraft,
  type ExecuteInput,
  type ProposeDraftInput,
  type ProposePublicationInput,
  type ProposedDraft,
  type ProposedPublication,
  type PublishedDraft,
} from './drafts';

export {
  AmountError,
  compareAmounts,
  isAmount,
  isSameAmount,
  percentageDifference,
  subtractAmounts,
} from './money';

export {
  PriceCopyRefused,
  comparePrices,
  executePriceCopy,
  proposePriceCopy,
  type AppliedPriceCopy,
  type ExecutePriceCopyInput,
  type PriceComparison,
  type PriceSide,
  type ProposePriceCopyInput,
  type ProposedPriceCopy,
} from './prices';

export {
  OrderCopyRefused,
  executeOrderCopy,
  proposeOrderCopy,
  type CopiedOrder,
  type ExecuteOrderCopyInput,
  type OrderCopySubject,
  type ProposeOrderCopyInput,
  type ProposedOrderCopy,
} from './order-copy';

export {
  SUPPRESSION_TECHNIQUES,
  assessOrderCopySupport,
  type OrderCopySupport,
  type SuppressionTechnique,
} from './suppression';

export {
  assessRestockEligibility,
  mayRestock,
  type RestockEligibility,
  type RestockSubject,
  type RestockVerdict,
} from './restock-eligibility';

export {
  RestockRefused,
  executeRestockToLive,
  proposeRestockToLive,
  type AppliedRestock,
  type ExecuteRestockInput,
  type ProposeRestockInput,
  type ProposedRestock,
} from './restock';
