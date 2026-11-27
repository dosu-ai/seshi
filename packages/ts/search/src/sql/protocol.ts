/** The `sql` worker's protocol (docs/seshi/session-tools.md, "The worker"): one JSON object a
 * line on the worker's stdin and stdout, one request and one response at a time. */

export interface SqlLimits {
  /** SQLite: the watchdog kills the worker past this (SQLite has no interrupt). DuckDB: the
   * worker interrupts the query at this time, and the watchdog kills it 5 s later. */
  timeout_ms: number;
  max_rows: number;
  /** Bytes of JSON the rows may take. */
  max_bytes: number;
  /** SQLite's `hard_heap_limit`, in bytes: held where the SQLite build keeps memory statistics
   * (Bun's own SQLite on Linux), ignored where it does not (macOS's system SQLite). DuckDB's
   * `memory_limit`, with nothing spilled to disk. */
  memory_bytes?: number;
  /** DuckDB's `threads` (2). SQLite runs a query on one. */
  threads?: number;
}

/** A statement over a SQLite index: the file, opened read-only. */
/** Set to `duckdb` in the environment of a pool that serves a LanceDB index: its workers warm
 * DuckDB before they say they are ready. Workers of a SQLite index never load it. */
export const SQL_ENGINE_ENV = "SESHI_SQL_ENGINE";

export interface SqliteRequest {
  id: string;
  engine: "sqlite";
  setup: {
    /** The SQLite index file, opened read-only. */
    file: string;
    /** `CREATE TEMP VIEW` statements, the caller's scope written in. */
    views: string[];
  };
  sql: string;
  limits: SqlLimits;
}

/** The Lance tables the DuckDB views read: the live generation's, from the index's `meta`,
 * never from a request. */
export interface SqlTables {
  sessions: string;
  events: string;
  llm_calls: string;
}

/** A statement over a LanceDB index, run by DuckDB through its `lance` extension. The worker
 * reads the bucket with the credential in its own environment, never one a request carries. */
export interface DuckdbRequest {
  id: string;
  engine: "duckdb";
  setup: {
    tables: SqlTables;
    /** `CREATE VIEW` statements over `tables`, the caller's scope written in. */
    views: string[];
  };
  sql: string;
  limits: SqlLimits;
}

export type SqlWorkerRequest = SqliteRequest | DuckdbRequest;

export interface SqlColumnInfo {
  name: string;
  type: string;
}

/** `refused`: the statement check. `bind`: the engine could not compile it (an unknown column,
 * a syntax it does not take). `timeout`, `memory`: a limit stopped it. `runtime`: it failed while
 * running. `unavailable`: this worker cannot run the engine (a binary without DuckDB, or its
 * `lance` extension missing). `internal`: the worker failed. */
export type SqlErrorKind =
  | "refused"
  | "bind"
  | "timeout"
  | "memory"
  | "runtime"
  | "unavailable"
  | "internal";

export interface SqlWorkerError {
  kind: SqlErrorKind;
  message: string;
  /** For `refused`: where, as a 0-based offset into the statement. */
  at?: number;
}

export type SqlWorkerResponse =
  | {
      id: string;
      ok: true;
      columns: SqlColumnInfo[];
      rows: unknown[][];
      truncated: boolean;
      elapsed_ms: number;
    }
  | { id: string; ok: false; error: SqlWorkerError };

/** The first line a worker writes, once it is ready for requests. */
export interface SqlWorkerReady {
  ready: true;
  pid: number;
}

/** A request before the pool gives it an id. */
export type SqlJob = SqliteJob | DuckdbJob;
export type SqliteJob = Omit<SqliteRequest, "id">;
export type DuckdbJob = Omit<DuckdbRequest, "id">;
