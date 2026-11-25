// Whether DuckDB's lock-down settings bind its lance and sqlite extensions.
//
// Each run sets up a database the way the sql endpoint would (extensions loaded from a local
// folder, the views created with a member's scope as literals), then locks it down and runs
// statements an agent might send. It runs twice: with `allowed_directories` naming the index's
// folder, and naming an unrelated folder. If a view still reads in the second run, the
// extension does not consult the setting.
//
// Usage: bun probe.ts <extension dir> <root from gen.ts>
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const extDir = process.argv[2];
const root = process.argv[3];
const index = join(root, "index");
const outside = join(root, "outside");
const elsewhere = join(root, "elsewhere");
mkdirSync(elsewhere, { recursive: true });
// A copy for the destructive probes, so the views' tables stay as gen.ts wrote them.
cpSync(join(index, "lance/events.lance"), join(index, "lance/scratch.lance"), { recursive: true });
copyFileSync(join(index, "sqlite/search.db"), join(index, "sqlite/scratch.db"));

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const lance = (t: string) => lit(join(index, "lance", `${t}.lance`));
const scope = "(visibility = 'org' OR owner IN ('alice'))";

async function open(allowed: string) {
  const db = await DuckDBInstance.create(":memory:", {
    extension_directory: extDir,
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    allow_community_extensions: "false",
    memory_limit: "256MB",
    threads: "2",
  });
  const c = await db.connect();
  await c.run("LOAD lance; LOAD sqlite;");
  await c.run(`ATTACH ${lit(join(index, "sqlite/search.db"))} AS idx (TYPE sqlite, READ_ONLY)`);
  await c.run(`CREATE VIEW lance_events AS SELECT owner, archive_id, event_index, role, text
    FROM ${lance("events")} WHERE ${scope}`);
  await c.run(`CREATE VIEW sqlite_events AS SELECT s.owner, s.archive_id, e.event_index, e.role, t.c0 AS text
    FROM idx.events e JOIN idx.sessions s ON s.id = e.session
    LEFT JOIN idx.events_text_content t ON t.id = e.id
    WHERE s.removed = 0 AND (s.visibility = 'org' OR s.owner IN ('alice'))`);
  await c.run(`SET allowed_directories = [${lit(`${allowed}/`)}]`);
  await c.run("SET enable_external_access = false");
  await c.run("SET lock_configuration = true");
  return c;
}

type Conn = Awaited<ReturnType<typeof open>>;
async function run(c: Conn, sql: string): Promise<string> {
  try {
    const r = await c.runAndReadAll(sql);
    const rows = r.getRowObjectsJson();
    return `ok: ${JSON.stringify(rows).slice(0, 140)}`;
  } catch (e) {
    return `refused: ${String(e).split("\n")[0].slice(0, 140)}`;
  }
}

const probes: [string, string][] = [
  ["lance view", "SELECT count(*) n, count(DISTINCT owner) owners FROM lance_events"],
  ["sqlite view", "SELECT count(*) n, count(text) texts FROM sqlite_events"],
  ["sqlite FTS5 table itself", "SELECT count(*) FROM idx.events_text"],
  ["raw lance table, inside", `SELECT count(*) n FROM ${lance("events")} WHERE visibility = 'owner'`],
  ["raw lance, __lance_scan", `SELECT count(*) FROM __lance_scan(${lance("events")})`],
  ["raw sqlite table via attach name", "SELECT count(*) FROM idx.sessions WHERE visibility = 'owner'"],
  ["outside csv, replacement scan", `SELECT * FROM ${lit(join(outside, "secret.csv"))}`],
  ["outside csv, read_csv", `SELECT * FROM read_csv(${lit(join(outside, "secret.csv"))})`],
  ["outside lance, replacement scan", `SELECT * FROM ${lit(join(outside, "secret.lance"))}`],
  ["outside lance, __lance_scan", `SELECT * FROM __lance_scan(${lit(join(outside, "secret.lance"))})`],
  ["outside lance, lance_fts", `SELECT * FROM lance_fts(${lit(join(outside, "secret.lance"))}, 'secret', 'x')`],
  ["outside sqlite, sqlite_scan", `SELECT * FROM sqlite_scan(${lit(join(outside, "secret.db"))}, 'secret')`],
  ["outside sqlite, ATTACH", `ATTACH ${lit(join(outside, "secret.db"))} AS s2 (TYPE sqlite)`],
  ["outside, glob", `SELECT * FROM glob(${lit(`${root}/**`)}) LIMIT 3`],
  ["http, read_csv", "SELECT * FROM read_csv('https://example.com/x.csv')"],
  ["write inside, COPY TO", `COPY (SELECT 1 AS x) TO ${lit(join(index, "copied.csv"))}`],
  ["write sqlite, INSERT", "INSERT INTO idx.sessions (id, owner, archive_id, visibility) VALUES (99999, 'x', 'y', 'org')"],
  ["lance write, __lance_exec", `SELECT * FROM __lance_exec(${lance("scratch")}, 'DELETE FROM t')`],
  ["lance delete, __lance_cleanup_old_versions", `SELECT * FROM __lance_cleanup_old_versions(${lance("scratch")})`],
  ["lance compact, __lance_compact_files", `SELECT * FROM __lance_compact_files(${lance("scratch")})`],
  ["SET enable_external_access", "SET enable_external_access = true"],
  ["SET allowed_directories", "SET allowed_directories = ['/']"],
  ["RESET lock_configuration", "RESET lock_configuration"],
  ["SET memory_limit", "SET memory_limit = '8GB'"],
  ["LOAD httpfs", "LOAD httpfs"],
  ["INSTALL httpfs", "INSTALL httpfs"],
  ["getenv", "SELECT getenv('HOME')"],
  ["current_setting", "SELECT current_setting('allowed_directories')"],
  ["duckdb_settings()", "SELECT count(*) FROM duckdb_settings()"],
  ["CREATE TABLE in memory", "CREATE TABLE t AS SELECT 1 AS x"],
  ["CREATE OR REPLACE VIEW", "CREATE OR REPLACE VIEW lance_events AS SELECT 1 AS x"],
  ["DETACH idx", "DETACH idx"],
];

const rows: string[] = [];
for (const [label, allowed] of [
  ["index folder", index],
  ["unrelated folder", elsewhere],
] as const) {
  const c = await open(allowed);
  rows.push(`\n## allowed_directories = ${label}\n`, "| Probe | Result |", "|---|---|");
  for (const [name, sql] of probes) rows.push(`| ${name} | ${(await run(c, sql)).replaceAll("|", "\\|")} |`);
  c.closeSync();
}
console.log(rows.join("\n"));
