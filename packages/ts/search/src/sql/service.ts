import { OwnerAliases, type Principal, seesEverything } from "@seshi/auth";
import type {
  SqlIndexInfo,
  SqlRequest,
  SqlResult,
  SqlSchema,
  SqlScope,
  Visibility,
} from "@seshi/model";
import { sqlBackend } from "../backends";
import { MEMORY_INDEX } from "../paths";
import { type SearchService, SearchUnavailable } from "../service";
import type { Viewer } from "../viewer";
import { MAX_SQL_BYTES } from "./check-sqlite";
import { SqlPool, type SqlPoolStatus, scriptWorkerCommand } from "./pool";
import type { SqlErrorKind, SqlJob, SqlTables, SqlWorkerResponse } from "./protocol";
import { SQL_DIALECT_HINT, SQL_EXAMPLES, type SqlWindow, sqlSchema, sqlViews } from "./views";

const DAY_MS = 86_400_000;
/** The window when none is given: the last 30 days. */
export const SQL_DEFAULT_WINDOW_MS = 30 * DAY_MS;
/** The longest window a query may read. */
export const SQL_MAX_WINDOW_MS = 400 * DAY_MS;
/** The most rows an answer holds, whatever `max_rows` asks. */
export const SQL_MAX_ROWS = 1_000;
/** The most bytes of JSON the rows of an answer take. */
export const SQL_MAX_BYTES = 1024 * 1024;

export interface SqlSettings {
  /** Worker processes (2 on a server, 1 on a laptop). */
  workers: number;
  /** A query's time, in ms (15 s): the watchdog kills the worker past it. */
  timeout: number;
  /** SQLite's `hard_heap_limit` in bytes (1 GiB), where the SQLite build holds it; DuckDB's
   * `memory_limit`, with nothing spilled to disk. */
  memory: number;
  /** DuckDB's threads per worker (2). */
  threads: number;
  /** The watchdog kills a worker whose resident memory passes this (2 GiB). */
  workerMemory: number;
  /** Rows per answer, at most `SQL_MAX_ROWS` (1,000). */
  maxRows: number;
}

export const DEFAULT_SQL_SETTINGS: SqlSettings = {
  workers: 2,
  timeout: 15_000,
  memory: 1024 ** 3,
  workerMemory: 2 * 1024 ** 3,
  maxRows: SQL_MAX_ROWS,
  threads: 2,
};

/** How long past its timeout the watchdog waits for a DuckDB query, which the worker
 * interrupts itself at the timeout. SQLite has no interrupt: its worker is killed at once. */
export const SQL_DUCKDB_GRACE_MS = 5_000;

/** Who asks, as the views and the answer's header need it. */
export interface SqlCaller {
  viewer: Viewer;
  /** Who the answer says it was answered as. */
  as: string;
  /** `admin`, `service`, `member`, or `local` on a serverless laptop. */
  role: string;
  /** Whose queries count against the per-principal limit. */
  key: string;
}

/** A request `sql` cannot run as given (`400 bad_field`, or `bad_query` for the schema's query
 * string): a window or a field it cannot read. */
export class SqlRequestError extends Error {
  readonly code = "bad_field";
  constructor(message: string) {
    super(message);
    this.name = "SqlRequestError";
  }
}

/** This index cannot answer `sql` (`501 sql_unavailable`). */
export class SqlUnavailable extends Error {
  readonly code = "sql_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SqlUnavailable";
  }
}

const CODES: Record<SqlErrorKind, string> = {
  refused: "sql_refused",
  bind: "sql_error",
  timeout: "sql_timeout",
  memory: "sql_memory",
  runtime: "sql_runtime",
  unavailable: "sql_unavailable",
  internal: "internal",
};

/** A statement `sql` ran and that failed, or that the statement check refused: `code` is the
 * API's (`sql_refused`, `sql_error`, `sql_timeout`, `sql_memory`, `sql_runtime`, or `internal`
 * when the worker failed), `at` where a refusal points. */
export class SqlFailed extends Error {
  readonly code: string;
  constructor(
    readonly kind: SqlErrorKind,
    message: string,
    readonly at?: number,
  ) {
    super(message);
    this.name = "SqlFailed";
    this.code = CODES[kind];
  }
}

/** What a caller with the `sql` scope sees: every session for admins and services (the views
 * then carry only the window), else its own and the org's, as search. */
export function sqlViewerFor(principal: Principal, aliases = new OwnerAliases()): Viewer {
  const everything = seesEverything(principal);
  const own = aliases.storedAs(principal.owner);
  return {
    everything,
    own,
    canRead: (session: { owner: string; visibility?: Visibility }) =>
      everything || (session.visibility ?? "org") === "org" || own.includes(session.owner),
  };
}

