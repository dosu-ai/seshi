/** `@seshi/client`: the typed HTTP client for a seshi server (to be published as
 * `@seshi/client`, X3.8). It depends only on `@seshi/model`, whose session API types and errors
 * it re-exports so a caller needs one import. */

export type {
  ChangesPage,
  Fetch,
  Identity,
  ListSessionsOptions,
  ReadChangesOptions,
  SessionDB,
  SessionsPage,
  StorageView,
  StoredTrace,
  StoreSessionResult,
  Upload,
} from "@seshi/model";
export { IngestRejected, OffsetMismatch, SessionRejected, StoreError } from "@seshi/model";
export { type HttpClientOptions, HttpSessionDB, ServerError } from "./http";
