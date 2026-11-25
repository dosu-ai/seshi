// Two common words that must both match: a BooleanQuery of Must clauses against one MatchQuery
// with Operator.And, at two caps. Also prints the text index's stats after optimize().
// Usage: bun and.ts <uri> [runs]
import { BooleanQuery, connect, type FullTextQuery, MatchQuery, Occur, Operator } from "@lancedb/lancedb";
import { ms, pct, storageOptions } from "./common";

const RUNS = Number(process.argv[3] ?? 5);
const db = await connect(process.argv[2], { storageOptions: storageOptions(), readConsistencyInterval: 5 });
const events = await db.openTable("events");
console.log("text_idx:", JSON.stringify(await events.indexStats("text_idx")));
const shapes: [string, () => FullTextQuery][] = [
  ["BooleanQuery Must + Must", () => new BooleanQuery([[Occur.Must, new MatchQuery("error", "text")], [Occur.Must, new MatchQuery("test", "text")]])],
  ["MatchQuery Operator.And", () => new MatchQuery("error test", "text", { operator: Operator.And })],
  ["BooleanQuery Must + Must (mid words)", () => new BooleanQuery([[Occur.Must, new MatchQuery("rollback", "text")], [Occur.Must, new MatchQuery("deployer", "text")]])],
  ["MatchQuery Operator.And (mid words)", () => new MatchQuery("rollback deployer", "text", { operator: Operator.And })],
];
for (const cap of [10_000, 100_000]) {
  for (const [name, q] of shapes) {
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i <= RUNS; i++) {
      const t0 = performance.now();
      const t = await events.query().fullTextSearch(q()).select(["id", "archive_id", "_score"]).limit(cap).toArrow();
      if (i > 0) times.push(performance.now() - t0);
      rows = t.numRows;
    }
    console.log(`and | cap ${cap} | ${name.padEnd(38)} | p50 ${ms(pct(times, 50)).padStart(7)} | rows ${rows}`);
  }
}
