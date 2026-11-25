/** The search index on LanceDB (F10.6 to F10.12): one index for every API instance, in a folder
 * or a bucket, written by one indexer. docs/seshi/lancedb-search.md is the design. Imported only
 * through `lanceIndex()` (lance-open.ts), so LanceDB stays off every other path. */
import {
  BooleanQuery,
  type Connection,
  connect,
  type FullTextQuery,
  Index,
  MatchQuery,
  makeArrowTable,
  Occur,
  Operator,
  PhraseQuery,
  type Table,
} from "@lancedb/lancedb";
import type { ChangeEntry, EventRole, Labels, Visibility } from "@seshi/model";
import { changeStamp } from "@seshi/store";
import {
  Table as ArrowTable,
  Bool,
  Field,
  Int32,
  Int64,
  List,
  RecordBatch,
  Schema,
  TimestampMillisecond,
  Utf8,
} from "apache-arrow";
import {
  type BackendHit,
  type BackendMatch,
  type BackendQuery,
  type BackendResults,
  type CommitResult,
  type FeedPosition,
  type FeedRow,
  type IndexedSession,
  type IndexOptions,
  type IndexState,
  type IndexStore,
  IndexUnavailable,
  type PageCommit,
  type SessionUpdate,
} from "./backend";
import {
  compileMatch,
  type FtsQuery,
  filterSql,
  matchesTree,
  needsCheck,
  prefixesOf,
  sqlList,
  sqlString,
  sqlTime,
} from "./lance-query";
import { SearchQueryError } from "./query";
import { excerpt, indexText } from "./snippet";

/** The layout of the tables and `meta`: an index written under another is rebuilt beside it. */
export const LANCE_SCHEMA = "seshi/search-lance/1";

/** The steps of `commit()`, in order: what a crash test fails before. */
export const COMMIT_STEPS = [
  "events",
  "delete",
  "scrub_due",
  "sessions",
  "changes",
  "seen",
  "cursor",
] as const;
export type CommitStep = (typeof COMMIT_STEPS)[number];

export interface LanceIndexOptions {
  /** A folder, or a bucket URI LanceDB takes (`s3://`, `gs://`, `az://`). Never credentials:
   * those go in `storageOptions`. */
  uri: string;
  storageOptions?: Record<string, string>;
  /** How soon, in seconds, a reader sees another process's commit (5). 0 checks on every read. */
  readConsistency?: number;
  /** `optimize()` at most this often, in ms, and only after a commit (an hour). */
  optimizeEvery?: number;
  /** A due scrub at most this often, in ms (a day). */
  scrubEvery?: number;
  /** How long a replaced table or generation is kept for readers still on it, in ms (15
   * minutes). Also `optimize()`'s `cleanupOlderThan`. */
  grace?: number;
  /** Rows a relevance search scores at most (10,000). */
  maxScoredRows?: number;
  /** Rows a recent search reads at most (100,000). */
  maxRecentRows?: number;
  /** An API instance: it reads and never writes, not even `meta`. */
  readOnly?: boolean;
  now?: () => number;
  /** Tests only: called before each step of `commit()`; a throw is a crash there. */
  beforeStep?: (step: CommitStep) => void | Promise<void>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Rows copied per `add()` in a scrub. */
const COPY_BATCH = 50_000;
/** Recent searches that reach the cap run again in these windows (days back from now). */
const RECENT_WINDOWS = [1, 7, 30];

const str = (name: string, nullable = false) => new Field(name, new Utf8(), nullable);
const strList = (name: string) =>
  new Field(name, new List(new Field("item", new Utf8(), true)), false);
const ms = (name: string, nullable = false) =>
  new Field(name, new TimestampMillisecond(), nullable);
const i64 = (name: string) => new Field(name, new Int64(), false);

type Kind = "events" | "sessions" | "cursors" | "seen" | "changes";
const KINDS: readonly Kind[] = ["events", "sessions", "cursors", "seen", "changes"];

const SCHEMAS: Record<Kind | "meta", Schema> = {
  events: new Schema([
    str("id"),
    str("owner"),
    str("archive_id"),
    str("content_hash"),
    new Field("event_index", new Int32(), false),
    str("role"),
    str("tool_name", true),
    ms("ts", true),
    str("text"),
    str("text_prefix"),
    str("format"),
    str("origin_agent", true),
    str("repo", true),
    str("branch", true),
    str("harness", true),
    str("agent_version", true),
    str("source_id", true),
    strList("models"),
    strList("labels"),
    str("visibility"),
    ms("session_updated"),
  ]),
  sessions: new Schema([
    str("id"),
    str("owner"),
    str("archive_id"),
    str("format"),
    str("session_id"),
    str("origin_agent", true),
    str("native_session_id", true),
    str("project", true),
    str("branch", true),
    str("repo", true),
    str("harness", true),
    str("agent_version", true),
    str("source_id", true),
    str("visibility"),
    strList("models"),
    str("labels", true),
    ms("started_at", true),
    ms("ended_at", true),
    str("updated_at"),
    i64("updated_ms"),
    strList("traces"),
    i64("read_at"),
    new Field("removed", new Bool(), false),
  ]),
  cursors: new Schema([str("owner"), str("cursor")]),
  seen: new Schema([str("owner"), str("key"), i64("at")]),
  changes: new Schema([str("stamp"), str("owner"), str("name"), str("entry")]),
  meta: new Schema([str("key"), str("value")]),
};

/** The full-text indexes, built once a generation has caught up (and on a scrub's copy). An
 * `Index` is used up by the `createIndex` it is given, so each is made afresh. */
const TEXT_INDEXES: Partial<Record<Kind, [string, () => Index][]>> = {
  events: [
    [
      "text",
      () =>
        Index.fts({
          baseTokenizer: "simple",
          lowercase: true,
          asciiFolding: true,
          stem: false,
          removeStopWords: false,
          // Phrases need positions; 0.41.0 does not default to them.
          withPosition: true,
        }),
    ],
    [
      "text_prefix",
      () =>
        Index.fts({
          baseTokenizer: "simple",
          lowercase: true,
          asciiFolding: true,
          stem: false,
          removeStopWords: false,
          withPosition: false,
        }),
    ],
  ],
};

/** The scalar indexes, made with each table: `mergeInsert` and lookups use them. */
const SCALAR_INDEXES: Record<Kind, [string, () => Index][]> = {
  events: [
    ["id", Index.btree],
    ["owner", Index.btree],
    ["archive_id", Index.btree],
    ["session_updated", Index.btree],
    ["visibility", Index.bitmap],
    ["role", Index.bitmap],
    ["format", Index.bitmap],
    ["models", Index.labelList],
    ["labels", Index.labelList],
  ],
  sessions: [["id", Index.btree]],
  cursors: [],
  seen: [["key", Index.btree]],
  changes: [["stamp", Index.btree]],
};

/** What a generation was built for: one built for another is rebuilt. */
interface GenConfig {
  schema: string;
  events: string;
  scope?: string;
  feed?: boolean;
}

function configOf(options: IndexOptions): GenConfig {
  return {
    schema: LANCE_SCHEMA,
    events: JSON.stringify([...options.events].sort()),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.feed ? { feed: true } : {}),
  };
}

