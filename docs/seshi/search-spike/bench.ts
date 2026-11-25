// The search path from lancedb-search.md, timed: one full-text search with the filter, grouping
// by session in TypeScript over Arrow, a page, then the page's sessions and best records.
// Each case runs once on a fresh connection (cold) and then `RUNS` times (warm).
// Usage: bun bench.ts <uri> [runs] [--cap N] [--sort relevance|recent]
import {
  BooleanQuery,
  connect,
  type FullTextQuery,
  MatchQuery,
  Occur,
  Operator,
  PhraseQuery,
  type Table,
} from "@lancedb/lancedb";
import { ms, pct, storageOptions } from "./common";

const uri = process.argv[2];
const RUNS = Number(process.argv[3] ?? 10);
const capAt = process.argv.indexOf("--cap");
const CAP = capAt < 0 ? 100_000 : Number(process.argv[capAt + 1]);
const sortAt = process.argv.indexOf("--sort");
const SORTS = (sortAt < 0 ? ["relevance", "recent"] : [process.argv[sortAt + 1]]) as ("relevance" | "recent")[];
const PAGE = 20;
const MATCHES = 3;
const NOW = Date.parse("2026-11-24T00:00:00Z");

const m = (w: string) => new MatchQuery(w, "text");
const and = (...q: FullTextQuery[]) => new BooleanQuery(q.map((x) => [Occur.Must, x]));

interface Case {
  name: string;
  query: FullTextQuery;
  /** For a prefix: the candidates come from text_prefix, then the text is checked. */
  prefix?: RegExp;
}
const CASES: Case[] = [
  { name: "rare word (zeppelinx)", query: m("zeppelinx") },
  { name: "one common word (error)", query: m("error") },
  { name: "two common words AND (error test)", query: and(m("error"), m("test")) },
  { name: "phrase (flaky checkout test)", query: new PhraseQuery("flaky checkout test", "text") },
  {
    name: "NOT (deploy -staging)",
    query: new BooleanQuery([
      [Occur.Must, m("deploy")],
      [Occur.MustNot, m("staging")],
    ]),
  },
  {
    name: "OR (rollback OR deployer)",
    query: new BooleanQuery([
      [Occur.Should, m("rollback")],
      [Occur.Should, m("deployer")],
    ]),
  },
  { name: "very common word (the)", query: m("the") },
  {
    name: "prefix (deplo*)",
    query: new MatchQuery("deplo", "text_prefix", { operator: Operator.And }),
    prefix: /(^|[^\p{L}\p{N}])deplo/iu,
  },
];
const FILTERS: [string, string | undefined][] = [
  ["admin, no filter", undefined],
  ["member u1 (org or own)", "visibility = 'org' OR owner IN ('u1')"],
  [
    "member + label + model",
    "(visibility = 'org' OR owner IN ('u1')) AND array_has_all(labels, ['dosu.project=app']) AND array_has_any(models, ['claude-opus-5-5'])",
  ],
];

interface Group {
  best: number;
  hits: number;
  updated: number;
  top: { id: string; score: number }[];
}

