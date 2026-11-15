/** `@seshi/client`: the typed HTTP client for a seshi server (to be published as
 * `@seshi/client`, X3.8). It depends only on `@seshi/model`, whose session API types and errors
 * it re-exports so a caller needs one import. */

export type {
  ChangesPage,
  Fetch,
  Identity,
  ListSessionsOptions,
  ReadChangesOptions,
  SearchMatch,
  SearchRequest,
  SearchResult,
  SearchResults,
  SessionDB,
  SessionsPage,
  StorageView,
  StoredTrace,
  StoreSessionResult,
  Upload,
} from "@seshi/model";
export {
  Forbidden,
  IngestRejected,
  OffsetMismatch,
  SessionConflict,
  SessionRejected,
  StoreError,
} from "@seshi/model";
export {
  authConfig,
  exchangeIdToken,
  type HttpClientOptions,
  HttpSessionDB,
  type OwnerOption,
  ServerError,
  type TransportOptions,
} from "./http";
export type {
  AuthConfig,
  ExchangeRequest,
  ExchangeResult,
  JobsStatus,
  OwnersPage,
  RecordKind,
  RecordsPage,
  Scope,
  SourceRecord,
  SourceStatus,
  TokenInfo,
  TokenKind,
  TokenRequest,
} from "./types";
