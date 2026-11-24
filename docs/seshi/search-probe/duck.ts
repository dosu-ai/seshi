// DuckDB + lance extension under Bun: scans, GROUP BY, lance_fts with aggregation, and an
// in-memory copy. Usage: bun duck.ts <path to .lance> [setup SQL]
import { DuckDBInstance } from "@duckdb/node-api";
const path = process.argv[2];
const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
async function q(label: string, sql: string, runs = 3) {
  const times: string[] = [];
  let rows: unknown[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    rows = (await c.runAndReadAll(sql)).getRowObjectsJson();
    times.push((performance.now() - s).toFixed(0));
  }
  console.log(`${label}: ${times.join("/")}ms ->`, JSON.stringify(rows.slice(0, 3)));
}
let s = performance.now();
await c.run("INSTALL lance; LOAD lance;");
console.log(`install+load lance: ${(performance.now() - s).toFixed(0)}ms`);
if (process.argv[3]) await c.run(process.argv[3]);
console.log((await c.runAndReadAll("SELECT version() AS v")).getRowObjectsJson());
await q("count(*)", `SELECT count(*) AS n FROM '${path}'`);
await q("count by visibility", `SELECT visibility, count(*) n FROM '${path}' GROUP BY 1 ORDER BY 1`);
await q("tokens by model", `SELECT model, sum(input_tokens) i, sum(output_tokens) o FROM '${path}' GROUP BY 1 ORDER BY 1`);
await q("tokens by owner per day (top)", `SELECT owner, date_trunc('day', make_timestamp(CAST(ts AS BIGINT)*1000)) d, sum(input_tokens+output_tokens) t FROM '${path}' GROUP BY ALL ORDER BY t DESC LIMIT 3`);
await q("distinct sessions", `SELECT count(DISTINCT archive_id) n FROM '${path}'`);
await q("text ILIKE scan (no index)", `SELECT count(*) n FROM '${path}' WHERE text ILIKE '%w300 %'`);
await q("lance_fts 'error' grouped by session", `SELECT count(*) records, count(DISTINCT archive_id) sessions, max(_score) best FROM lance_fts('${path}', 'text', 'error', k = 1000000)`);
await q("lance_fts 'w300', top sessions", `SELECT archive_id, max(_score) best, count(*) hits FROM lance_fts('${path}', 'text', 'w300', k = 1000000) WHERE visibility = 'org' OR owner = 'u1' GROUP BY 1 ORDER BY best DESC LIMIT 3`);
s = performance.now();
await c.run(`CREATE TABLE mem AS SELECT * EXCLUDE (text) FROM '${path}'`);
console.log(`copy into memory (no text): ${(performance.now() - s).toFixed(0)}ms`);
await q("in-memory tokens by owner per day", `SELECT owner, date_trunc('day', make_timestamp(CAST(ts AS BIGINT)*1000)) d, sum(input_tokens+output_tokens) t FROM mem GROUP BY ALL ORDER BY t DESC LIMIT 3`);
