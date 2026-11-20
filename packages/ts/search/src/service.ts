import { OwnerAliases } from "@seshi/auth";
import {
  type AllChangesPage,
  type EventRole,
  type ReadChangesOptions,
  SEARCH_SORTS,
  type SearchRequest,
  type SearchResult,
  type SearchResults,
  type SearchSort,
  type SessionMetadata,
  upgradeMetadata,
} from "@seshi/model";
import { accessDeniedIn, decodeJson, getBytes, isOwner, keys, type Store } from "@seshi/store";
import type { BackendHit, BackendQuery, IndexStore } from "./backend";
import { readFeed } from "./feed";
import { Indexer, type IndexerLogger, type IndexerOptions, type IndexerRun } from "./indexer";
import { defaultIndexPath } from "./paths";
import { parseQuery, SearchQueryError } from "./query";
import { highlights } from "./snippet";
import { SqliteIndex } from "./sqlite";
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
  /** The index file; `defaultIndexPath(deployment)` when omitted. `:memory:` for none. */
  path?: string;
  events: readonly EventRole[];
}

export interface SearchServiceOptions {
  store: Store;
  deployment: string;
  settings: SearchSettings;
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
  path: string;
  ready: boolean;
  ready_at?: string;
  caught_up_at?: string;
  sessions: number;
  events: number;
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
  const source = text(request.source, "source");
  return {
    q: request.q,
    query: {
      match,
      ...(owner !== undefined ? { owners: aliases.storedAs(owner) } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(repo !== undefined ? { repo } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      sort: sort as SearchSort,
      limit: count(request.limit, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
      matches: count(request.matches, "matches", DEFAULT_MATCHES, 0, MAX_MATCHES),
      offset,
    },
  };
}

async function liveMetadata(
  store: Store,
  owner: string,
  archive: string,
): Promise<SessionMetadata | null> {
  const bytes = await getBytes(store, keys.metadata(owner, archive));
  if (bytes === null) return null;
  try {
    return upgradeMetadata(decodeJson<SessionMetadata>(bytes));
  } catch {
    return null;
  }
}

function resultOf(hit: BackendHit): SearchResult {
  const s = hit.session;
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
    ...(s.source_id !== undefined ? { source_id: s.source_id } : {}),
    visibility: s.visibility,
    ...(started !== undefined ? { started_at: started } : {}),
    ...(ended !== undefined ? { ended_at: ended } : {}),
    updated_at: s.updated_at,
    score: hit.score,
    hits: hit.hits,
    matches: hit.matches.map((m) => {
      const timestamp = iso(m.timestamp);
      return {
        content_hash: m.content_hash,
        event_index: m.event_index,
        role: m.role,
        ...(m.tool_name !== undefined ? { tool_name: m.tool_name } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...highlights(m.marked),
      };
    }),
  };
}

export class SearchService {
  readonly path: string;
  private readonly options: SearchServiceOptions;
  private readonly aliases: OwnerAliases;
  private opened: { index: IndexStore; indexer: Indexer } | undefined;
  private closed = false;

  constructor(options: SearchServiceOptions) {
    this.options = options;
    this.aliases = options.aliases ?? new OwnerAliases();
    this.path = options.settings.path ?? defaultIndexPath({ deployment: options.deployment });
  }

  private open(): { index: IndexStore; indexer: Indexer } {
    if (this.closed) throw new SearchUnavailable("search is shut down");
    if (!this.opened) {
      const index = new SqliteIndex({
        path: this.path,
        deployment: this.options.deployment,
        events: this.options.settings.events,
        ...(this.options.scope !== undefined ? { scope: this.options.scope } : {}),
        ...(this.options.feed ? { feed: true } : {}),
      });
      const indexer = new Indexer({
        store: this.options.store,
        index,
        events: this.options.settings.events,
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
        ...this.options.indexer,
        ...(this.options.feed ? { feed: true } : {}),
      });
      this.opened = { index, indexer };
    }
    return this.opened;
  }

  run(signal?: AbortSignal): Promise<IndexerRun> {
    return this.open().indexer.run(signal);
  }

  catchUp(signal?: AbortSignal): Promise<IndexerRun> {
    return this.open().indexer.catchUp(signal);
  }

  /** Drop everything the index holds and build it again from the change feed (F10.2). Until
   * it has caught up, queries here and in any process sharing the file are refused. */
  async rebuild(signal?: AbortSignal): Promise<IndexerRun> {
    const { index, indexer } = this.open();
    index.reset();
    indexer.forgetOwners();
    return indexer.catchUp(signal);
  }

  status(): SearchStatus {
    const { index } = this.open();
    const readyAt = index.readyAt();
    const caughtUpAt = index.caughtUpAt();
    return {
      path: this.path,
      ready: readyAt !== undefined,
      ...(readyAt !== undefined ? { ready_at: readyAt } : {}),
      ...(caughtUpAt !== undefined ? { caught_up_at: caughtUpAt } : {}),
      ...index.counts(),
    };
  }

  ready(): boolean {
    return this.open().index.readyAt() !== undefined;
  }

  /** Answer `request` as `viewer` may see it. Throws `SearchQueryError` for a request that
   * cannot be run and `SearchUnavailable` while the index is being built. */
  async search(viewer: Viewer, request: SearchRequest): Promise<SearchResults> {
    const checked = checkRequest(request, this.aliases);
    const { index } = this.open();
    const readyAt = index.readyAt();
    if (readyAt === undefined) {
      throw new SearchUnavailable(
        "the search index is being built from the change feed; try again shortly",
      );
    }
    const found = index.query({ ...checked.query, viewer });
    const verified =
      this.options.verify === false
        ? found.hits
        : (
            await Promise.all(
              found.hits.map(async (hit) => {
                let live: Awaited<ReturnType<typeof liveMetadata>>;
                try {
                  live = await liveMetadata(
                    this.options.store,
                    hit.session.owner,
                    hit.session.archive_id,
                  );
                } catch (err) {
                  // The key in use may not read this owner's folder (F11.5): not a result.
                  if (accessDeniedIn(err)) return null;
                  throw err;
                }
                if (live === null || live.status === "redacted" || live.head === undefined) {
                  return null;
                }
                if (!viewer.canRead({ owner: live.owner, visibility: live.visibility })) {
                  return null;
                }
                return { ...hit, session: { ...hit.session, visibility: live.visibility } };
              }),
            )
          ).filter((h): h is BackendHit => h !== null);
    const next = checked.query.offset + checked.query.limit;
    const caughtUpAt = index.caughtUpAt();
    return {
      query: checked.q,
      total: found.total,
      results: verified.map(resultOf),
      ...(next < found.total && next <= MAX_OFFSET ? { cursor: String(next) } : {}),
      index: {
        ready_at: readyAt,
        ...(caughtUpAt !== undefined ? { caught_up_at: caughtUpAt } : {}),
        sessions: index.counts().sessions,
      },
    };
  }

  /** Every owner's change feed as one, read from this index's copy of it (`GET
   * /v1/changes/all`). Throws `SearchQueryError` for a cursor it did not give and
   * `SearchUnavailable` until the index has read every feed once. Only a service built with
   * `feed` has one; an index limited to some owners or sessions (F11.9) never does. */
  changes(options: ReadChangesOptions = {}): AllChangesPage {
    if (
      !this.options.feed ||
      this.options.indexer?.owners !== undefined ||
      this.options.indexer?.admit !== undefined
    ) {
      throw new Error("this index keeps no copy of every owner's feed");
    }
    const page = readFeed(this.open().index, options);
    if (page === null) {
      throw new SearchUnavailable(
        "the search index is reading every owner's change feed for the first time; try again shortly",
      );
    }
    return page;
  }

  /** Close the index file. The service is not used after this. */
  close(): void {
    this.closed = true;
    this.opened?.index.close();
    this.opened = undefined;
  }
}
