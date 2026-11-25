// Native SQLite (bun:sqlite) for `sql` on a SQLite index: what a read-only connection allows,
// whether TEMP views shadow the index's tables, the heap limit, and stopping a runaway query.
//
// Usage: bun native.ts <root from gen.ts>
import { Database } from "bun:sqlite";
import { join } from "node:path";

const root = process.argv[2];
const index = join(root, "index/sqlite/search.db");
const local = (s: string) => s.replaceAll(root, "<root>");
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

function attempt(db: Database, label: string, sql: string) {
  try {
    const rows = db.query(sql).all();
    console.log(`| ${label} | ok: ${local(JSON.stringify(rows)).slice(0, 120)} |`);
  } catch (e) {
    console.log(`| ${label} | refused: ${local(String(e).split("\n")[0]).slice(0, 120)} |`);
  }
}

const db = new Database(index, { readonly: true });
console.log("sqlite", (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v);
// The views as the endpoint would make them: alice, a member, sees org sessions and her own.
db.run(`CREATE TEMP VIEW sessions AS SELECT owner, archive_id, visibility FROM main.sessions
  WHERE removed = 0 AND (visibility = 'org' OR owner IN ('alice'))`);
db.run(`CREATE TEMP VIEW events AS SELECT s.owner, s.archive_id, e.event_index, e.role, t.text
  FROM main.events e JOIN main.sessions s ON s.id = e.session JOIN main.events_text t ON t.rowid = e.id
  WHERE s.removed = 0 AND (s.visibility = 'org' OR s.owner IN ('alice'))`);

console.log("\n| Probe | Result |\n|---|---|");
attempt(db, "unqualified events (the TEMP view?)", "SELECT count(*) n, count(DISTINCT owner) owners FROM events");
attempt(db, "main.events, bypassing the view", "SELECT count(*) n FROM main.events");
attempt(db, "main.sessions owner-only rows", "SELECT count(*) n FROM main.sessions WHERE visibility = 'owner'");
attempt(db, "text through the view", "SELECT text FROM events LIMIT 1");
attempt(db, "json_each (table-valued)", `SELECT count(*) n FROM json_each('["a","b"]')`);
attempt(db, "ATTACH a file outside", `ATTACH ${lit(join(root, "outside/secret.db"))} AS s2`);
attempt(db, "read the attached file", "SELECT * FROM s2.secret");
attempt(db, "ATTACH ':memory:'", "ATTACH ':memory:' AS m");
attempt(db, "load_extension()", "SELECT load_extension('/nonexistent')");
attempt(db, "readfile()", "SELECT readfile('/etc/hosts')");
attempt(db, "fts3_tokenizer()", "SELECT fts3_tokenizer('simple')");
attempt(db, "INSERT into main", "INSERT INTO main.sessions (owner, archive_id, format, session_id, visibility, updated_at, updated_ms, traces) VALUES ('x','y','f','s','org','t',0,'[]')");
attempt(db, "CREATE TEMP TABLE before query_only", "CREATE TEMP TABLE t AS SELECT 1 AS x");
db.run("PRAGMA query_only = 1");
attempt(db, "CREATE TEMP TABLE after query_only", "CREATE TEMP TABLE t2 AS SELECT 1 AS x");
attempt(db, "DROP VIEW events after query_only", "DROP VIEW events");
attempt(db, "CREATE TEMP VIEW after query_only", "CREATE TEMP VIEW v AS SELECT 1");
attempt(db, "PRAGMA query_only = 0 (caller undoes it)", "PRAGMA query_only = 0");
attempt(db, "ATTACH after query_only", `ATTACH ${lit(join(root, "outside/secret.db"))} AS s3`);
db.run("PRAGMA query_only = 1");

// Two statements in one prepare.
try {
  const s = db.prepare("SELECT 1 AS a; DROP VIEW events");
  console.log(`| prepare two statements | prepared; runs: ${JSON.stringify(s.all())}; events view still there: ${db.query("SELECT count(*) n FROM sqlite_temp_master WHERE name = 'events'").get() ? "yes" : "?"} |`);
} catch (e) {
  console.log(`| prepare two statements | refused: ${String(e).split("\n")[0]} |`);
}

// The heap limit.
db.run("PRAGMA temp_store = MEMORY");
db.run(`PRAGMA hard_heap_limit = ${64 * 1024 * 1024}`);
const t = performance.now();
attempt(db, "hard_heap_limit 64 MB: sort 5M wide rows", "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 5000000) SELECT count(*) FROM (SELECT printf('%0200d', i) AS x FROM r ORDER BY x DESC)");
console.log(`(${Math.round(performance.now() - t)} ms)`);
db.run("PRAGMA hard_heap_limit = 0");

// Stopping a runaway query: bun:sqlite has no interrupt, so try a Worker and terminate().
const worker = new Worker(new URL("./native-worker.ts", import.meta.url).href, { argv: [index] } as WorkerOptions);
const started = performance.now();
let mainTicks = 0;
const tick = setInterval(() => mainTicks++, 50);
await new Promise((r) => setTimeout(r, 500));
worker.terminate();
const stopped = await new Promise<string>((resolve) => {
  worker.addEventListener("close", () => resolve(`closed ${Math.round(performance.now() - started)} ms after start`));
  setTimeout(() => resolve("not closed 10 s after terminate()"), 10_000);
});
clearInterval(tick);
console.log(`\nworker running a 10^12-row cross join, terminate() at 500 ms: ${stopped}; main thread ticked ${mainTicks} times (every 50 ms) meanwhile`);
