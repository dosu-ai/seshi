/** `@seshi/auth` (layer 2, X5): identity and access. Credentials (the org key, IdP sign-in
 * exchanged for session and device tokens, admin and service tokens, static tokens from config)
 * become principals with a role and scopes; owner ids come from identity (X5.8); visibility and
 * the delete and replace rules decide which sessions a principal may touch (X5.3, X5.10). The
 * pipeline's authorize stage is `ownershipAuthorizer`. Everything hangs off an `Auth` built from
 * config and a store: no module state (X1.2). */

export {
  canRead,
  DELETE_FRESH_MS,
  isOwnSession,
  requireDelete,
  requireScope,
  requireVisibilityChange,
  type SessionAccess,
  seesEverything,
} from "./access";
export {
  AdminInitError,
  Auth,
  type AuthModes,
  type AuthOptions,
  AuthRequestError,
  DEVICE_TOKEN_DAYS,
  type ExchangeRequest,
  type ExchangeResult,
  OIDC_SCOPES,
  ORG_KEY_OWNER,
  type TokenRequest,
  USER_HEADER,
} from "./auth";
export { ownershipAuthorizer } from "./authorizer";
export { idTokenClaims, pickClaims } from "./claims";
export { IdTokenError, OidcVerifier, type OidcVerifierOptions } from "./oidc";
export {
  hashMatches,
  hashToken,
  isOpaqueToken,
  isTokenId,
  type MintedToken,
  mintToken,
  TOKEN_PREFIX,
  tokenId,
} from "./opaque";
export {
  claimOwner,
  isServiceOwner,
  OwnerAliases,
  ownerId,
  SERVICE_PREFIX,
  serviceIdentity,
  serviceOwner,
  serviceSourceId,
  usernameOwner,
} from "./owner";
export { type CredentialType, hasScope, type Principal } from "./principal";
export {
  CREDENTIAL_SCOPES,
  isScope,
  type Role,
  SCOPES,
  type Scope,
  serviceScopesValid,
} from "./scopes";
export {
  looksLikeJwt,
  MIN_SESSION_KEY_LENGTH,
  SESSION_TOKEN_SECONDS,
  type SessionClaims,
  type SessionTokenOptions,
  SessionTokens,
} from "./session-token";
export {
  type AuthSettings,
  AuthSettingsError,
  authSettings,
  MIN_STATIC_TOKEN_LENGTH,
  type OidcSettings,
} from "./settings";
export {
  type IssueOptions,
  isLive,
  TOKEN_CACHE_MS,
  type TokenInfo,
  type TokenListFilter,
  TokenService,
  tokenInfo,
} from "./tokens";
