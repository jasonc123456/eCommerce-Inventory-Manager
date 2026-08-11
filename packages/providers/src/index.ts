export {
  type AddOrderNoteInput,
  type AdapterCapabilities,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelEntityRef,
  type CreateDraftInput,
  type CreateFulfillmentInput,
  type DraftRef,
  type FeeLine,
  type FulfillmentLine,
  type FulfillmentOperations,
  type FulfillmentRef,
  type InboundWebhook,
  type ListingLifecycleState,
  type ListingOperations,
  type ListingState,
  type MirroredOrderInput,
  type MirroredOrderLine,
  type MirroredOrderResult,
  type OrderDemandState,
  type PostalContact,
  type Page,
  type PreviewPublicationInput,
  type PriceAcknowledgement,
  type PriceChangePreview,
  type PriceObservation,
  type PriceWrite,
  type PublicationPreview,
  type PublishDraftInput,
  type PublishedListing,
  type ProviderOrder,
  type ProviderOrderLine,
  type ProviderOrderRef,
  type QuantityObservation,
  type QuantityWrite,
  type RestockToLiveInput,
  type RestockToLiveResult,
  type VerifiedWebhook,
  type WriteAcknowledgement,
} from './adapter';

export {
  type AiAdapter,
  type AiAdapterFactory,
  type AiCapabilities,
  type AiCompletion,
  type AiProviderKind,
  type AiRequest,
} from './ai';

export {
  type BuyLabelInput,
  type Parcel,
  type PurchasedLabel,
  type RateQuote,
  type RateRequest,
  type ShipmentAddress,
  type ShipmentDocument,
  type ShipmentDocumentType,
  type ShippingAdapter,
  type ShippingAdapterFactory,
  type ShippingCapabilities,
  type ShippingProviderName,
  type ShippingRate,
  type TrackingEvent,
  type TrackingReport,
  type TrackingStatus,
  type VoidLabelResult,
  type VoidOutcome,
} from './shipping';

export {
  describeFailure,
  isRetryable,
  isSuccess,
  type ProviderConflict,
  type ProviderFailure,
  type ProviderName,
  type ProviderNotFound,
  type ProviderRateLimited,
  type ProviderRejected,
  type ProviderResult,
  type ProviderSuccess,
  type ProviderUnauthorized,
  type ProviderUnavailable,
} from './outcomes';

export {
  categorize,
  classifyAddress,
  isMetadataAddress,
  matches,
  normalize as normalizeAddress,
  type AddressPolicy,
  type AddressVerdict,
} from './http/addresses';

export {
  canonicalize,
  originOf,
  validateIntegrationUrl,
  type UrlPolicy,
  type UrlVerdict,
} from './http/url-policy';

export {
  createHttpClient,
  type HttpClient,
  type HttpClientOptions,
  type HttpFailureKind,
  type HttpOutcome,
  type HttpRequest,
  type HttpResponse,
  type Resolver,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './http/client';

export {
  DEAD_LETTER_WINDOW_MS,
  DELAY_SCHEDULE_MS,
  MAX_ATTEMPTS,
  decideRetry,
  parseRetryAfter,
  type DeadLetterReason,
  type RetryContext,
  type RetryDecision,
} from './http/backoff';

export { redactHeaders, redactUrl, summarizeBody } from './http/redaction';

export {
  FakeChannelAdapter,
  entityKey,
  type FakeAdapterOptions,
  type RecordedDraft,
  type RecordedPriceWrite,
  type RecordedWrite,
} from './fakes/fake-adapter';

export { FakeAiAdapter, type FakeAiAdapterOptions } from './fakes/fake-ai-adapter';

export {
  FakeShippingAdapter,
  type FakeShippingAdapterOptions,
  type RecordedPurchase,
  type RecordedQuote,
} from './fakes/fake-shipping-adapter';
