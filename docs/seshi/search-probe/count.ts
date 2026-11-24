// What counting looks like in the open-source TypeScript library: countRows(filter), and
// counting an FTS query's matches (and distinct sessions) by streaming ids.
import { connect, Index, MatchQuery } from "@lancedb/lancedb";
const words = ["the", "test", "deploy", "checkout", "git", "push", "error", "file", "run", "fix",
  ...Array.from({ length: 5000 }, (_, i) => `w${i}`)];
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const rows = Array.from({ length: 100_000 }, (_, i) => ({
  id: `s${i >> 4}:${i & 15}`, owner: `u${i % 50}`, archive_id: `s${i >> 4}`,
  visibility: i % 7 === 0 ? "owner" : "org",
  text: Array.from({ length: 40 }, () => words[Math.floor(rand() ** 3 * words.length)]).join(" "),
}));
const tbl = await (await connect("./count-data")).createTable("events", rows, { mode: "overwrite" });
await tbl.createIndex("text", { config: Index.fts({ withPosition: true, stem: false, removeStopWords: false }) });
let t = performance.now();
const org = await tbl.countRows("visibility = 'org'");
console.log(`countRows("visibility = 'org'") = ${org} in ${(performance.now() - t).toFixed(0)}ms`);
for (const word of ["w300", "error"]) {
  t = performance.now();
  const ids = await tbl.query().fullTextSearch(new MatchQuery(word, "text"))
    .where("visibility = 'org' OR owner IN ('u1')").select(["archive_id"]).limit(1_000_000).toArray();
  const sessions = new Set(ids.map((r) => r.archive_id)).size;
  console.log(`FTS "${word}": ${ids.length} matching records, ${sessions} sessions, counted in TS in ${(performance.now() - t).toFixed(0)}ms`);
}
