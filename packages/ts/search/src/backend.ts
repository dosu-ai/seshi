import {
  type ChangeEntry,
  DEFAULT_SEARCH_MAX_CHARS,
  type EventRole,
  type Labels,
  type SearchSort,
  type Visibility,
} from "@seshi/model";
import type { MatchTree } from "./query";
import type { SqlTables } from "./sql/protocol";
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
  /** The repository's normalized remote (`github.com/acme/app`). */
  repo?: string;
  /** What ran the session: the meta record's `source` (`claude-code`). */
  harness?: string;
  /** The session's `agent_version`: the harness's version it started on (Cursor: at its latest
   * upload). */
  agent_version?: string;
  /** Every model the session used. */
  models?: string[];
  /** The session's labels. */
  labels?: Labels;
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
  /** How many events those traces hold, indexed or not: the `seq` the next trace's first event
   * takes. */
  event_count: number;
}

export interface IndexedEvent {
  content_hash: string;
  event_index: number;
  /** The event's place in the session, from 0 across its indexed traces (`read_session`'s
   * `seq`). What the assistant said alongside tool calls takes its first call's. */
  seq: number;
  role: EventRole;
  tool_name?: string;
  /** Pairs a tool call with its result. */
  tool_call_id?: string;
  /** Whether a tool result records success. */
  ok?: boolean;
  /** Epoch ms, when the event's timestamp parses. */
  timestamp?: number;
  /** The event's text, cut to its role's `max_chars`. */
  text: string;
  /** The text's full length, before the cut. */
  chars: number;
}

/** One model request a session's trace records (`Trace.llm_calls`), with its usage flattened. */
export interface IndexedLlmCall {
  content_hash: string;
  /** The call's id, unique within its trace. */
  call_id: string;
  model?: string;
  provider?: string;
  /** Epoch ms. */
  started_at?: number;
  ended_at?: number;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  stop_reason?: string;
  error?: string;
}

/** A change to one session. With `replace` the events it held go first (a replaced or
 * re-read session); otherwise `events` are added to them (a continuation). */
export interface SessionUpdate {
  session: IndexedSession;
  events: IndexedEvent[];
  /** The model calls of the same traces, written in the same commit; none when omitted. */
  llm_calls?: IndexedLlmCall[];
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
  /** A replace whose earlier text must leave the index's storage, not only its results: a
   * redaction backfill (F2.5). It may rewrite a trace in place under the same hash, so the
   * index cannot tell from what it deletes. */
  scrub?: boolean;
}

/** A query as the backend runs it: the match already parsed (each backend compiles the tree),
 * filters already resolved (owner aliases folded, times in epoch ms). */
