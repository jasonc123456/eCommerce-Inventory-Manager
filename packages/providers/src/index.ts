export {
  type AdapterCapabilities,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelEntityRef,
  type InboundWebhook,
  type Page,
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
  FakeChannelAdapter,
  entityKey,
  type FakeAdapterOptions,
  type RecordedWrite,
} from './fakes/fake-adapter';
