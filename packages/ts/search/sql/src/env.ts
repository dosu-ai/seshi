/** The `sql` worker's environment variables (`sqlWorkerEnv` in `@seshi/instance` sets them, the
 * names kept the same there): the index's storage options, which are the read-only credential
 * (`[search.sql.storage]`), and where DuckDB's extensions are, when not beside the binary
 * (`[search.sql] extensions`). Only a worker's environment holds them. */
export const SQL_STORAGE_ENV = "SESHI_SQL_STORAGE";
export const DUCKDB_EXTENSIONS_ENV = "SESHI_DUCKDB_EXTENSIONS";