/** The caller of a server request. */
export function sqlCallerFor(principal: Principal, aliases = new OwnerAliases()): SqlCaller {
  return {
    viewer: sqlViewerFor(principal, aliases),
    as: principal.owner,
    role: principal.role,
    key: principal.owner,
  };
}

const AGE = /^(\d+)(ms|s|m|h|d|w)$/;
const AGE_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: DAY_MS,
  w: 7 * DAY_MS,
};

function instant(value: unknown, name: string, now: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new SqlRequestError(`${name} must be a string`);
  const age = AGE.exec(value.trim());
  if (age) return now - Number(age[1]) * (AGE_UNITS[age[2] as string] as number);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new SqlRequestError(`${name} must be an RFC 3339 time or an age (30d, 12h)`);
  }
  return ms;
}

/** The window a request asks for: the last 30 days by default, never more than 400. */
export function sqlWindow(request: Pick<SqlRequest, "since" | "until">, now: number): SqlWindow {
  const until = instant(request.until, "until", now) ?? now;
  const since = instant(request.since, "since", now) ?? until - SQL_DEFAULT_WINDOW_MS;
  if (since >= until) throw new SqlRequestError("since must be before until");
  if (until - since > SQL_MAX_WINDOW_MS) {
    throw new SqlRequestError("the window is longer than 400 days: narrow since or until");
  }
  return { since, until };
}

function maxRowsOf(value: unknown, cap: number): number {
  if (value === undefined || value === null) return cap;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new SqlRequestError("max_rows must be a whole number of at least 1");
  }
  return Math.min(value, cap);
}

export interface SqlServiceOptions {
  /** The search index the views read; `sqlTables` for a LanceDB index. */
  search: Pick<SearchService, "status"> & Partial<Pick<SearchService, "sqlTables">>;
  settings?: Partial<SqlSettings>;
  /** How to start a worker: `[seshi, "sql-worker"]` from a binary (`scriptWorkerCommand()`
   * when omitted, for tests and `bun run`). */
  command?: readonly string[];
  /** What the workers' environment holds besides `PATH`, `HOME` and `TMPDIR`: on LanceDB, the
   * read-only storage credential (`[search.sql.storage]`) and where DuckDB's extensions are.
   * Never the server's own settings or tokens. */
  workerEnv?: Readonly<Record<string, string>>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What a query runs against: a SQLite index's file, or a LanceDB index's tables. */
type Target =
  | { engine: "sqlite"; file: string; index: SqlIndexInfo }
  | { engine: "duckdb"; tables: SqlTables; index: SqlIndexInfo };

/** `sql` (docs/seshi/session-tools.md): a statement run by a worker process over the search
 * index, in views built from the caller. On a SQLite index SQLite runs it over the index file;
 * on a LanceDB index DuckDB runs it over the live generation's Lance tables, in a build that
 * carries DuckDB (`provideSql`), and a build without it answers `SqlUnavailable`. The workers
 * start with the first query. */
export class SqlService {
  private readonly options: SqlServiceOptions;
  readonly settings: SqlSettings;
  private workers: SqlPool | undefined;
  private closed = false;