function sameConfig(a: string | undefined, b: GenConfig): boolean {
  return a === JSON.stringify(b);
}

/** `meta`'s keys. Those of one generation are `<gen>.<key>`. */
type Meta = Map<string, string>;
const gk = (gen: string, key: string) => `${gen}.${key}`;

interface Trash {
  gen: string;
  /** One table of the generation; the whole generation when absent. */
  table?: string;
  at: number;
}

function newGeneration(): string {
  return `g${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
}

/** `<uri>/<part>`, for a folder or a bucket URI. */
function under(uri: string, part: string): string {
  return `${uri.replace(/\/+$/, "")}/${part}`;
}

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function list(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  // An Arrow list vector.
  return [...(value as Iterable<unknown>)].map(String);
}

interface SessionRow {
  id: string;
  owner: string;
  archive_id: string;
  format: string;
  session_id: string;
  origin_agent: string | null;
  native_session_id: string | null;
  project: string | null;
  branch: string | null;
  repo: string | null;
  harness: string | null;
  agent_version: string | null;
  source_id: string | null;
  visibility: string;
  models: string[];
  labels: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  updated_at: string;
  updated_ms: bigint;
  traces: string[];
  read_at: bigint;
  removed: boolean;
}

/** A sessions row as read, normalized. */
interface HeldSession {
  row: SessionRow;
  session: IndexedSession;
  readAt: number;
  removed: boolean;
}

function heldOf(raw: Record<string, unknown>): HeldSession {
  const models = list(raw.models);
  const traces = list(raw.traces);
  const labels = optional(raw.labels);
  const started = raw.started_at === null ? undefined : num(raw.started_at);
  const ended = raw.ended_at === null ? undefined : num(raw.ended_at);
  const pick = (key: string) => optional(raw[key]);
  const session: IndexedSession = {
    owner: String(raw.owner),
    archive_id: String(raw.archive_id),
    format: String(raw.format),
    session_id: String(raw.session_id),
    ...(pick("origin_agent") !== undefined ? { origin_agent: pick("origin_agent") } : {}),
    ...(pick("native_session_id") !== undefined
      ? { native_session_id: pick("native_session_id") }
      : {}),
    ...(pick("project") !== undefined ? { project: pick("project") } : {}),
    ...(pick("branch") !== undefined ? { branch: pick("branch") } : {}),
    ...(pick("repo") !== undefined ? { repo: pick("repo") } : {}),
    ...(pick("harness") !== undefined ? { harness: pick("harness") } : {}),
    ...(pick("agent_version") !== undefined ? { agent_version: pick("agent_version") } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(labels !== undefined ? { labels: JSON.parse(labels) as Labels } : {}),
    ...(pick("source_id") !== undefined ? { source_id: pick("source_id") } : {}),
    visibility: String(raw.visibility) as Visibility,
    ...(started !== undefined ? { started_at: started } : {}),
    ...(ended !== undefined ? { ended_at: ended } : {}),
    updated_at: String(raw.updated_at),
    traces,
  } as IndexedSession;
  const row = {
    ...(raw as unknown as SessionRow),
    models,
    traces,
    labels: labels ?? null,
    started_at: started === undefined ? null : new Date(started),
    ended_at: ended === undefined ? null : new Date(ended),
    read_at: BigInt(num(raw.read_at)),
    updated_ms: BigInt(num(raw.updated_ms)),
  };
  return { row, session, readAt: num(raw.read_at), removed: Boolean(raw.removed) };
}

function sessionRow(s: IndexedSession, readAt: number): SessionRow {
  return {
    id: `${s.owner}/${s.archive_id}`,
    owner: s.owner,
    archive_id: s.archive_id,
    format: s.format,
    session_id: s.session_id,
    origin_agent: s.origin_agent ?? null,
    native_session_id: s.native_session_id ?? null,
    project: s.project ?? null,
    branch: s.branch ?? null,
    repo: s.repo ?? null,
    harness: s.harness ?? null,
    agent_version: s.agent_version ?? null,
    source_id: s.source_id ?? null,
    visibility: s.visibility,
    models: s.models ?? [],
    labels: s.labels && Object.keys(s.labels).length > 0 ? JSON.stringify(s.labels) : null,
    started_at: s.started_at === undefined ? null : new Date(s.started_at),
    ended_at: s.ended_at === undefined ? null : new Date(s.ended_at),
    updated_at: s.updated_at,
    updated_ms: BigInt(Date.parse(s.updated_at) || 0),
    traces: [...s.traces],
    read_at: BigInt(readAt),
    removed: false,
  };
}

/** The session fields copied onto each of its `events` rows. */
function copied(s: IndexedSession): Record<string, unknown> {
  return {
    format: s.format,
    origin_agent: s.origin_agent ?? null,
    repo: s.repo ?? null,
    branch: s.branch ?? null,
    harness: s.harness ?? null,
    agent_version: s.agent_version ?? null,
    source_id: s.source_id ?? null,
    models: s.models ?? [],
    labels: Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${v}`),
    visibility: s.visibility,
    session_updated: new Date(Date.parse(s.updated_at) || 0),
  };
}

