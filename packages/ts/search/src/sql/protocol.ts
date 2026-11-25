/** The `sql` worker's protocol (docs/seshi/session-tools.md, "The worker"): one JSON object a
 * line on the worker's stdin and stdout, one request and one response at a time. */

export interface SqlLimits {
  /** The watchdog kills the worker past this; SQLite has no interrupt. */
  timeout_ms: number;
  max_rows: number;
  /** Bytes of JSON the rows may take. */
  max_bytes: number;
  /** SQLite's `hard_heap_limit`, in bytes: held where the SQLite build keeps memory statistics
   * (Bun's own SQLite on Linux), ignored where it does not (macOS's system SQLite). */
  memory_bytes?: number;
}

export interface SqlWorkerRequest {
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

export interface SqlColumnInfo {
  name: string;
  type: string;
}

/** `refused`: the statement check. `bind`: SQLite could not compile it (an unknown column, a
 * syntax it does not take). `timeout`, `memory`: a limit stopped it. `runtime`: it failed while
 * running. `internal`: the worker failed. */
export type SqlErrorKind = "refused" | "bind" | "timeout" | "memory" | "runtime" | "internal";

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
