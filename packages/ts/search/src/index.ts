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
  tracesFrom,
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