/** Whether rows copied from `before` must be written again for `after`. `session_updated` is
 * left out: it moves with every continuation, and rewriting a long session's rows on each would
 * cost more than an older value on its earlier rows (it only orders recent searches). */
function copiedChanged(before: IndexedSession, after: IndexedSession): boolean {
  const a = copied(before);
  const b = copied(after);
  delete a.session_updated;
  delete b.session_updated;
  return JSON.stringify(a) !== JSON.stringify(b);
}

function toFts(q: FtsQuery): FullTextQuery {
  if ("match" in q) {
    return new MatchQuery(q.match, q.column, q.and ? { operator: Operator.And } : undefined);
  }
  if ("phrase" in q) return new PhraseQuery(q.phrase, q.column);
  const occur = { must: Occur.Must, should: Occur.Should, must_not: Occur.MustNot } as const;
  return new BooleanQuery(q.bool.map(([o, sub]) => [occur[o], toFts(sub)]));
}

interface Group {
  key: string;
  best: number;
  hits: number;
  updated: number;
  /** The best records, by score. */
  top: { id: string; score: number }[];
}

/** Opens (or, for the indexer, creates) the index at `options.uri`. */
export async function openLanceIndex(
  options: LanceIndexOptions,
  index: IndexOptions,
): Promise<LanceIndex> {
  const opened = new LanceIndex(options, index);
  await opened.open();
  return opened;
}

/** The index in LanceDB tables (F10.6): `meta` at the location, and each generation's tables
 * under `<gen>/`. One writer (the indexer) at a time; any number of readers. */
export class LanceIndex implements IndexStore {
  private readonly options: LanceIndexOptions;
  private readonly expected: GenConfig;
  private readonly deployment: string;
  private readonly now: () => number;
  private root: Connection | undefined;
  private metaTable: Table | undefined;
  private readonly gens = new Map<string, Promise<Connection>>();
  private readonly tables = new Map<string, Promise<Table>>();
  private cached: { meta: Meta; at: number } | undefined;

  constructor(options: LanceIndexOptions, index: IndexOptions) {
    this.options = options;
    this.expected = configOf(index);
    this.deployment = index.deployment;
    this.now = options.now ?? Date.now;
  }

  private get consistency(): number {
    return this.options.readConsistency ?? 5;
  }

  location(): string {
    return this.options.uri;
  }

  private connect(uri: string): Promise<Connection> {
    return connect(uri, {
      readConsistencyInterval: this.consistency,
      ...(this.options.storageOptions ? { storageOptions: this.options.storageOptions } : {}),
    });
  }

  /** Connect, and as the indexer, make sure `meta` names this deployment and a generation
   * built for this config is live or being built. */
  async open(): Promise<void> {
    this.root = await this.connect(this.options.uri);
    this.metaTable = await this.openMeta();
    if (this.metaTable === undefined && !this.options.readOnly) {
      this.metaTable = await this.root.createEmptyTable("meta", SCHEMAS.meta, { existOk: true });
      await this.metaTable.createIndex("key", { config: Index.btree() });
    }
    const meta = await this.meta(true);
    const deployment = meta.get("deployment");
    if (deployment !== undefined && deployment !== this.deployment) {
      throw new Error(
        `the search index at ${this.location()} belongs to deployment ${deployment}, not ${this.deployment}; nothing was changed`,
      );
    }
    if (this.options.readOnly) return;
    if (deployment === undefined) await this.setMeta({ deployment: this.deployment });
    const active = this.live(meta);
    const building = this.building(meta);
    if (building !== undefined && sameConfig(meta.get(gk(building, "config")), this.expected)) {
      return;
    }
    if (active !== undefined && sameConfig(meta.get(gk(active, "config")), this.expected)) {
      if (building !== undefined) await this.drop(building, { building: "" });
      return;
    }
    if (active === undefined) {
      // The first build: it is live from the start, and searches wait for it.
      const gen = newGeneration();
      await this.createGeneration(gen);
      await this.setMeta({ active: gen });
      return;
    }
    await this.reset();
  }

  // --- meta ---------------------------------------------------------------------------------

  /** `meta` as one map. Readers keep it `readConsistency` seconds; `fresh` reads it now. */
  private async meta(fresh = false): Promise<Meta> {
    const now = this.now();
    if (!fresh && this.cached && now - this.cached.at < this.consistency * 1000) {
      return this.cached.meta;
    }
    const meta: Meta = new Map();
    if (this.metaTable === undefined) {
      // A reader opened before the indexer made the index.
      this.metaTable = await this.openMeta();
      if (this.metaTable === undefined) return meta;
    }
    if (fresh) await this.metaTable.checkoutLatest();
    const rows = await this.metaTable.query().select(["key", "value"]).toArray();
    for (const row of rows) meta.set(String(row.key), String(row.value));
    this.cached = { meta, at: now };
    return meta;
  }

  private async openMeta(): Promise<Table | undefined> {
    const names = await (this.root as Connection).tableNames([]);
    return names.includes("meta") ? (this.root as Connection).openTable("meta") : undefined;
  }

  private async setMeta(values: Record<string, string>): Promise<void> {
    if (this.options.readOnly) throw new Error("a read-only search index writes nothing");
    const table = this.metaTable as Table;
    const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
    await table
      .mergeInsert("key")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(makeArrowTable(rows, { schema: SCHEMAS.meta }));
    this.cached = undefined;
  }

  private live(meta: Meta): string | undefined {
    return meta.get("active") || undefined;
  }

  private building(meta: Meta): string | undefined {
    return meta.get("building") || undefined;
  }

  /** The generation writes go to: the one being built, else the live one. */
  private writing(meta: Meta): string | undefined {
    return this.building(meta) ?? this.live(meta);
  }

