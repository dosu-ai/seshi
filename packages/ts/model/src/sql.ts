/** `sql` (docs/seshi/session-tools.md): one read-only statement over the views `sessions`,
 * `events` and `llm_calls`, in the dialect of the index's engine. */

/** SQLite on a SQLite index, DuckDB on a LanceDB one (T8). */
export type SqlDialect = "sqlite" | "duckdb";

/** `POST /v1/sql`. */
export interface SqlRequest {
  /** One SELECT, at most 16 KiB. */
  sql: string;
  /** Sessions overlapping this window: an RFC 3339 time or an age (`30d`, `12h`). The last 30
   * days by default, at most 400. */
  since?: string | null;
  until?: string | null;
  /** Rows to return at most: 1 to 1,000, the server's `max_rows` by default. */
  max_rows?: number;
}

/** Who a `sql` answer was answered as, and over which window. */
export interface SqlScope {
  as: string;
  /** `admin`, `service` or `member`; `local` on a serverless laptop's own index. */
  role: string;
  since: string;
  until: string;
}

export interface SqlIndexInfo {
  backend: "sqlite" | "lance";
  dialect: SqlDialect;
  generation?: string;
  /** When the index last caught up with the change feed. */
  updated_at?: string;
}

export interface SqlColumn {
  name: string;
  type: string;
}

/** `POST /v1/sql`'s answer. */
export interface SqlResult {
  /** When it was answered (UTC). */
  now: string;
  scope: SqlScope;
  index: SqlIndexInfo;
  columns: SqlColumn[];
  rows: unknown[][];
  /** It stopped at `max_rows` or 1 MB of rows: add LIMIT or aggregate. */
  truncated: boolean;
  elapsed_ms: number;
}

/** `GET /v1/sql/schema`: what a statement may read, in this server's dialect. */
export interface SqlSchema {
  dialect: SqlDialect;
  /** How to write the dialect, in one line. */
  hint: string;
  /** The three views' `CREATE VIEW`, with each column's type and comment. */
  ddl: string;
  examples: string[];
  scope: SqlScope;
  index: SqlIndexInfo;
  limits: { max_rows: number; max_bytes: number; timeout_ms: number; max_sql_bytes: number };
}
