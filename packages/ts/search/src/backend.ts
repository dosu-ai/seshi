/** The index behind search (F10.3): one narrow interface, so a second backend (ClickHouse,
 * later) changes neither the indexer nor the API. It holds sessions and their searchable
 * events, and answers keyword queries with filters and the viewer's permission filter. Where
 * the indexer has got to in the change feed is `FeedState`: the SQLite backend keeps it in the
 * same file, so a wiped index also forgets its cursors and starts over. */

import type { EventRole, SearchSort, Visibility } from "@seshi/model";
import type { Viewer } from "./viewer";

/** What the index keeps of a session: enough to filter, show and address it. */
export interface IndexedSession {
  owner: string;
  archive_id: string;
  agent: string;
  session_id: string;
  origin_agent?: string;
  native_session_id?: string;
  project?: string;
  branch?: string;
  source_id?: string;
  visibility: Visibility;
  /** Epoch ms of the earliest and latest event, when the traces say. */
  started_at?: number;
  ended_at?: number;
  /** The metadata's `updated_at`: an update older than what the index holds is stale. */
  updated_at: string;
  /** The traces indexed, in the session's order. */
  traces: string[];
}

/** One searchable event of a trace. */
export interface IndexedEvent {
  content_hash: string;
  event_index: number;
  role: EventRole;
  tool_name?: string;
  /** Epoch ms, when the event's timestamp parses. */
  timestamp?: number;
  text: string;
}

/** A change to one session. With `replace` the events it held go first (a replaced or
 * re-read session); otherwise `events` are added to them (a continuation). */
export interface SessionUpdate {
  session: IndexedSession;
  events: IndexedEvent[];
  replace: boolean;
  /** For a continuation: the traces the index must hold for `events` to extend them. When it
   * holds others (another process got there first), the update is refused. */
  base?: readonly string[];
}

/** A query as the backend runs it: the match expression already parsed, filters already
 * resolved (owner aliases folded, times in epoch ms). */
export interface BackendQuery {
  match: string;
  viewer: Viewer;
  owners?: readonly string[];
  agent?: string;
  repo?: string;
  branch?: string;
  source?: string;
  since?: number;
  until?: number;
  sort: SearchSort;
  limit: number;
  offset: number;
  matches: number;
}

export interface BackendMatch {
  content_hash: string;
  event_index: number;
  role: EventRole;
  tool_name?: string;
  timestamp?: number;
  /** The excerpt with matches between `MATCH_START` and `MATCH_END`. */
  marked: string;
}

export interface BackendHit {
  session: IndexedSession;
  /** Higher is better. */
  score: number;
  hits: number;
  matches: BackendMatch[];
}

export interface BackendResults {
  total: number;
  hits: BackendHit[];
}

export interface SearchBackend {
  /** What the index holds of a session, or null. */
  session(owner: string, archive: string): IndexedSession | null;
  /** Index a session's new head (F10.2). Returns false, changing nothing, when the index
   * already holds a newer version of the session (by `updated_at`), or a continuation's
   * `base` is not what it holds. */
  apply(update: SessionUpdate): boolean;
  /** Drop a session (a tombstone, F10.2). With the tombstoned metadata's `updated_at`, the
   * index remembers the removal, so an older update that arrives late is refused. */
  remove(owner: string, archive: string, updatedAt?: string): void;
  query(query: BackendQuery): BackendResults;
  /** Sessions and events held. */
  counts(): { sessions: number; events: number };
  close(): void;
}

/** How far the indexer has read each owner's change feed. */
export interface FeedState {
  /** The last change key processed for `owner`. */
  cursor(owner: string): string | undefined;
  /** Which of `keys` were already processed (within the lag window). */
  seen(owner: string, keys: readonly string[]): Set<string>;
  /** Record `processed` keys (with their stamps, epoch ms), move the cursor to `cursor`, and
   * forget processed keys stamped before `forgetBefore`. */
  advance(
    owner: string,
    cursor: string | undefined,
    processed: readonly { key: string; at: number }[],
    forgetBefore: number,
  ): void;
  /** When the index first caught up with the whole feed; undefined while it is building. */
  readyAt(): string | undefined;
  /** When the indexer last finished a pass over every owner. */
  caughtUpAt(): string | undefined;
  /** A full pass over every owner finished at `at`; the first one makes the index ready. */
  caughtUp(at: string): void;
  /** Run `fn` as one transaction: it all applies, or none of it. */
  transaction<T>(fn: () => T): T;
  /** Forget everything: sessions, events, cursors and readiness (a rebuild). */
  reset(): void;
}

export type IndexStore = SearchBackend & FeedState;
