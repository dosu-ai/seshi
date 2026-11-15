/** `@seshi/search`, layer 3 (X3.2): session search (F10). An indexer tails the change feed into
 * a local SQLite FTS5 index (F10.2, F10.3); the query layer answers keyword searches with
 * filters, adding the viewer's permission filter itself (F10.4). One `SearchService` per
 * Instance (X1.2): `@seshi/instance` runs its indexer as a job, `@seshi/api` serves `GET
 * /v1/search` from it, and local mode queries it in-process. */

export type {
  BackendHit,
  BackendMatch,
  BackendQuery,
  BackendResults,
  FeedState,
  IndexedEvent,
  IndexedSession,
  IndexStore,
  SearchBackend,
  SessionUpdate,
} from "./backend";
export {
  currentTraces,
  FEED_LAG_MS,
  FEED_PAGE,
  Indexer,
  type IndexerLogger,
  type IndexerOptions,
  type IndexerRun,
  OWNER_REFRESH_MS,
  RUN_BUDGET,
  searchableEvents,
} from "./indexer";
export { defaultIndexPath, type IndexPathOptions, MEMORY_INDEX } from "./paths";
export {
  MAX_QUERY_LENGTH,
  MAX_QUERY_TERMS,
  type ParsedQuery,
  parseQuery,
  SearchQueryError,
} from "./query";
export {
  checkRequest,
  DEFAULT_LIMIT,
  DEFAULT_MATCHES,
  MAX_LIMIT,
  MAX_MATCHES,
  MAX_OFFSET,
  SearchService,
  type SearchServiceOptions,
  type SearchSettings,
  type SearchStatus,
  SearchUnavailable,
} from "./service";
export { highlights, indexText, MATCH_END, MATCH_START, MAX_INDEXED_CHARS } from "./snippet";
export { INDEX_SCHEMA, SqliteIndex, type SqliteIndexOptions } from "./sqlite";
export { LOCAL_VIEWER, type Viewer, viewerFor } from "./viewer";
