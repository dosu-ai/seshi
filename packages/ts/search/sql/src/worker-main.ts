import { provideSql, runSqlWorker } from "@seshi/search";
import { duckdbSql } from "./sql";

/** A worker with DuckDB, run directly by Bun, for tests and a server run from source with
 * DuckDB (`scriptWorkerCommand`); a compiled `-sql` binary runs `seshi sql-worker`, which its
 * entry point gave DuckDB the same way. */
provideSql(duckdbSql);
await runSqlWorker();
process.exit(0);