  // --- tables -------------------------------------------------------------------------------

  /** The one place a table's name is decided: a scrub replaces a table with a copy under a new
   * name, recorded in `meta`. A later split of `events` (hot and cold, or by month) changes
   * this and the merge in `query()`, not the compiler. */
  private tableName(meta: Meta, gen: string, kind: Kind): string {
    return meta.get(gk(gen, `table.${kind}`)) ?? kind;
  }

  private generationDb(gen: string): Promise<Connection> {
    let db = this.gens.get(gen);
    if (!db) {
      db = this.connect(under(this.options.uri, gen));
      db.catch(() => this.gens.delete(gen));
      this.gens.set(gen, db);
    }
    return db;
  }

  private async table(meta: Meta, gen: string, kind: Kind): Promise<Table> {
    const name = this.tableName(meta, gen, kind);
    const key = `${gen}/${name}`;
    let table = this.tables.get(key);
    if (!table) {
      table = this.generationDb(gen).then((db) => db.openTable(name));
      table.catch(() => this.tables.delete(key));
      this.tables.set(key, table);
    }
    return table;
  }

  private async createTable(gen: string, kind: Kind, name: string = kind): Promise<Table> {
    const db = await this.generationDb(gen);
    const table = await db.createEmptyTable(name, SCHEMAS[kind], { existOk: true });
    const have = new Set((await table.listIndices()).flatMap((i) => i.columns));
    for (const [column, config] of SCALAR_INDEXES[kind]) {
      if (!have.has(column)) await table.createIndex(column, { config: config() });
    }
    this.tables.set(`${gen}/${name}`, Promise.resolve(table));
    return table;
  }

  private async createGeneration(gen: string): Promise<void> {
    for (const kind of KINDS) await this.createTable(gen, kind);
    await this.setMeta({ [gk(gen, "config")]: JSON.stringify(this.expected) });
  }

  private async textIndexes(table: Table, kind: Kind): Promise<void> {
    for (const [column, config] of TEXT_INDEXES[kind] ?? []) {
      await table.createIndex(column, { config: config(), replace: true });
    }
  }

  /** Set `meta` and put a generation in the trash, kept for readers still on it. */
  private async drop(gen: string, values: Record<string, string>): Promise<void> {
    await this.trash([{ gen, at: this.now() }], values);
  }

  private async trash(items: Trash[], values: Record<string, string> = {}): Promise<void> {
    const meta = await this.meta(true);
    const held = JSON.parse(meta.get("trash") ?? "[]") as Trash[];
    await this.setMeta({ ...values, trash: JSON.stringify([...held, ...items]) });
  }

  // --- the reader ---------------------------------------------------------------------------

  async state(): Promise<IndexState> {
    const meta = await this.reading(() => this.meta());
    const gen = this.live(meta);
    const building = this.building(meta);
    const servable = gen !== undefined && this.servable(meta, gen);
    const readyAt = servable ? meta.get(gk(gen, "ready_at")) : undefined;
    const caughtUpAt = servable ? meta.get(gk(gen, "caught_up_at")) : undefined;
    const readThrough = building ? meta.get(gk(building, "feed_through")) : undefined;
    return {
      ...(readyAt !== undefined ? { ready_at: readyAt } : {}),
      ...(caughtUpAt !== undefined ? { caught_up_at: caughtUpAt } : {}),
      sessions: gen ? Number(meta.get(gk(gen, "sessions")) ?? 0) : 0,
      events: gen ? Number(meta.get(gk(gen, "events")) ?? 0) : 0,
      generation: gen ?? "",
      ...(building
        ? {
            building: {
              generation: building,
              ...(readThrough !== undefined ? { read_through: readThrough } : {}),
            },
          }
        : {}),
    };
  }

  /** A generation this code can read: written under its schema. */
  private servable(meta: Meta, gen: string): boolean {
    const config = meta.get(gk(gen, "config"));
    if (config === undefined) return false;
    return (JSON.parse(config) as GenConfig).schema === LANCE_SCHEMA;
  }

