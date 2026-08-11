/**
 * Optional AI assistance (sections 18, 34).
 *
 * Disabled until a business configures it, triggered by a person, incapable of
 * publishing anything, and never trusted with a fact. Everything a model returns
 * passes through `parseSuggestion` before any other module sees it, and what
 * comes out the other side has no field for a price, a SKU, a quantity, or a
 * policy — not because those are filtered, but because the types do not have
 * them.
 */

export {
  PROTECTED_FACTS,
  isProtectedFieldName,
  scanForProtectedFields,
  type ProtectedFieldScan,
} from './protected-fields';

export {
  SUGGESTION_SCHEMAS,
  parseSuggestion,
  type DraftFieldSuggestion,
  type ItemSpecific,
  type KitComponentSuggestion,
  type KitRecipeSuggestion,
  type MappingCandidate,
  type MappingCandidateSuggestion,
  type Suggestion,
  type SuggestionKind,
  type SuggestionOutcome,
} from './output';

export {
  createAiSecretStore,
  type AiProviderRef,
  type AiSecretDescription,
  type AiSecretStore,
  type AiSecretStoreOptions,
  type PutAiSecret,
} from './credentials';

export {
  AiConfigurationError,
  configureProvider,
  loadProvider,
  removeProvider,
  setProviderEnabled,
  testProvider,
  usableProvider,
  type AdapterForProvider,
  type AiConfigurationRefusal,
  type ConfigureProviderInput,
} from './providers';