export interface BackendQuery {
  match: MatchTree;
  viewer: Viewer;
  owners?: readonly string[];
  /** Sessions filed under this format or run by this agent (`origin_agent`). */
  agent?: string;
  repo?: string;
  branch?: string;
  harness?: string;
  agent_version?: string;
  model?: string;
  /** Sessions carrying every one of these labels. */
  labels?: Labels;
  source?: string;
  /** Only records of these roles. */
  roles?: readonly EventRole[];
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
  seq: number;
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
  /** The backend stopped at its cap of scored records, so `total` is a lower bound (LanceDB). */
  capped?: boolean;
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

/** What a search reports about the index, read in one go. */
export interface IndexState {
  /** When the live generation first caught up with every feed; undefined before it has. */
  ready_at?: string;
  caught_up_at?: string;
  sessions: number;
  events: number;
  generation: string;
  /** A rebuild in progress beside the live generation: the one being built, and how far it has
   * read. Never for an index that empties itself to rebuild (SQLite). */
  building?: { generation: string; read_through?: string };
  /** The layout the live generation was written under, when it is not this code's: it is not
   * served, and the indexer rebuilds it (LanceDB). */
  stale_schema?: string;
  /** Requests waiting for the indexer's next pass, with when each was made (LanceDB). */
  requested?: { rebuild?: string; scrub?: string };
}

/** The API's side: what `SearchService.search`, `status` and `changes` call. It reads the live
 * generation. */
export interface IndexReader {
  /** Where the index is: a file path, or a bucket URI. Never credentials. */
  location(): string;
  /** One read; the backend may cache it for a few seconds. */
  state(): Promise<IndexState>;
  query(query: BackendQuery): Promise<BackendResults>;
  /** The kept change entries after `after` (in stamp, owner, name order), stamped no later than
   * `through`: at most `limit`, whether more follow, and the `through` used. `through` is the
   * time every owner's feed has been read up to (`IndexWriter.readThrough`); null before there
   * is one (`GET /v1/changes/all`). */
  feed(
    after: FeedPosition | undefined,
    limit: number,
  ): Promise<{ entries: FeedRow[]; more: boolean; through: string } | null>;
  /** Where the live generation's `sessions`, `events` and `llm_calls` tables are, for `sql`'s
   * DuckDB views (LanceDB); undefined before there is one. Absent for SQLite, whose views read
   * the file at `location()`. */
  sqlTables?(): Promise<SqlTables | undefined>;
  close(): Promise<void>;
}

/** The indexer's side. Every call names the generation it reads or writes, so a run that
 * started before a reset (in this process or another sharing the index) never writes into the
 * rebuilt one. */
export interface IndexWriter {
  /** The generation writes go to: the live one, or the one being built. Changes on every
   * `reset`. */
  generation(): Promise<string>;
  /** The cursors (the last change key read) of `owners`, or of every owner. The indexer reads
   * each owner's as it reaches that owner, so it starts from where another process sharing the
   * index may have moved it since the pass began. */
  cursors(generation: string, owners?: readonly string[]): Promise<Map<string, string>>;
  /** Which of `keys` were already processed (within the lag window). */
  seen(generation: string, owner: string, keys: readonly string[]): Promise<Set<string>>;
  /** What the index holds of these sessions; missing and removed ones are absent. */
  sessions(
    generation: string,
    owner: string,
    archives: readonly string[],
  ): Promise<Map<string, IndexedSession>>;
  /** One feed page, or several of one owner's in a row, written as a whole. Writing it twice
   * changes nothing. */
  commit(page: PageCommit): Promise<CommitResult>;
  /** How many records (events and sessions) the indexer may gather from one owner's feed pages
   * into one commit to `generation`; 0, or absent, to commit each page on its own. LanceDB
   * gathers while a generation is being built, because each commit is a table version: a first
   * build one page per commit takes hours. */
  batchRecords?(generation: string): Promise<number>;
  /** Every owner's feed has been read after `through`, and an owner not listed then had
   * written nothing: the cross-owner feed may serve entries up to it. Never moves back. */
  readThrough(generation: string, through: string): Promise<void>;
  /** A full pass over every owner ended at `at`; the first one makes the generation ready (and
   * live, for one being built). False, changing nothing, when `generation` is no longer the one
   * writes go to. */
  passDone(generation: string, at: string): Promise<boolean>;
  /** Start a new generation and return it. SQLite forgets everything it held: sessions,
   * events, cursors and readiness, so searches are refused until it catches up again. */
  reset(): Promise<string>;
  /** Housekeeping after a pass; nothing for SQLite. */
  maintain(signal: AbortSignal): Promise<void>;
  /** Ask the indexer to scrub on its next pass, so deleted text leaves the storage now rather
   * than at the next scheduled scrub (`seshi search --scrub`). Absent for a backend that
   * deletes text when it commits (SQLite). */
  requestScrub?(): Promise<void>;
  /** Ask the indexer to start a rebuild on its next pass, beside the live generation (`seshi
   * search --rebuild`), so the process asking never writes the index itself. Absent for a
   * backend that each process rebuilds in place (SQLite). Like `requestScrub`, it works on an
   * index opened read-only. */
  requestRebuild?(): Promise<void>;
}

/** A removal: a tombstone, or a session no longer admitted. */
export interface Removal {
  archive: string;
  /** The read stamp, as `SessionUpdate.read_at`: the index remembers the removal with it, even
   * for a session it never held, so an update read earlier that arrives late is refused. */
  read_at: number;
  /** The session was deleted, retracted or redacted, so its text must leave the index's
   * storage, not only its results. */
  scrub: boolean;
}

/** One page of one owner's change feed, or several in a row (`IndexWriter.batchRecords`), as the
 * indexer planned it: each session once, from its metadata as read after the last page that
 * names it was listed. */
export interface PageCommit {
  generation: string;
  owner: string;
  /** Sessions to index (F10.2): a replace, or a continuation checked against its `base`. */
  updates: SessionUpdate[];
  removals: Removal[];
  /** Change entries as listed (`name` is the key under `changes/`), for the cross-owner feed.
   * One already kept is left as it is. */
  feed: { name: string; entry: ChangeEntry }[];
  /** Keys processed (with their stamps, epoch ms). */
  seen: { key: string; at: number }[];
  /** Where the owner's cursor moves (never back); none for a page that only retries refused
   * updates. */
  cursor: string | undefined;
  /** Forget processed keys stamped before this (epoch ms). */
  forgetBefore: number;
}

export interface CommitResult {
  /** `generation` is no longer the one writes go to: nothing was written. */
  stale: boolean;
  /** Updates the index refused, changing nothing (it holds the session as read later, or a
   * continuation's `base` is not what it holds): plan these again. */
  refused: string[];
  /** Sessions the index held that the page removed. */
  removed: number;
}

export type IndexStore = IndexReader & IndexWriter;

/** What a backend is opened with, whichever it is. */
export interface IndexOptions {
  /** The deployment the index belongs to: one built for another is wiped. */
  deployment: string;
  /** Which event roles are indexed: an index built with others is wiped (it would miss some,
   * or hold some it should not). LanceDB keeps answering from an index built with fewer roles
   * while it builds the new one beside it, and stops at once for one built with more. */
  events: readonly EventRole[];
  /** How much of each role's text is kept (`DEFAULT_SEARCH_MAX_CHARS` when omitted): an index
   * built with other caps is rebuilt (LanceDB: beside the live one, which keeps answering). */
  max_chars?: Readonly<Record<EventRole, number>>;
  /** What the indexer admits, named (F11.9: a serverless laptop's search scope and owner): an
   * index built under another scope is wiped (LanceDB: stops answering until the new one has
   * caught up), so it holds nothing this one would leave out. */
  scope?: string;
  /** Keep a copy of every change entry read, for the cross-owner feed. An index built without
   * it is wiped when it is turned on, so the copy starts from every feed's start. */
  feed?: boolean;
}

/** Each role's cap, as an index is built with it: every role, in one order. */
export function maxCharsOf(options: Pick<IndexOptions, "max_chars">): Record<EventRole, number> {
  const caps = options.max_chars ?? DEFAULT_SEARCH_MAX_CHARS;
  return Object.fromEntries(
    (Object.keys(DEFAULT_SEARCH_MAX_CHARS) as EventRole[])
      .sort()
      .map((role) => [role, caps[role] ?? DEFAULT_SEARCH_MAX_CHARS[role]]),
  ) as Record<EventRole, number>;
}

/** Opens a backend's index: what `SearchService` calls instead of constructing one. */
export type OpenIndex = (options: IndexOptions) => Promise<IndexStore>;

/** The index cannot be reached, or did not answer in time: the API answers 503, the CLI exits
 * 7. Not an index that is still being built (`SearchUnavailable`). */
export class IndexUnavailable extends Error {
  readonly code = "index_unavailable";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexUnavailable";
  }
}
