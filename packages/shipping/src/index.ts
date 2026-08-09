/**
 * Shipping: packages, rates, labels, documents, and tracking (section 2).
 *
 * The one part of this application that spends a business's money at a third
 * party, which is why every decision in it is shaped by the same question: what
 * happens if this runs twice, and who agreed to it?
 *
 * The automatic tier cannot import this package. That is a lint boundary rather
 * than a convention, for the same reason milestone 5's publication path is one:
 * postage bought by a background job is postage nobody confirmed.
 */

export {
  ShippingAccountError,
  activeAccount,
  connectAccount,
  disconnectAccount,
  loadAccount,
  testAccount,
  type AdapterForAccount,
  type ConnectAccountInput,
  type ConnectedAccount,
} from './accounts';

export {
  createShippingSecretStore,
  secretTypeFor,
  type PutShippingSecret,
  type ShippingAccountRef,
  type ShippingSecretDescription,
  type ShippingSecretStore,
  type ShippingSecretStoreOptions,
} from './credentials';

export {
  PackageRefused,
  availabilityFor,
  cancelPackage,
  createPackage,
  shipFromAddress,
  type CreatePackageInput,
  type LineAvailability,
  type PackageLineInput,
  type PackageRefusalReason,
} from './packages';

export { RateQuoteFailed, quoteRatesFor, type QuoteRatesInput, type QuotedRates } from './rates';

export { cheapestOf, earliestProviderExpiry, rateFrom, usableUntil } from './rate-selection';

export {
  LabelPurchaseRefused,
  executeLabelPurchase,
  proposeLabelPurchase,
  type ExecuteLabelPurchaseInput,
  type LabelPurchaseRefusalReason,
  type ProposeLabelPurchaseInput,
  type ProposedLabelPurchase,
} from './purchase';

export {
  LabelActionRefused,
  fetchLabelDocument,
  loadLabel,
  voidLabel,
  type FetchDocumentInput,
  type LabelActionRefusalReason,
  type VoidLabelInput,
  type VoidedLabel,
} from './labels';