async function search(events: Table, c: Case, where: string | undefined, sort: "relevance" | "recent") {
  const t = { search: 0, group: 0, fetch: 0 };
  let t0 = performance.now();
  const windows = sort === "recent" ? [1, 7, 30, Number.POSITIVE_INFINITY] : [Number.POSITIVE_INFINITY];
  let groups = new Map<string, Group>();
  let rows = 0;
  let capped = false;
  let checked = 0;
  for (const days of windows) {
    const clauses = [where, Number.isFinite(days) ? `session_updated >= to_timestamp_millis(${NOW - days * 86_400_000})` : undefined]
      .filter(Boolean)
      .map((x) => `(${x})`);
    let q = events
      .query()
      .fullTextSearch(c.query)
      .select(c.prefix ? ["id", "archive_id", "session_updated", "_score", "text"] : ["id", "archive_id", "session_updated", "_score"])
      .limit(CAP);
    if (clauses.length > 0) q = q.where(clauses.join(" AND "));
    t0 = performance.now();
    const table = await q.toArrow();
    t.search += performance.now() - t0;
    t0 = performance.now();
    groups = new Map();
    rows = table.numRows;
    capped = rows >= CAP;
    const ids = table.getChild("id")!;
    const archives = table.getChild("archive_id")!;
    const scores = table.getChild("_score")!;
    const updated = table.getChild("session_updated")!;
    const texts = c.prefix ? table.getChild("text")! : undefined;
    for (let i = 0; i < rows; i++) {
      if (texts) {
        checked++;
        if (!c.prefix!.test(texts.get(i) as string)) continue;
      }
      const a = archives.get(i) as string;
      const s = scores.get(i) as number;
      let g = groups.get(a);
      if (!g) {
        g = { best: s, hits: 0, updated: Number(updated.get(i)), top: [] };
        groups.set(a, g);
      }
      g.hits++;
      if (s > g.best) g.best = s;
      if (g.top.length < MATCHES) g.top.push({ id: ids.get(i) as string, score: s });
      else {
        const low = g.top.reduce((lo, x, k) => (x.score < g!.top[lo].score ? k : lo), 0);
        if (s > g.top[low].score) g.top[low] = { id: ids.get(i) as string, score: s };
      }
    }
    t.group += performance.now() - t0;
    if (!capped && groups.size >= PAGE) break;
  }
  t0 = performance.now();
  const page = [...groups.entries()]
    .sort((x, y) => (sort === "relevance" ? y[1].best - x[1].best : y[1].updated - x[1].updated))
    .slice(0, PAGE);
  t.group += performance.now() - t0;
  t0 = performance.now();
  const sql = (xs: string[]) => xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ");
  if (page.length > 0) {
    const sessionIds = page.map(([a]) => a);
    const recordIds = page.flatMap(([, g]) => g.top.map((x) => x.id));
    await Promise.all([
      sessionsTable.query().where(`archive_id IN (${sql(sessionIds)})`).limit(PAGE).toArray(),
      events.query().where(`id IN (${sql(recordIds)})`).select(["id", "text", "role", "tool_name", "ts"]).limit(recordIds.length).toArray(),
    ]);
  }
  t.fetch = performance.now() - t0;
  const kept = [...groups.values()].reduce((n, g) => n + g.hits, 0);
  return { t, total: t.search + t.group + t.fetch, rows, sessions: groups.size, capped, checked, kept };
}

let sessionsTable: Table;
const results: string[] = [];
for (const sort of SORTS) {
  for (const [fname, where] of FILTERS) {
    for (const c of CASES) {
      // A fresh connection per case: the first search pays for opening the table and reading
      // index metadata from the bucket.
      const db = await connect(uri, { storageOptions: storageOptions(), readConsistencyInterval: 5 });
      const events = await db.openTable("events");
      sessionsTable = await db.openTable("sessions");
      const cold = await search(events, c, where, sort);
      const warm: number[] = [];
      let last = cold;
      for (let i = 0; i < RUNS; i++) {
        last = await search(events, c, where, sort);
        warm.push(last.total);
      }
      const line = `${sort.padEnd(9)} | ${fname.padEnd(22)} | ${c.name.padEnd(34)} | cold ${ms(cold.total).padStart(7)} | p50 ${ms(pct(warm, 50)).padStart(7)} | p95 ${ms(pct(warm, 95)).padStart(7)} | search ${ms(last.t.search)} group ${ms(last.t.group)} fetch ${ms(last.t.fetch)} | rows ${last.rows}${last.capped ? " (capped)" : ""}${c.prefix ? ` checked ${last.checked} kept ${last.kept}` : ""} | sessions ${last.sessions}`;
      console.log(line);
      results.push(line);
    }
  }
}
console.log(`runtime: bun ${Bun.version}, ${process.platform}-${process.arch}`);
