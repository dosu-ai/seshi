import { OwnerAliases } from "@seshi/auth";
import {
  type AllChangesPage,
  DEFAULT_SEARCH_MAX_CHARS,
  type EventRole,
  type Labels,
  labelsProblems,
  type ReadChangesOptions,
  SEARCH_SORTS,
  type SearchRequest,
  type SearchResult,
  type SearchResults,
  type SearchSort,
  type SessionList,
  type SessionListRequest,
  type SessionMetadata,
  type SessionSummary,
} from "@seshi/model";
import { accessDeniedIn, decodeMetadata, getBytes, isOwner, keys, type Store } from "@seshi/store";
import type {
  BackendHit,
  BackendQuery,
  IndexedSession,
  IndexStore,
  OpenIndex,
  SessionListQuery,
  SessionPosition,
} from "./backend";
import { readFeed } from "./feed";
import { Indexer, type IndexerLogger, type IndexerOptions, type IndexerRun } from "./indexer";
import { defaultIndexPath } from "./paths";
import { parseQuery, SearchQueryError } from "./query";
import { highlights } from "./snippet";
import type { SqlTables } from "./sql/protocol";
import { sqliteIndex } from "./sqlite";
import type { Viewer } from "./viewer";

export class SearchUnavailable extends Error {
  readonly code = "index_building";
  constructor(message: string) {
    super(message);
    this.name = "SearchUnavailable";
  }
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_MATCHES = 3;
export const MAX_MATCHES = 20;
export const MAX_OFFSET = 10_000;
const MAX_FILTER_LENGTH = 512;

export interface SearchSettings {
  /** The SQLite index file; `defaultIndexPath(deployment)` when omitted. `:memory:` for none.
   * Not read when `SearchServiceOptions.open` is given. */
  path?: string;
  events: readonly EventRole[];
  /** How much of each role's text is indexed (`DEFAULT_SEARCH_MAX_CHARS` when omitted). */
  maxChars?: Readonly<Record<EventRole, number>>;
}

export interface SearchServiceOptions {
  store: Store;
  deployment: string;
  settings: SearchSettings;
  /** Opens the index; SQLite at `settings.path` when omitted. */
  open?: OpenIndex;
  aliases?: OwnerAliases;
  now?: () => Date;
  log?: IndexerLogger;
  /** Check each result against the session's live metadata (true). */
  verify?: boolean;
  /** What `indexer.owners` and `indexer.admit` let in, named: an index file built under
   * another scope is wiped and built again (F11.9). */
  scope?: string;
  /** Keep a copy of every owner's change feed in the index, which `changes()` serves (the
   * server; never an index limited by `indexer.owners` or `indexer.admit`). */
  feed?: boolean;
  /** The index is shared by every instance and kept by the worker's search job (LanceDB,
   * F10.8): a rebuild here only starts one, which the worker builds beside the live index. */
  shared?: boolean;
  /** This process only reads the index (an API instance, or the CLI, with a shared index): it
   * never indexes. */
  readOnly?: boolean;
  indexer?: {
    lagMs?: number;
    pageSize?: number;
    budget?: number;
    ownerRefreshMs?: number;
    owners?: IndexerOptions["owners"];
    admit?: IndexerOptions["admit"];
  };
}

export interface SearchStatus {
  /** `sqlite`: this instance's own file. `lance`: one index every instance reads, kept by the
   * worker. */
  backend: "sqlite" | "lance";
  /** Where the index is: a file path, or a bucket URI. Never credentials. */
  location: string;
  ready: boolean;
  ready_at?: string;
  caught_up_at?: string;
  sessions: number;
  events: number;
  /** The live generation (LanceDB): it changes when a rebuild goes live. */
  generation?: string;
  /** A rebuild in progress beside the live generation, and how far it has read. */
  building?: { generation: string; read_through?: string };
  /** The live generation was written under another layout: it is not served until rebuilt. */
  stale_schema?: string;
  /** Requests waiting for the worker's next pass, with when each was made. */
  requested?: { rebuild?: string; scrub?: string };
}

/** A rebuild of a shared index, asked for: the worker starts it on its next pass, builds the
 * new generation beside the live one, and switches when it has caught up (F10.11). */
export interface RebuildRequested {
  /** The generation live when it was asked for: the rebuild is done when another is live. */
  from: string;
}

interface Checked {
  query: Omit<BackendQuery, "viewer">;
  q: string;
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new SearchQueryError(`${name} must be a string`);
  if (value.length > MAX_FILTER_LENGTH) {
    throw new SearchQueryError(`${name} is longer than ${MAX_FILTER_LENGTH} characters`);
  }
  return value;
}

function time(value: unknown, name: string): number | undefined {
  const raw = text(value, name);
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new SearchQueryError(`${name} must be an RFC 3339 time`);
  return ms;
}

function count(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new SearchQueryError(`${name} must be a whole number of at least ${min}`);
  }
  return Math.min(value, max);
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

export function checkRequest(request: SearchRequest, aliases = new OwnerAliases()): Checked {
  if (typeof request.q !== "string" || request.q.trim() === "") {
    throw new SearchQueryError("q is required: the words to search for");
  }
  const { match } = parseQuery(request.q);
  const owner = text(request.owner, "owner");
  if (owner !== undefined && !isOwner(owner)) {
    throw new SearchQueryError("owner is not an owner id");
  }
  const since = time(request.since, "since");
  const until = time(request.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new SearchQueryError("since is after until");
  }
  const sort = request.sort ?? "relevance";
  if (!SEARCH_SORTS.includes(sort as SearchSort)) {
    throw new SearchQueryError(`sort must be one of ${SEARCH_SORTS.join(", ")}`);
  }
  let offset = 0;
  if (request.cursor !== undefined && request.cursor !== "") {
    if (!/^\d{1,9}$/.test(request.cursor) || Number(request.cursor) > MAX_OFFSET) {
      throw new SearchQueryError("cursor is not one this server gave");
    }
    offset = Number(request.cursor);
  }
  const agent = text(request.agent, "agent");
  const repo = text(request.repo, "repo");
  const branch = text(request.branch, "branch");
  const harness = text(request.harness, "harness");
  const agentVersion = text(request.agent_version, "agent_version");
  const model = text(request.model, "model");
  const labels = labelFilter(request.labels);
  const source = text(request.source, "source");
  const roles = roleFilter(request.role);
  return {
    q: request.q,
    query: {
      match,
      ...(owner !== undefined ? { owners: aliases.storedAs(owner) } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(repo !== undefined ? { repo } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(labels !== undefined ? { labels } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(roles !== undefined ? { roles } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      sort: sort as SearchSort,
      limit: count(request.limit, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
      matches: count(request.matches, "matches", DEFAULT_MATCHES, 0, MAX_MATCHES),
      offset,
    },
  };
}

/** Every role a trace event can have. */
const ROLES = Object.keys(DEFAULT_SEARCH_MAX_CHARS) as EventRole[];

/** The role filter: roles a trace event can have, each once. */
function roleFilter(role: SearchRequest["role"]): EventRole[] | undefined {
  if (role === undefined || role === null) return undefined;
  const given = Array.isArray(role) ? role : [role];
  const roles: EventRole[] = [];
  for (const r of given) {
    if (typeof r !== "string" || !ROLES.includes(r as EventRole)) {
      throw new SearchQueryError(`role must be one or more of ${ROLES.join(", ")}`);
    }
    if (!roles.includes(r as EventRole)) roles.push(r as EventRole);
  }
  return roles.length > 0 ? roles : undefined;
}

/** Index pages one listing reads at most to fill a page the live check left short. */
const LIST_PAGES = 5;

/** The days `list_sessions` looks back when `since` is not given. */
export const DEFAULT_LIST_DAYS = 7;

/** Where a listing is after `s`: its `updated_ms` and key, as the index orders them. */
function positionOf(
  s: Pick<IndexedSession, "owner" | "archive_id" | "updated_at">,
): SessionPosition {
  return { updated: Date.parse(s.updated_at) || 0, key: `${s.owner}/${s.archive_id}` };
}

/** A listing's place as its cursor: the last session's `updated_ms` and key. */
export function encodeSessionCursor(
  s: Pick<IndexedSession, "owner" | "archive_id" | "updated_at">,
): string {
  const position = positionOf(s);
  return Buffer.from(JSON.stringify([position.updated, position.key])).toString("base64url");
}

export function decodeSessionCursor(cursor: string): SessionPosition {
  const refused = new SearchQueryError("after is not a cursor this server gave");
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw refused;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw refused;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !Number.isSafeInteger(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    throw refused;
  }
  return { updated: parsed[0] as number, key: parsed[1] as string };
}

export function checkListRequest(
  request: SessionListRequest,
  now: number,
  aliases = new OwnerAliases(),
): Omit<SessionListQuery, "viewer"> & { since: number } {
  const owner = text(request.owner, "owner");
  if (owner !== undefined && !isOwner(owner)) {
    throw new SearchQueryError("owner is not an owner id");
  }
  const until = time(request.until, "until");
  // The default window is the 7 days before `until`, or before now.
  const since =
    time(request.since, "since") ?? (until ?? now) - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000;
  if (until !== undefined && since > until) throw new SearchQueryError("since is after until");
  const agent = text(request.agent, "agent");
  const repo = text(request.repo, "repo");
  const branch = text(request.branch, "branch");
  const harness = text(request.harness, "harness");
  const agentVersion = text(request.agent_version, "agent_version");
  const model = text(request.model, "model");
  const labels = labelFilter(request.labels);
  const source = text(request.source, "source");
  const after = text(request.after, "after");
  return {
    ...(owner !== undefined ? { owners: aliases.storedAs(owner) } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(source !== undefined ? { source } : {}),
    since,
    ...(until !== undefined ? { until } : {}),
    limit: count(request.limit, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
    ...(after !== undefined ? { after: decodeSessionCursor(after) } : {}),
  };
}

/** The label filter: each `key=value` a session must carry, keys and values as labels are. */
function labelFilter(labels: SearchRequest["labels"]): Labels | undefined {
  if (labels === undefined) return undefined;
  const problems = labelsProblems(labels);
  if (problems.length > 0) throw new SearchQueryError(`labels: ${problems.join("; ")}`);
  return Object.keys(labels).length > 0 ? { ...labels } : undefined;
}

async function liveMetadata(
  store: Store,
  owner: string,
  archive: string,
): Promise<SessionMetadata | null> {
  const bytes = await getBytes(store, keys.metadata(owner, archive));
  if (bytes === null) return null;
  try {
    return decodeMetadata(bytes);
  } catch {
    return null;
  }
}

function summaryOf(s: IndexedSession): SessionSummary {
  const started = iso(s.started_at);
  const ended = iso(s.ended_at);
  return {
    owner: s.owner,
    format: s.format,
    session_id: s.session_id,
    archive_id: s.archive_id,
    ...(s.origin_agent !== undefined ? { origin_agent: s.origin_agent } : {}),
    ...(s.native_session_id !== undefined ? { native_session_id: s.native_session_id } : {}),
    ...(s.project !== undefined ? { project: s.project } : {}),
    ...(s.branch !== undefined ? { branch: s.branch } : {}),
    ...(s.repo !== undefined ? { repo: s.repo } : {}),
    ...(s.harness !== undefined ? { harness: s.harness } : {}),
    ...(s.agent_version !== undefined ? { agent_version: s.agent_version } : {}),
    ...(s.models !== undefined ? { models: s.models } : {}),
    ...(s.labels !== undefined ? { labels: s.labels } : {}),
    ...(s.source_id !== undefined ? { source_id: s.source_id } : {}),
    visibility: s.visibility,
    ...(started !== undefined ? { started_at: started } : {}),
    ...(ended !== undefined ? { ended_at: ended } : {}),
    updated_at: s.updated_at,
  };
}

function resultOf(hit: BackendHit): SearchResult {
  return {
    ...summaryOf(hit.session),
    score: hit.score,
    hits: hit.hits,
    matches: hit.matches.map((m) => {
      const timestamp = iso(m.timestamp);
      return {
        content_hash: m.content_hash,
        event_index: m.event_index,
        seq: m.seq,
        role: m.role,
        ...(m.tool_name !== undefined ? { tool_name: m.tool_name } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...highlights(m.marked),
      };
    }),
  };
}

interface Opened {
  index: IndexStore;
  indexer: Indexer;
}

export class SearchService {
  private readonly options: SearchServiceOptions;
  private readonly aliases: OwnerAliases;
  private opened: Promise<Opened> | undefined;
  private closed = false;
  /** Reads in flight, which `close()` lets finish before it closes the index. */
  private readonly reads = new Set<Promise<unknown>>();

  constructor(options: SearchServiceOptions) {
    this.options = options;
    this.aliases = options.aliases ?? new OwnerAliases();
  }

  private open(): Promise<Opened> {
    if (this.closed) return Promise.reject(new SearchUnavailable("search is shut down"));
    if (!this.opened) {
      const opening = this.openIndex();
      // A failed open is tried again on the next call.
      opening.catch(() => {
        if (this.opened === opening) this.opened = undefined;
      });
      this.opened = opening;
    }
    return this.opened;
  }

  private async openIndex(): Promise<Opened> {
    const open =
      this.options.open ??
      sqliteIndex({
        path:
          this.options.settings.path ?? defaultIndexPath({ deployment: this.options.deployment }),
      });
    const index = await open({
      deployment: this.options.deployment,
      events: this.options.settings.events,
      ...(this.options.settings.maxChars ? { max_chars: this.options.settings.maxChars } : {}),
      ...(this.options.scope !== undefined ? { scope: this.options.scope } : {}),
      ...(this.options.feed ? { feed: true } : {}),
    });
    const indexer = new Indexer({
      store: this.options.store,
      index,
      events: this.options.settings.events,
      ...(this.options.settings.maxChars ? { maxChars: this.options.settings.maxChars } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
      ...this.options.indexer,
      ...(this.options.feed ? { feed: true } : {}),
    });
    return { index, indexer };
  }

  /** Run `read` against the open index. One that starts after `close()` is refused, and
   * `close()` waits for those already running, so none meets a closed index. */
  private async reading<T>(read: (index: IndexStore) => Promise<T>): Promise<T> {
    const { index } = await this.open();
    if (this.closed) throw new SearchUnavailable("search is shut down");
    const running = read(index);
    this.reads.add(running);
    try {
      return await running;
    } finally {
      this.reads.delete(running);
    }
  }

  /** The index is shared by every instance and kept by the worker (LanceDB). */
  get shared(): boolean {
    return this.options.shared === true;
  }

  private writable(): void {
    if (this.options.readOnly) {
      throw new Error("this process reads the search index and never writes it: the worker does");
    }
  }

  async run(signal?: AbortSignal): Promise<IndexerRun> {
    this.writable();
    return (await this.open()).indexer.run(signal);
  }

  async catchUp(signal?: AbortSignal): Promise<IndexerRun> {
    this.writable();
    return (await this.open()).indexer.catchUp(signal);
  }

  /** Whether `owner`'s change feed holds an entry this index has not read (one listing). */
  async behind(owner: string): Promise<boolean> {
    return (await this.open()).indexer.behind(owner);
  }

  /** Drop everything the index holds and build it again from the change feed (F10.2). Until
   * it has caught up, queries here and in any process sharing the file are refused. Not for a
   * shared index: see `startRebuild()`. */
  async rebuild(signal?: AbortSignal): Promise<IndexerRun> {
    this.writable();
    if (this.shared) throw new Error("a shared index is rebuilt by the worker: startRebuild()");
    const { index, indexer } = await this.open();
    await index.reset();
    indexer.forgetOwners();
    return indexer.catchUp(signal);
  }

  /** Ask the worker to rebuild a shared index, and return at once: it starts the rebuild on
   * its next pass and builds the new generation beside the live one, which keeps answering
   * until it goes live (F10.11). Only the request is written, so a read-only service may ask:
   * the worker stays the one writer (F10.8). */
  async requestRebuild(): Promise<RebuildRequested> {
    if (!this.shared) throw new Error("this index is rebuilt in process: rebuild()");
    return this.reading(async (index) => {
      if (index.requestRebuild === undefined) throw new Error("this index rebuilds in process");
      const from = (await index.state()).generation;
      await index.requestRebuild();
      return { from };
    });
  }

  /** Ask the worker to scrub on its next pass (F10.12, `seshi search --scrub`). False for a
   * backend with nothing to scrub, which deletes text when it commits (SQLite). Like
   * `requestRebuild`, it writes only the request. */
  async requestScrub(): Promise<boolean> {
    const { index } = await this.open();
    if (index.requestScrub === undefined) return false;
    await index.requestScrub();
    return true;
  }

  status(): Promise<SearchStatus> {
    return this.reading(async (index) => {
      const state = await index.state();
      return {
        backend: this.shared ? "lance" : "sqlite",
        location: index.location(),
        ready: state.ready_at !== undefined,
        ...(state.ready_at !== undefined ? { ready_at: state.ready_at } : {}),
        ...(state.caught_up_at !== undefined ? { caught_up_at: state.caught_up_at } : {}),
        sessions: state.sessions,
        events: state.events,
        ...(this.shared && state.generation !== "" ? { generation: state.generation } : {}),
        ...(state.building ? { building: state.building } : {}),
        ...(state.stale_schema ? { stale_schema: state.stale_schema } : {}),
        ...(state.requested ? { requested: state.requested } : {}),
      };
    });
  }

  /** The live generation's tables for `sql`'s DuckDB views (LanceDB); undefined for SQLite, or
   * before a generation is live. */
  sqlTables(): Promise<SqlTables | undefined> {
    return this.reading(async (index) => index.sqlTables?.());
  }

  ready(): Promise<boolean> {
    return this.reading(async (index) => (await index.state()).ready_at !== undefined);
  }

  /** Answer `request` as `viewer` may see it. Throws `SearchQueryError` for a request that
   * cannot be run and `SearchUnavailable` while the index is being built. */
  async search(viewer: Viewer, request: SearchRequest): Promise<SearchResults> {
    const checked = checkRequest(request, this.aliases);
    return this.reading((index) => this.answer(index, viewer, checked));
  }

  private async answer(
    index: IndexStore,
    viewer: Viewer,
    checked: Checked,
  ): Promise<SearchResults> {
    const state = await index.state();
    const readyAt = state.ready_at;
    if (readyAt === undefined) {
      throw new SearchUnavailable(
        "the search index is being built from the change feed; try again shortly",
      );
    }
    const found = await index.query({ ...checked.query, viewer });
    const verified = (
      await Promise.all(
        found.hits.map(async (hit) => {
          const session = await this.recheck(viewer, hit.session);
          return session === null ? null : { ...hit, session };
        }),
      )
    ).filter((h): h is BackendHit => h !== null);
    const next = checked.query.offset + checked.query.limit;
    const caughtUpAt = state.caught_up_at;
    return {
      query: checked.q,
      total: found.total,
      ...(found.capped ? { capped: true as const } : {}),
      results: verified.map(resultOf),
      ...(next < found.total && next <= MAX_OFFSET ? { cursor: String(next) } : {}),
      index: {
        ready_at: readyAt,
        ...(caughtUpAt !== undefined ? { caught_up_at: caughtUpAt } : {}),
        sessions: state.sessions,
      },
    };
  }

  /** A session the index gave, checked against its live metadata: null when it is gone,
   * redacted, a stub, or one `viewer` may no longer read; else with its live visibility. */
  private async recheck(viewer: Viewer, session: IndexedSession): Promise<IndexedSession | null> {
    if (this.options.verify === false) return session;
    let live: SessionMetadata | null;
    try {
      live = await liveMetadata(this.options.store, session.owner, session.archive_id);
    } catch (err) {
      // The key in use may not read this owner's folder (F11.5): not a result.
      if (accessDeniedIn(err)) return null;
      throw err;
    }
    if (live === null || live.status === "redacted" || live.head === undefined) return null;
    if (!viewer.canRead({ owner: live.owner, visibility: live.visibility })) return null;
    return { ...session, visibility: live.visibility };
  }

  /** The sessions `viewer` may read that match `request`'s filters and overlap its window (the
   * last 7 days by default), newest first (`GET /v1/search/sessions`, `list_sessions`). Each is
   * checked against its live metadata, as search results are. Throws `SearchQueryError` for a
   * request that cannot be run and `SearchUnavailable` while the index is being built. */
  async listSessions(viewer: Viewer, request: SessionListRequest): Promise<SessionList> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const checked = checkListRequest(request, now, this.aliases);
    return this.reading(async (index) => {
      const state = await index.state();
      const readyAt = state.ready_at;
      if (readyAt === undefined) {
        throw new SearchUnavailable(
          "the search index is being built from the change feed; try again shortly",
        );
      }
      // Sessions the live check drops (made owner-only, deleted, since the index read them) leave
      // a page short: read on, a few pages at most, so an answer is never empty while more
      // follow.
      const kept: IndexedSession[] = [];
      let after = checked.after;
      let more = false;
      let last: IndexedSession | undefined;
      for (let pages = 0; pages < LIST_PAGES && kept.length < checked.limit; pages++) {
        const page = await index.listSessions({
          ...checked,
          ...(after !== undefined ? { after } : {}),
          limit: checked.limit - kept.length,
          viewer,
        });
        const live = await Promise.all(page.sessions.map((s) => this.recheck(viewer, s)));
        kept.push(...live.filter((s): s is IndexedSession => s !== null));
        last = page.sessions.at(-1) ?? last;
        more = page.more;
        if (!more || last === undefined) break;
        after = positionOf(last);
      }
      const caughtUpAt = state.caught_up_at;
      return {
        sessions: kept.map(summaryOf),
        window: {
          since: new Date(checked.since).toISOString(),
          ...(checked.until !== undefined ? { until: new Date(checked.until).toISOString() } : {}),
        },
        ...(more && last !== undefined ? { cursor: encodeSessionCursor(last) } : {}),
        index: {
          ready_at: readyAt,
          ...(caughtUpAt !== undefined ? { caught_up_at: caughtUpAt } : {}),
          sessions: state.sessions,
        },
      };
    });
  }

  /** Every owner's change feed as one, read from this index's copy of it (`GET
   * /v1/changes/all`). Throws `SearchQueryError` for a cursor it did not give and
   * `SearchUnavailable` until the index has read every feed once. Only a service built with
   * `feed` has one; an index limited to some owners or sessions (F11.9) never does. */
  async changes(options: ReadChangesOptions = {}): Promise<AllChangesPage> {
    if (
      !this.options.feed ||
      this.options.indexer?.owners !== undefined ||
      this.options.indexer?.admit !== undefined
    ) {
      throw new Error("this index keeps no copy of every owner's feed");
    }
    const page = await this.reading((index) => readFeed(index, options));
    if (page === null) {
      throw new SearchUnavailable(
        "the search index is reading every owner's change feed for the first time; try again shortly",
      );
    }
    return page;
  }

  /** Close the index, once the reads in flight have finished. The service is not used after
   * this. */
  async close(): Promise<void> {
    this.closed = true;
    const opened = this.opened;
    this.opened = undefined;
    if (opened === undefined) return;
    await Promise.allSettled([...this.reads]);
    let index: IndexStore;
    try {
      ({ index } = await opened);
    } catch {
      return;
    }
    await index.close();
  }
}
