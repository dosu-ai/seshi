// sql on a LanceDB index (docs/seshi/session-tools.md, phase 4): DuckDB and its `lance`
// extension, inside `seshi sql-worker`. This package is the only one that depends on DuckDB:
// only the `-sql` server build's entry point (apps/seshi/src/main-server-sql.ts) imports it,
// because `bun build --compile` bundles every module an import names, DuckDB's native library
// included, and no other build may carry it. DuckDB itself is imported only in a worker, when
// it warms its first database.
export { provideSql } from "@seshi/search/backends";
export { DUCKDB_EXTENSIONS_ENV, SQL_STORAGE_ENV } from "./env";
export { DUCKDB_EXPRESSIONS, DUCKDB_FUNCTIONS } from "./functions";
export { duckdbSql } from "./sql";
