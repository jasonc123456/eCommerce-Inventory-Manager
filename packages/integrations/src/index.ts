export {
  createAuthorizations,
  pendingFor,
  type AuthorizationOptions,
  type Authorizations,
  type BeginAuthorization,
  type ConsumeAuthorization,
  type ConsumeFailure,
  type ConsumeResult,
  type PendingAuthorization,
} from './authorizations';

export {
  createSecretStore,
  type ConnectionRef,
  type ConnectionSecretType,
  type PutSecret,
  type SecretDescription,
  type SecretStore,
  type SecretStoreOptions,
} from './secrets';

export {
  basicAuthorization,
  credentialsFrom,
  hostsFor,
  type CredentialLookup,
  type EbayCredentials,
  type EbayEnvironment,
  type EbayHosts,
} from './ebay/environment';

export {
  CAPABILITY_SCOPES,
  REQUESTED_SCOPES,
  SCOPE_CEILING,
  compareScopes,
  isExcluded,
  parseGrantedScopes,
  supports,
  type ScopeComparison,
} from './ebay/scopes';

export {
  createEbayOAuth,
  parseTokenResponse,
  type AccessTokenFailure,
  type AccessTokenRequest,
  type AccessTokenResult,
  type BeginConnection,
  type BeginResult,
  type CompleteConnection,
  type CompleteFailure,
  type CompleteResult,
  type EbayOAuth,
  type EbayOAuthOptions,
  type IdentityReader,
} from './ebay/oauth';

export { configuredEnvironments, createIdentityReader, parseIdentity } from './ebay/identity';
