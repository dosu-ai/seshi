// Whether a caller's predicate runs before the view's scope filter, so that an error quotes
// text from a session the caller may not see. DuckDB has no security_barrier views.
//
// gen.ts makes a0, a4, a8… owner-only; a5 is bob's. The views below are alice's (a member):
// org sessions and her own. Each probe asks only about a5, which alice may not see, with a
// predicate that fails on any row it reaches. A leak is an error message that quotes a5's text.
//
// Usage: bun leak.ts <extension dir> <root from gen.ts>
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const [extDir, root] = process.argv.slice(2);
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const db = await DuckDBInstance.create(":memory:", {
  extension_directory: extDir,
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
});
const c = await db.connect();
await c.run("LOAD lance; LOAD sqlite;");
await c.run(`ATTACH ${lit(join(root, "index/sqlite/search.db"))} AS idx (TYPE sqlite, READ_ONLY)`);
await c.run(`CREATE VIEW lance_events AS SELECT owner, archive_id, role, text
  FROM ${lit(join(root, "index/lance/events.lance"))} WHERE visibility = 'org' OR owner IN ('alice')`);
await c.run(`CREATE VIEW sqlite_events AS SELECT s.owner, s.archive_id, e.role, t.c0::VARCHAR AS text
  FROM idx.events e JOIN idx.sessions s ON s.id = e.session JOIN idx.events_text_content t ON t.id = e.id
  WHERE s.visibility = 'org' OR s.owner IN ('alice')`);
await c.run("SET enable_external_access = false; SET lock_configuration = true;");

for (const view of ["lance_events", "sqlite_events"]) {
  for (const predicate of [
    "CAST(text AS INTEGER) = 1",
    "archive_id = 'a5' AND CAST(text AS INTEGER) = 1",
    "CAST(text AS INTEGER) = 1 AND archive_id = 'a5'",
    "archive_id = 'a5' AND error(text) IS NULL",
    "archive_id = 'a5' AND json_extract(text, '$.x') IS NULL",
    // Fails only on a row of a5, so an error means the predicate reached a row out of scope.
    "CASE WHEN archive_id = 'a5' THEN CAST(text AS INTEGER) END = 1",
    "CASE WHEN archive_id = 'a5' THEN error(text::VARCHAR) END IS NULL",
    "(CASE WHEN owner = 'bob' AND archive_id = 'a5' THEN CAST(text::VARCHAR AS INTEGER) ELSE 0 END) = 0",
  ]) {
    let result: string;
    try {
      const r = await c.runAndReadAll(`SELECT count(*) AS n FROM ${view} WHERE ${predicate}`);
      result = `no error, ${JSON.stringify(r.getRowObjectsJson())}`;
    } catch (e) {
      const message = String(e).split("\n")[0];
      result = `${/a5 /.test(message) ? "LEAK" : "error, nothing out of scope"}: ${message.slice(0, 120)}`;
    }
    console.log(`| ${view} | \`${predicate}\` | ${result.replaceAll("|", "\\|")} |`);
  }
}
