// DuckDB's lance extension on the same table: which query shapes lance_fts takes, and the
// grouped relevance page in SQL for the shapes it does take, cold then warm.
// Usage: bun duck.ts <path to events.lance> [runs] [--no-shapes]
import { DuckDBInstance } from "@duckdb/node-api";
import { ms, pct } from "./common";

const path = process.argv[2];
const RUNS = Number(process.argv[3] ?? 10);
const shapes = !process.argv.includes("--no-shapes");
const CAP = 100_000;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
let t0 = performance.now();
await c.run("INSTALL lance; LOAD lance;");
console.log(`load lance: ${ms(performance.now() - t0)}`);

// What lance_fts makes of query strings, as counts of matching records. At 10M records a
// k this large overflows Arrow's 2 GB string offsets, so --no-shapes skips it.
for (const q of shapes ?  ["error", "error test", "error AND test", "+error +test", '"flaky checkout test"', "deploy -staging"] : []) {
  try {
    const r = await c.runAndReadAll(`SELECT count(*) n FROM lance_fts(${lit(path)}, 'text', ${lit(q)}, k := 10000000)`);
    console.log(`shape ${JSON.stringify(q)}: ${r.getRowObjectsJson()[0].n} records`);
  } catch (e) {
    console.log(`shape ${JSON.stringify(q)}: error ${String(e).slice(0, 200)}`);
  }
}

const FILTERS: [string, string | undefined][] = [
  ["admin, no filter", undefined],
  ["member u1 (org or own)", "visibility = 'org' OR owner IN ('u1')"],
];
const QUERIES = ["zeppelinx", "error", "rollback deployer", "the"];
for (const [fname, filter] of FILTERS) {
  for (const q of QUERIES) {
    // lance_fts's own `filter` works only on namespace-backed tables, so the filter is an outer
    // WHERE: it applies after the top k.
    const sql = `SELECT archive_id, max(_score) AS best, count(*) AS hits, max(session_updated) AS updated, count(*) OVER () AS total
      FROM lance_fts(${lit(path)}, 'text', ${lit(q)}, k := ${CAP}) ${filter ? `WHERE ${filter}` : ""}
      GROUP BY archive_id ORDER BY best DESC LIMIT 20`;
    const times: number[] = [];
    let total = 0;
    let cold = 0;
    for (let i = 0; i <= RUNS; i++) {
      t0 = performance.now();
      const r = await c.runAndReadAll(sql);
      const t = performance.now() - t0;
      if (i === 0) cold = t;
      else times.push(t);
      total = Number(r.getRowObjectsJson()[0]?.total ?? 0);
    }
    console.log(
      `duck | ${fname.padEnd(22)} | ${q.padEnd(18)} | first ${ms(cold).padStart(7)} | p50 ${ms(pct(times, 50)).padStart(7)} | p95 ${ms(pct(times, 95)).padStart(7)} | sessions ${total}`,
    );
  }
}
console.log(`runtime: bun ${Bun.version}, ${process.platform}-${process.arch}`);