  /** A read that cannot reach the index is `IndexUnavailable`; a bad query stays itself. */
  private async reading<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof SearchQueryError || err instanceof IndexUnavailable) throw err;
      throw new IndexUnavailable(
        `the search index at ${this.location()} could not be read: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async query(q: BackendQuery): Promise<BackendResults> {
    // Compile first: a bad query is the caller's, not the index's.
    const fts = toFts(compileMatch(q.match));
    const where = filterSql(q);
    if (where === null) return { total: 0, hits: [] };
    return this.reading(async () => {
      const meta = await this.meta();
      const gen = this.live(meta);
      if (gen === undefined || meta.get(gk(gen, "indexed")) === undefined) {
        return { total: 0, hits: [] };
      }
      const events = await this.table(meta, gen, "events");
      const check = needsCheck(q.match);
      const cap =
        q.sort === "recent"
          ? (this.options.maxRecentRows ?? 100_000)
          : (this.options.maxScoredRows ?? 10_000);
      const want = q.offset + q.limit;
      const search = async (window?: number) => {
        const clauses = [where, window === undefined ? "" : `session_updated >= ${sqlTime(window)}`]
          .filter((c) => c !== "")
          .map((c) => `(${c})`);
        let query = events
          .query()
          .fullTextSearch(fts)
          .select([
            "id",
            "owner",
            "archive_id",
            "session_updated",
            "_score",
            ...(check ? ["text"] : []),
          ])
          .limit(cap);
        if (clauses.length > 0) query = query.where(clauses.join(" AND "));
        const table = await query.toArrow();
        return { groups: this.group(table, q, check), capped: table.numRows >= cap };
      };
      let found = await search();
      if (q.sort === "recent" && found.capped) {
        // The capped rows are the best-scored, not the newest: look back from now instead.
        for (const days of RECENT_WINDOWS) {
          const windowed = await search(this.now() - days * DAY);
          if (!windowed.capped && windowed.groups.size >= want) {
            found = windowed;
            break;
          }
        }
      }
      const sorted = [...found.groups.values()].sort(
        q.sort === "recent"
          ? (a, b) => b.updated - a.updated || b.best - a.best || (a.key < b.key ? 1 : -1)
          : (a, b) => b.best - a.best || b.updated - a.updated || (a.key < b.key ? 1 : -1),
      );
      const page = sorted.slice(q.offset, want);
      const hits = await this.hitsOf(meta, gen, page, q);
      return { total: found.groups.size, hits, ...(found.capped ? { capped: true } : {}) };
    });
  }

  /** Group matching records by session: the best score, the count, and the best few. */
  private group(table: ArrowTable, q: BackendQuery, check: boolean): Map<string, Group> {
    const groups = new Map<string, Group>();
    const ids = table.getChild("id");
    const owners = table.getChild("owner");
    const archives = table.getChild("archive_id");
    const scores = table.getChild("_score");
    const updated = table.getChild("session_updated");
    const texts = check ? table.getChild("text") : null;
    for (let i = 0; i < table.numRows; i++) {
      if (texts && !matchesTree(String(texts.get(i)), q.match)) continue;
      const key = `${owners?.get(i)}/${archives?.get(i)}`;
      const score = Number(scores?.get(i));
      const id = String(ids?.get(i));
      let group = groups.get(key);
      if (!group) {
        group = { key, best: score, hits: 0, updated: num(updated?.get(i)), top: [] };
        groups.set(key, group);
      }
      group.hits++;
      group.best = Math.max(group.best, score);
      group.updated = Math.max(group.updated, num(updated?.get(i)));
      if (q.matches > 0) {
        group.top.push({ id, score });
        if (group.top.length > q.matches * 2) {
          group.top.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
          group.top.length = q.matches;
        }
      }
    }
    return groups;
  }

  /** The page's sessions, and its best records with their excerpts. */
  private async hitsOf(
    meta: Meta,
    gen: string,
    page: Group[],
    q: BackendQuery,
  ): Promise<BackendHit[]> {
    if (page.length === 0) return [];
    const sessions = await this.table(meta, gen, "sessions");
    const picked = page.flatMap((g) =>
      g.top
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .slice(0, q.matches)
        .map((t) => t.id),
    );
    const [rows, records] = await Promise.all([
      sessions
        .query()
        .where(`id IN (${sqlList(page.map((g) => g.key))})`)
        .limit(page.length)
        .toArray(),
      picked.length === 0
        ? Promise.resolve([])
        : (await this.table(meta, gen, "events"))
            .query()
            .where(`id IN (${sqlList(picked)})`)
            .select(["id", "content_hash", "event_index", "role", "tool_name", "ts", "text"])
            .limit(picked.length)
            .toArray(),
    ]);
    const held = new Map(
      rows.map((r) => {
        const h = heldOf(r as Record<string, unknown>);
        return [h.row.id, h] as const;
      }),
    );
    const byId = new Map(records.map((r) => [String(r.id), r]));
    const hits: BackendHit[] = [];
    for (const group of page) {
      const session = held.get(group.key);
      if (!session || session.removed) continue;
      const matches: BackendMatch[] = [];
      for (const { id } of group.top.slice(0, q.matches)) {
        const r = byId.get(id);
        if (!r) continue;
        matches.push({
          content_hash: String(r.content_hash),
          event_index: Number(r.event_index),
          role: String(r.role) as EventRole,
          ...(r.tool_name !== null && r.tool_name !== undefined
            ? { tool_name: String(r.tool_name) }
            : {}),
          ...(r.ts !== null && r.ts !== undefined ? { timestamp: num(r.ts) } : {}),
          marked: excerpt(String(r.text), q.match),
        });
      }
      hits.push({
        session: session.session,
        score: Number(group.best.toPrecision(6)),
        hits: group.hits,
        matches,
      });
    }
    return hits;
  }

  async feed(
    after: FeedPosition | undefined,
    limit: number,
  ): Promise<{ entries: FeedRow[]; more: boolean; through: string } | null> {
    return this.reading(async () => {
      const meta = await this.meta();
      const gen = this.live(meta);
      const through = gen ? meta.get(gk(gen, "feed_through")) : undefined;
      if (gen === undefined || through === undefined) return null;
      const last = sqlString(changeStamp(through));
      let where = `stamp <= ${last}`;
      if (after) {
        const [s, o, n] = [sqlString(after.stamp), sqlString(after.owner), sqlString(after.name)];
        where += ` AND (stamp > ${s} OR (stamp = ${s} AND (owner > ${o} OR (owner = ${o} AND name > ${n}))))`;
      }
      const rows = await (await this.table(meta, gen, "changes"))
        .query()
        .where(where)
        .orderBy([{ columnName: "stamp" }, { columnName: "owner" }, { columnName: "name" }])
        .limit(limit + 1)
        .toArray();
      return {
        entries: rows.slice(0, limit).map((r) => ({
          stamp: String(r.stamp),
          owner: String(r.owner),
          name: String(r.name),
          entry: JSON.parse(String(r.entry)) as ChangeEntry,
        })),
        more: rows.length > limit,
        through,
      };
    });
  }

  async close(): Promise<void> {
    for (const table of this.tables.values()) {
      try {
        (await table).close();
      } catch {
        // Never opened.
      }
    }
    this.tables.clear();
    this.metaTable?.close();
    for (const db of this.gens.values()) {
      try {
        (await db).close();
      } catch {
        // Never connected.
      }
    }
    this.gens.clear();
    this.root?.close();
  }

  // --- the writer ---------------------------------------------------------------------------

  async generation(): Promise<string> {
    const gen = this.writing(await this.meta(true));
    if (gen === undefined) throw new IndexUnavailable("the search index has no generation");
    return gen;
  }

  private async current(gen: string): Promise<Meta | null> {
    const meta = await this.meta();
    return this.writing(meta) === gen ? meta : null;
  }

  async cursors(gen: string, owners?: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const meta = await this.current(gen);
    if (!meta) return found;
    let query = (await this.table(meta, gen, "cursors")).query();
    if (owners !== undefined) {
      if (owners.length === 0) return found;
      query = query.where(`owner IN (${sqlList(owners)})`);
    }
    for (const row of await query.toArray()) found.set(String(row.owner), String(row.cursor));
    return found;
  }

  async seen(gen: string, owner: string, keys: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const meta = await this.current(gen);
    if (!meta || keys.length === 0) return found;
    const rows = await (await this.table(meta, gen, "seen"))
      .query()
      .where(`owner = ${sqlString(owner)} AND key IN (${sqlList(keys)})`)
      .select(["key"])
      .limit(keys.length)
      .toArray();
    for (const row of rows) found.add(String(row.key));
    return found;
  }

  /** Every row of these sessions, removed ones too. */
  private async held(
    meta: Meta,
    gen: string,
    owner: string,
    archives: readonly string[],
  ): Promise<Map<string, HeldSession>> {
    const out = new Map<string, HeldSession>();
    if (archives.length === 0) return out;
    const ids = archives.map((a) => `${owner}/${a}`);
    const rows = await (await this.table(meta, gen, "sessions"))
      .query()
      .where(`id IN (${sqlList(ids)})`)
      .limit(ids.length)
      .toArray();
    for (const row of rows) {
      const held = heldOf(row as Record<string, unknown>);
      out.set(held.row.archive_id, held);
    }
    return out;
  }

  async sessions(
    gen: string,
    owner: string,
    archives: readonly string[],
  ): Promise<Map<string, IndexedSession>> {
    const out = new Map<string, IndexedSession>();
    const meta = await this.current(gen);
    if (!meta) return out;
    for (const [archive, held] of await this.held(meta, gen, owner, archives)) {
      if (!held.removed) out.set(archive, held.session);
    }
    return out;
  }

  private eventRows(update: SessionUpdate): Record<string, unknown>[] {
    const { session } = update;
    const fields = copied(session);
    const rows: Record<string, unknown>[] = [];
    for (const event of update.events) {
      const text = indexText(event.text);
      if (text.trim() === "") continue;
      rows.push({
        id: `${session.owner}/${session.archive_id}/${event.content_hash}/${event.event_index}`,
        owner: session.owner,
        archive_id: session.archive_id,
        content_hash: event.content_hash,
        event_index: event.event_index,
        role: event.role,
        tool_name: event.tool_name ?? null,
        ts: event.timestamp === undefined ? null : new Date(event.timestamp),
        text,
        text_prefix: prefixesOf(text),
        ...fields,
      });
    }
    return rows;
  }

  /** One feed page, content tables first and the cursor last (F10.10). Every step is
   * idempotent, so a crash part-way is repaired by reading the page again. */
  async commit(page: PageCommit): Promise<CommitResult> {
    const meta = await this.meta(true);
    const gen = page.generation;
    if (this.writing(meta) !== gen) return { stale: true, refused: [], removed: 0 };
    const step = async (name: CommitStep) => this.options.beforeStep?.(name);
    const owner = page.owner;
    const archives = [
      ...new Set([
        ...page.updates.map((u) => u.session.archive_id),
        ...page.removals.map((r) => r.archive),
      ]),
    ];
    // 1. Check, writing nothing: what the index holds, against each update and removal.
    const held = await this.held(meta, gen, owner, archives);
    const refused: string[] = [];
    const sessionRows: SessionRow[] = [];
    const eventRows: Record<string, unknown>[] = [];
    /** Sessions whose earlier rows go: all of them, or all but these traces. */
    const doomed: { archive: string; keep: string[] }[] = [];
    const restamp: IndexedSession[] = [];
    let removed = 0;
    let scrub = false;
    for (const update of page.updates) {
      const { session } = update;
      const existing = held.get(session.archive_id);
      const readAt = update.read_at ?? 0;
      if (existing && existing.readAt > readAt) {
        refused.push(session.archive_id);
        continue;
      }
      if (!update.replace) {
        const holds = existing && !existing.removed ? existing.session.traces : [];
        if (JSON.stringify(holds) !== JSON.stringify(update.base ?? [])) {
          refused.push(session.archive_id);
          continue;
        }
      }
      const rows = this.eventRows(update);
      eventRows.push(...rows);
      if (update.replace || !existing || existing.removed) {
        doomed.push({
          archive: session.archive_id,
          keep: [...new Set(rows.map((r) => r.content_hash as string))],
        });
      } else if (copiedChanged(existing.session, session)) {
        restamp.push(session);
      }
      const row = sessionRow(session, readAt);
      sessionRows.push(row);
      held.set(session.archive_id, { row, session, readAt, removed: false });
    }
    for (const removal of page.removals) {
      const existing = held.get(removal.archive);
      if (existing && existing.readAt > removal.read_at) continue;
      if (existing && !existing.removed) removed++;
      if (removal.scrub) scrub = true;
      const base = existing?.row ?? {
        ...sessionRow(
          {
            owner,
            archive_id: removal.archive,
            format: "",
            session_id: "",
            visibility: "owner",
            updated_at: "",
            traces: [],
          },
          0,
        ),
        updated_ms: 0n,
      };
      const row = { ...base, traces: [], read_at: BigInt(removal.read_at), removed: true };
      sessionRows.push(row);
      held.set(removal.archive, {
        row,
        session: existing?.session ?? ({} as IndexedSession),
        readAt: removal.read_at,
        removed: true,
      });
      doomed.push({ archive: removal.archive, keep: [] });
    }
    const tables = {
      events: await this.table(meta, gen, "events"),
      sessions: await this.table(meta, gen, "sessions"),
    };
    // A continuation that changes a copied field (visibility, branch, labels, …) writes the
    // session's earlier rows again with it.
    for (const session of restamp) {
      const earlier = await tables.events
        .query()
        .where(`owner = ${sqlString(owner)} AND archive_id = ${sqlString(session.archive_id)}`)
        .toArray();
      const fields = copied(session);
      const fresh = new Set(eventRows.map((r) => r.id));
      for (const row of earlier) {
        if (fresh.has(row.id)) continue;
        eventRows.push({
          ...Object.fromEntries(SCHEMAS.events.fields.map((f) => [f.name, row[f.name]])),
          ts: row.ts === null ? null : new Date(num(row.ts)),
          models: list(row.models),
          labels: list(row.labels),
          ...fields,
        });
      }
    }
    // 2. events: insert and update, through the btree on id.
    await step("events");
    if (eventRows.length > 0) {
      await tables.events
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(
          makeArrowTable(
            latest(eventRows, (r) => String(r.id)),
            { schema: SCHEMAS.events },
          ),
        );
    }
    // 3. events again: the replaced and removed sessions' rows the page did not write.
    await step("delete");
    if (doomed.length > 0) {
      const predicate = doomed
        .map(
          ({ archive, keep }) =>
            `(archive_id = ${sqlString(archive)}${
              keep.length > 0 ? ` AND content_hash NOT IN (${sqlList(keep)})` : ""
            })`,
        )
        .join(" OR ");
      await tables.events.delete(`owner = ${sqlString(owner)} AND (${predicate})`);
    }
    // Before the cursor moves past it: deleted text must leave the bucket (F10.12).
    await step("scrub_due");
    if (scrub && meta.get("scrub_due") === undefined) {
      await this.setMeta({ scrub_due: new Date(this.now()).toISOString() });
    }
    // 4. sessions, tombstones included. After events, so a row never names traces whose
    // records are missing.
    await step("sessions");
    if (sessionRows.length > 0) {
      await tables.sessions
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(
          makeArrowTable(latest(sessionRows, (r) => r.id) as unknown as Record<string, unknown>[], {
            schema: SCHEMAS.sessions,
          }),
        );
    }
    // 5. The feed's copy: an entry already kept is left as it is.
    await step("changes");
    if (page.feed.length > 0) {
      const rows = page.feed.map(({ name, entry }) => ({
        stamp: name.slice(0, name.indexOf("-")),
        owner,
        name,
        entry: JSON.stringify(entry),
      }));
      await (await this.table(meta, gen, "changes"))
        .mergeInsert(["stamp", "owner", "name"])
        .whenNotMatchedInsertAll()
        .execute(
          makeArrowTable(
            dedupe(rows, (r) => `${r.stamp}\n${r.name}`),
            {
              schema: SCHEMAS.changes,
            },
          ),
        );
    }
    // 6. The keys seen, then the cursor.
    await step("seen");
    if (page.cursor !== undefined || page.seen.length > 0) {
      const seen = await this.table(meta, gen, "seen");
      if (page.seen.length > 0) {
        const rows = dedupe(
          page.seen.map(({ key, at }) => ({ owner, key, at: BigInt(at) })),
          (r) => r.key,
        );
        await seen
          .mergeInsert(["owner", "key"])
          .whenNotMatchedInsertAll()
          .execute(makeArrowTable(rows, { schema: SCHEMAS.seen }));
      }
      const forget = `owner = ${sqlString(owner)} AND at < ${Math.trunc(page.forgetBefore)}`;
      if (page.forgetBefore > 0 && (await seen.countRows(forget)) > 0) await seen.delete(forget);
      await step("cursor");
      const cursors = await this.table(meta, gen, "cursors");
      const at = (
        await cursors
          .query()
          .where(`owner = ${sqlString(owner)}`)
          .limit(1)
          .toArray()
      )[0]?.cursor as string | undefined;
      if (page.cursor !== undefined && (at === undefined || page.cursor > at)) {
        await cursors
          .mergeInsert("owner")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(makeArrowTable([{ owner, cursor: page.cursor }], { schema: SCHEMAS.cursors }));
      }
    }
    return { stale: false, refused, removed };
  }

  async readThrough(gen: string, through: string): Promise<void> {
    const meta = await this.meta(true);
    if (this.writing(meta) !== gen) return;
    const held = meta.get(gk(gen, "feed_through"));
    if (held === undefined || Date.parse(through) > Date.parse(held)) {
      await this.setMeta({ [gk(gen, "feed_through")]: through });
    }
  }

  async passDone(gen: string, at: string): Promise<boolean> {
    const meta = await this.meta(true);
    if (this.writing(meta) !== gen) return false;
    const values: Record<string, string> = { [gk(gen, "caught_up_at")]: at };
    if (meta.get(gk(gen, "ready_at")) === undefined) values[gk(gen, "ready_at")] = at;
    if (meta.get(gk(gen, "indexed")) === undefined) {
      // A generation's full-text indexes are built once, when it has caught up.
      for (const kind of KINDS) await this.textIndexes(await this.table(meta, gen, kind), kind);
      values[gk(gen, "indexed")] = at;
    }
    const events = await this.table(meta, gen, "events");
    const sessions = await this.table(meta, gen, "sessions");
    values[gk(gen, "events")] = String(await events.countRows());
    values[gk(gen, "sessions")] = String(await sessions.countRows("removed = false"));
    const old = this.live(meta);
    if (this.building(meta) === gen) {
      // The rebuild has caught up: it goes live, and the old generation is kept a while for
      // readers still on it.
      values.active = gen;
      values.building = "";
      if (old !== undefined && old !== gen) {
        const held = JSON.parse(meta.get("trash") ?? "[]") as Trash[];
        values.trash = JSON.stringify([...held, { gen: old, at: this.now() }]);
      }
    }
    await this.setMeta(values);
    return true;
  }

  /** A new generation beside the live one, which keeps answering until this one catches up
   * (F10.11). A generation already being built is dropped. */
  async reset(): Promise<string> {
    const meta = await this.meta(true);
    const gen = newGeneration();
    await this.createGeneration(gen);
    const values: Record<string, string> = { building: gen };
    const earlier = this.building(meta);
    if (earlier !== undefined) await this.drop(earlier, values);
    else await this.setMeta(values);
    return gen;
  }

  /** After a pass: drop what the grace has passed, then the scrub when due, else `optimize()`
   * when something was committed and the last is an `optimizeEvery` ago. */
  async maintain(signal: AbortSignal): Promise<void> {
    if (this.options.readOnly) return;
    const now = this.now();
    const grace = this.options.grace ?? 15 * MINUTE;
    let meta = await this.meta(true);
    await this.emptyTrash(meta, now - grace);
    if (signal.aborted) return;
    meta = await this.meta(true);
    const scrubbed = Date.parse(meta.get("scrubbed_at") ?? "") || 0;
    const due = meta.get("scrub_due") !== undefined || meta.get("scrub_requested") !== undefined;
    if (
      due &&
      (meta.get("scrub_requested") !== undefined ||
        now - scrubbed >= (this.options.scrubEvery ?? DAY))
    ) {
      await this.scrub(signal);
      return;
    }
    const gen = this.live(meta);
    if (gen === undefined || meta.get(gk(gen, "indexed")) === undefined) return;
    const optimized = Date.parse(meta.get(gk(gen, "optimized_at")) ?? "") || 0;
    if (now - optimized < (this.options.optimizeEvery ?? HOUR)) return;
    const versions = await this.versions(meta, gen);
    if (meta.get(gk(gen, "optimized_versions")) === versions) return;
    for (const kind of KINDS) {
      if (signal.aborted) return;
      await (await this.table(meta, gen, kind)).optimize({
        cleanupOlderThan: new Date(now - grace),
      });
    }
    await (this.metaTable as Table).optimize({ cleanupOlderThan: new Date(now - grace) });
    await this.setMeta({
      [gk(gen, "optimized_at")]: new Date(now).toISOString(),
      [gk(gen, "optimized_versions")]: await this.versions(meta, gen),
    });
  }

  /** The tables' versions: what changes when anything was committed. */
  private async versions(meta: Meta, gen: string): Promise<string> {
    const out: number[] = [];
    for (const kind of KINDS) out.push(await (await this.table(meta, gen, kind)).version());
    return out.join(",");
  }

  /** Ask the indexer to scrub on its next pass (`seshi search --scrub`). */
  async requestScrub(): Promise<void> {
    await this.setMeta({ scrub_requested: new Date(this.now()).toISOString() });
  }

  /** Rewrite every table that holds deleted rows, in the live generation and one being built,
   * so deleted text leaves the storage (F10.12): copy the live rows into a new table, index
   * it, switch `meta` to it, and drop the old one after the grace. */
  async scrub(signal: AbortSignal): Promise<void> {
    let meta = await this.meta(true);
    const gens = [this.live(meta), this.building(meta)].filter((g): g is string => g !== undefined);
    for (const gen of gens) {
      for (const kind of KINDS) {
        if (signal.aborted) return;
        meta = await this.meta(true);
        const old = await this.table(meta, gen, kind);
        if ((await old.stats()).numDeletedRows === 0) continue;
        const name = `${kind}_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
        const copy = await this.createTable(gen, kind, name);
        let batch: RecordBatch[] = [];
        let rows = 0;
        const flush = async () => {
          if (batch.length === 0) return;
          await copy.add(joined(SCHEMAS[kind], batch));
          batch = [];
          rows = 0;
        };
        for await (const records of old
          .query()
          .select(SCHEMAS[kind].fields.map((f) => String(f.name)))) {
          batch.push(records);
          rows += records.numRows;
          if (rows >= COPY_BATCH) await flush();
        }
        await flush();
        if (meta.get(gk(gen, "indexed")) !== undefined) await this.textIndexes(copy, kind);
        await this.trash([{ gen, table: this.tableName(meta, gen, kind), at: this.now() }], {
          [gk(gen, `table.${kind}`)]: name,
        });
      }
    }
    await this.setMeta({ scrubbed_at: new Date(this.now()).toISOString() });
    await (this.metaTable as Table).delete("key IN ('scrub_due', 'scrub_requested')");
    this.cached = undefined;
  }

  private async emptyTrash(meta: Meta, before: number): Promise<void> {
    const held = JSON.parse(meta.get("trash") ?? "[]") as Trash[];
    const keep: Trash[] = [];
    let changed = false;
    for (const item of held) {
      if (item.at > before) {
        keep.push(item);
        continue;
      }
      const db = await this.generationDb(item.gen);
      if (item.table !== undefined) {
        await db.dropTable(item.table).catch(() => undefined);
        this.forget(item.gen, item.table);
      } else {
        await db.dropAllTables().catch(() => undefined);
        for (const key of [...this.tables.keys()]) {
          if (key.startsWith(`${item.gen}/`)) this.forget(item.gen, key.slice(item.gen.length + 1));
        }
        const prefix = `${item.gen}.`;
        const stale = [...meta.keys()].filter((k) => k.startsWith(prefix));
        if (stale.length > 0) {
          await (this.metaTable as Table).delete(`key IN (${sqlList(stale)})`);
          this.cached = undefined;
        }
      }
      changed = true;
    }
    if (changed) await this.setMeta({ trash: JSON.stringify(keep) });
  }

  private forget(gen: string, name: string): void {
    const key = `${gen}/${name}`;
    const table = this.tables.get(key);
    this.tables.delete(key);
    table?.then((t) => t.close()).catch(() => undefined);
  }
}

/** The last row for each key: a page may write one session twice (an update, then a
 * removal), and `mergeInsert` refuses a key twice in its input. */
function latest<T>(rows: T[], key: (row: T) => string): T[] {
  const out = new Map<string, T>();
  for (const row of rows) {
    out.delete(key(row));
    out.set(key(row), row);
  }
  return [...out.values()];
}

function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (!seen.has(key(row))) seen.set(key(row), row);
  return [...seen.values()];
}

/** Batches read back as one table under the table's schema: as read, their schemas differ in
 * details (a list's item field) that Arrow refuses to join. */
function joined(schema: Schema, batches: RecordBatch[]): ArrowTable {
  return new ArrowTable(batches.map((b) => new RecordBatch(schema, b.data)));
}