  constructor(options: SqlServiceOptions) {
    this.options = options;
    const settings = { ...DEFAULT_SQL_SETTINGS, ...options.settings };
    this.settings = { ...settings, maxRows: Math.min(settings.maxRows, SQL_MAX_ROWS) };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private pool(engine: Target["engine"]): SqlPool {
    if (this.closed) throw new SqlUnavailable("sql is shut down");
    this.workers ??= new SqlPool({
      command: this.options.command ?? scriptWorkerCommand(),
      workers: this.settings.workers,
      workerMemory: this.settings.workerMemory,
      graceMs: engine === "duckdb" ? SQL_DUCKDB_GRACE_MS : 0,
      ...(this.options.workerEnv ? { env: this.options.workerEnv } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    });
    return this.workers;
  }

  /** The index a query reads and what the answer says of it; refuses an index `sql` cannot
   * read. */
  private async target(): Promise<Target> {
    const status = await this.options.search.status();
    if (status.backend === "lance") {
      if (sqlBackend() === undefined) {
        throw new SqlUnavailable(
          "sql on a LanceDB index needs DuckDB, which only the seshi-server-sql build carries (the -sql image, ghcr.io/dosu-ai/seshi:<version>-sql, or the seshi-server-sql-linux-* archives); this build answers search but not sql",
        );
      }
      if (!status.ready) {
        throw new SearchUnavailable(
          "the search index is being built from the change feed; try again shortly",
        );
      }
      const tables = await this.options.search.sqlTables?.();
      if (tables === undefined) {
        throw new SearchUnavailable(
          "the search index has no live generation yet; try again shortly",
        );
      }
      return {
        engine: "duckdb",
        tables,
        index: {
          backend: "lance",
          dialect: "duckdb",
          ...(status.generation !== undefined ? { generation: status.generation } : {}),
          ...(status.caught_up_at !== undefined ? { updated_at: status.caught_up_at } : {}),
        },
      };
    }
    if (status.location === MEMORY_INDEX) {
      throw new SqlUnavailable(
        'the search index is in memory ([search] path = ":memory:"): sql reads an index file',
      );
    }
    if (!status.ready) {
      throw new SearchUnavailable(
        "the search index is being built from the change feed; try again shortly",
      );
    }
    return {
      engine: "sqlite",
      file: status.location,
      index: {
        backend: "sqlite",
        dialect: "sqlite",
        ...(status.caught_up_at !== undefined ? { updated_at: status.caught_up_at } : {}),
      },
    };
  }

  private scope(caller: SqlCaller, window: SqlWindow): SqlScope {
    return {
      as: caller.as,
      role: caller.role,
      since: new Date(window.since).toISOString(),
      until: new Date(window.until).toISOString(),
    };
  }

  /** Run `asked` as `caller`. Throws `SqlRequestError`, `SqlUnavailable`,
   * `SearchUnavailable` (the index is building), `SqlBusy` and `SqlFailed`. */
  async query(caller: SqlCaller, asked: SqlRequest): Promise<SqlResult> {
    if (typeof asked?.sql !== "string" || asked.sql.trim() === "") {
      throw new SqlRequestError("sql is required: one SELECT over sessions, events and llm_calls");
    }
    const now = this.now();
    const window = sqlWindow(asked, now.getTime());
    const maxRows = maxRowsOf(asked.max_rows, this.settings.maxRows);
    const target = await this.target();
    const limits = {
      timeout_ms: this.settings.timeout,
      max_rows: maxRows,
      max_bytes: SQL_MAX_BYTES,
      memory_bytes: this.settings.memory,
    };
    const request: SqlJob =
      target.engine === "sqlite"
        ? {
            engine: "sqlite",
            setup: { file: target.file, views: sqlViews("sqlite", caller.viewer, window) },
            sql: asked.sql,
            limits,
          }
        : {
            engine: "duckdb",
            setup: {
              tables: target.tables,
              views: sqlViews("duckdb", caller.viewer, window, target.tables),
            },
            sql: asked.sql,
            limits: { ...limits, threads: this.settings.threads },
          };
    const { index } = target;
    const response: SqlWorkerResponse = await this.pool(target.engine).run(caller.key, request);
    if (!response.ok) {
      const { kind, message, at } = response.error;
      if (kind === "unavailable") throw new SqlUnavailable(message);
      // A runtime error's message can quote a value; only callers who see everything get it.
      const shown =
        kind === "runtime" && !caller.viewer.everything
          ? "the statement failed while running"
          : message;
      throw new SqlFailed(kind, shown, at);
    }
    return {
      now: now.toISOString(),
      scope: this.scope(caller, window),
      index,
      columns: response.columns,
      rows: response.rows,
      truncated: response.truncated,
      elapsed_ms: response.elapsed_ms,
    };
  }

  /** The schema a statement may read, in this index's dialect, for `caller`. */
  async schema(
    caller: SqlCaller,
    request: Pick<SqlRequest, "since" | "until"> = {},
  ): Promise<SqlSchema> {
    const window = sqlWindow(request, this.now().getTime());
    const { index } = await this.target();
    const { dialect } = index;
    return {
      dialect,
      hint: SQL_DIALECT_HINT[dialect],
      ddl: sqlSchema(dialect),
      examples: [...SQL_EXAMPLES[dialect]],
      scope: this.scope(caller, window),
      index,
      limits: {
        max_rows: this.settings.maxRows,
        max_bytes: SQL_MAX_BYTES,
        timeout_ms: this.settings.timeout,
        max_sql_bytes: MAX_SQL_BYTES,
      },
    };
  }

  /** The workers, once the first query started them. */
  status(): SqlPoolStatus | undefined {
    return this.workers?.status();
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = this.workers;
    this.workers = undefined;
    await workers?.close();
  }
}
