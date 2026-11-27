// The parser, one statement per call, interrupting a runaway query, the memory limit, and the
// SQLite index read while another connection writes it.
//
// Usage: bun limits.ts <extension dir> <root from gen.ts>
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const extDir = process.argv[2];
const root = process.argv[3];
const local = (s: string) =>
  s.replaceAll(root, "<root>").replaceAll(extDir, "<ext>").replaceAll(process.cwd(), "<cwd>");
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

const db = await DuckDBInstance.create(":memory:", {
  extension_directory: extDir,
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
  memory_limit: "256MB",
  threads: "2",
});
const c = await db.connect();
await c.run("LOAD sqlite");
await c.run(`ATTACH ${lit(join(root, "index/sqlite/search.db"))} AS idx (TYPE sqlite, READ_ONLY)`);
await c.run("CREATE VIEW events AS SELECT e.id, e.role, e.ts FROM idx.events e");
await c.run("SET enable_external_access = false");
await c.run("SET lock_configuration = true");

async function attempt(label: string, f: () => Promise<unknown>) {
  const t = performance.now();
  try {
    const v = await f();
    console.log(`${label}: ok in ${Math.round(performance.now() - t)} ms ${v === undefined ? "" : JSON.stringify(v).slice(0, 300)}`);
  } catch (e) {
    console.log(`${label}: refused in ${Math.round(performance.now() - t)} ms: ${local(String(e).split("\n")[0]).slice(0, 200)}`);
  }
}
const serialize = async (sql: string) => {
  const r = await c.runAndReadAll(`SELECT json_serialize_sql(${lit(sql)}) AS j`);
  return JSON.parse(String(r.getRowObjects()[0].j));
};

// 1. What json_serialize_sql gives the allowlist walker.
console.log("\n# json_serialize_sql");
for (const sql of [
  "SELECT 1; SELECT 2",
  "COPY (SELECT 1) TO 'x.csv'",
  "ATTACH 'x.db'",
  "SET threads = 1",
  "PRAGMA version",
  "CREATE VIEW v AS SELECT 1",
  "SELECT * FROM 'x.lance'",
  "SELECT * FROM read_csv('x.csv')",
  "SELECT * FROM idx.sessions",
  "WITH x AS (SELECT * FROM events) SELECT count(*) FROM x",
]) {
  await attempt(sql, async () => {
    const j = await serialize(sql);
    if (j.error) return { error: j.error_message };
    return { statements: j.statements.length, from: j.statements[0].node.from_table };
  });
}
const tree = await serialize(
  "SELECT role, count(*) FILTER (WHERE ts > 0) AS n, list(DISTINCT lower(role)) FROM events e WHERE e.id IN (SELECT id FROM events) GROUP BY ALL",
);
console.log("a full tree:", JSON.stringify(tree).length, "bytes; node keys:", Object.keys(tree.statements[0].node).join(","));

// 2. One statement per prepared call.
console.log("\n# prepare");
await attempt("prepare two statements", () => c.prepare("SELECT 1; SELECT 2"));
await attempt("prepare a SELECT then DROP", () => c.prepare("SELECT 1; DROP VIEW events"));
await attempt("prepare one SELECT", async () => {
  const p = await c.prepare("SELECT count(*) AS n FROM events");
  return (await p.runAndReadAll()).getRowObjectsJson();
});

// 3. Interrupt a runaway query after 500 ms.
console.log("\n# interrupt");
await attempt("cross join interrupted at 500 ms", async () => {
  const timer = setTimeout(() => c.interrupt(), 500);
  try {
    return (await c.runAndReadAll("SELECT count(*) FROM range(1000000000) a, range(1000) b")).getRowObjectsJson();
  } finally {
    clearTimeout(timer);
  }
});
await attempt("connection usable after interrupt", async () => (await c.runAndReadAll("SELECT 42 AS x")).getRowObjectsJson());

// 4. The memory limit (256 MB).
console.log("\n# memory_limit = 256MB");
await attempt("distinct over 50M wide strings", async () =>
  (await c.runAndReadAll("SELECT count(DISTINCT repeat(i::VARCHAR, 20)) FROM range(50000000) t(i)")).getRowObjectsJson(),
);
await attempt("string_agg of 50M rows", async () =>
  (await c.runAndReadAll("SELECT length(string_agg(repeat('x', 40), ',')) FROM range(50000000)")).getRowObjectsJson(),
);

// 5. SQLite: read while another connection writes (WAL), as the indexer does.
console.log("\n# sqlite WAL with a writer");
const writer = new Database(join(root, "index/sqlite/search.db"));
writer.run("PRAGMA journal_mode = WAL");
const insert = writer.prepare("INSERT INTO events (session, content_hash, event_index, role) VALUES (1, 'w', ?, 'user')");
let written = 0;
const write = setInterval(() => {
  writer.transaction(() => {
    for (let i = 0; i < 200; i++) insert.run(written++);
  })();
}, 5);
const counts: number[] = [];
let errors = 0;
for (let i = 0; i < 50; i++) {
  try {
    const r = await c.runAndReadAll("SELECT count(*) AS n FROM events");
    counts.push(Number(r.getRowObjects()[0].n));
  } catch (e) {
    errors++;
    if (errors === 1) console.log("first error:", String(e).split("\n")[0]);
  }
  await Bun.sleep(10);
}
clearInterval(write);
writer.close();
const rising = counts.every((n, i) => i === 0 || n >= counts[i - 1]);
console.log(`50 reads during writes: ${errors} errors, counts ${counts[0]} → ${counts.at(-1)}, never went down: ${rising}, rows written: ${written}`);
