export {
  type AdapterCapabilities,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelEntityRef,
  type CreateDraftInput,
  type DraftRef,
  type FeeLine,
  type InboundWebhook,
  type ListingOperations,
  type OrderDemandState,
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
  type VerifiedWebhook,
  type WriteAcknowledgement,
} from './adapter';

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
