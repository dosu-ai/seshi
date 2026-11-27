import { fileURLToPath } from "node:url";
import type { SqlEngine } from "@seshi/search";
import type { DuckdbEngine } from "./engine";
import { preloadLibduckdb } from "./env";

let engine: Promise<DuckdbEngine> | undefined;

/** DuckDB is loaded only when a worker first warms a database: the API process of a `-sql`
 * build, which provides the engine too, never loads DuckDB's native library. */
function load(): Promise<DuckdbEngine> {
  engine ??= preloadLibduckdb()
    .then(() => import("./engine"))
    .then((m) => new m.DuckdbEngine());
  return engine;
}

/** The engine the `-sql` build provides (`provideSql(duckdbSql)`), for `sql` on a LanceDB index. */
export const duckdbSql: SqlEngine = {
  script: fileURLToPath(new URL("./worker-main.ts", import.meta.url)),
  warm: async () => (await load()).warm(),
  run: async (request) => (await load()).run(request),
};
