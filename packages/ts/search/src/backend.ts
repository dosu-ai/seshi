import type { ChangeEntry, EventRole, SearchSort, Visibility } from "@seshi/model";
import type { Viewer } from "./viewer";

export interface IndexedSession {
  owner: string;
  archive_id: string;
  /** The format the session is filed under. */
  format: string;
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
  /** The metadata's `updated_at`, shown and sorted on. It is stamped by whichever machine wrote
   * the session, so it does not order updates (see `SessionUpdate.read_at`). */
  updated_at: string;
  /** The traces indexed, in the session's order. */
  traces: string[];
}

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
  /** When the indexer started reading the session's metadata (epoch ms, this host's clock).
   * An update read before the one the index holds is stale and refused, so a slow process
   * sharing the file never puts back what a faster one replaced. Processes that share a file
   * share a host, and so a clock; the metadata's `updated_at` cannot order updates, because
   * several writers (API instances, a laptop in local mode) stamp it with clocks that
   * disagree. Omitted: 0, before any stamped read. */
  read_at?: number;
}

/** A query as the backend runs it: the match expression already parsed, filters already
 * resolved (owner aliases folded, times in epoch ms). */
export interface BackendQuery {
  match: string;
  viewer: Viewer;
  owners?: readonly string[];
  /** Sessions filed under this format or run by this agent (`origin_agent`). */
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
   * holds the session as read later (by `read_at`), or a continuation's `base` is not what it
   * holds. */
  apply(update: SessionUpdate): boolean;
  /** Drop a session (a tombstone, F10.2). The index remembers the removal with its read stamp
   * (`SessionUpdate.read_at`), even for a session it never held, so an update read earlier
   * that arrives late is refused. Returns false, changing nothing, when the index holds the
   * session as read later. */
  remove(owner: string, archive: string, readAt?: number): boolean;
  query(query: BackendQuery): BackendResults;
  counts(): { sessions: number; events: number };
  close(): void;
}

export interface FeedState {
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
  /** Keep change entries as listed from `owner`'s feed (`name` is the key under `changes/`),
   * for the cross-owner feed. One already kept is left as it is. */
  record(owner: string, entries: readonly { name: string; entry: ChangeEntry }[]): void;
  /** The kept entries after `after` (in stamp, owner, name order), stamped no later than
   * `through`: at most `limit`, whether more follow, and the `through` used. `through` is the
   * time every owner's feed has been read up to (`readThrough`); null before there is one. */
  feed(
    after: FeedPosition | undefined,
    limit: number,
  ): { entries: FeedRow[]; more: boolean; through: string } | null;
  /** Every owner's feed has been read after `through`, and an owner not listed then had
   * written nothing: the cross-owner feed may serve entries up to it. Never moves back. */
  readThrough(through: string): void;
  /** When the index first caught up with the whole feed; undefined while it is building. */
  readyAt(): string | undefined;
  caughtUpAt(): string | undefined;
  /** A full pass over every owner finished at `at`; the first one makes the index ready. */
  caughtUp(at: string): void;
  /** Changes on every `reset`. A run that started before a reset (in this process or another
   * sharing the file) writes nothing once it sees it change, so a page it read earlier never
   * moves the rebuilt index's cursors past entries the rebuild has not read. */
  generation(): string;
  /** Run `fn` as one transaction: it all applies, or none of it. */
  transaction<T>(fn: () => T): T;
  /** Forget everything: sessions, events, cursors and readiness (a rebuild). */
  reset(): void;
}

/** A place in the cross-owner feed: entries sort by stamp, then owner, then name (the key
 * under `changes/`, which starts with the stamp). */
export interface FeedPosition {
  stamp: string;
  owner: string;
  name: string;
}

export interface FeedRow extends FeedPosition {
  entry: ChangeEntry;
}

export type IndexStore = SearchBackend & FeedState;
