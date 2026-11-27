// 100k synthetic records on S3: index build time, then query latency from a fresh connection.
import { BooleanQuery, connect, Index, MatchQuery, Occur, PhraseQuery } from "@lancedb/lancedb";
const opts = { storageOptions: JSON.parse(process.argv[3]) };
const words = Array.from({ length: 20000 }, (_, i) => `w${i.toString(36)}`);
const common = ["the", "test", "deploy", "checkout", "git", "push", "error", "file", "run", "fix"];
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = () => (rand() < 0.3 ? common[Math.floor(rand() * common.length)] : words[Math.floor(rand() ** 2 * words.length)]);
const N = 100_000;
const rows = Array.from({ length: N }, (_, i) => ({
  id: `s${i >> 4}:${i & 15}`, owner: `u${i % 50}`, archive_id: `s${i >> 4}`,
  visibility: i % 7 === 0 ? "owner" : "org", ts: i,
  text: Array.from({ length: 40 }, pick).join(" "),
}));
let t = performance.now();
const db = await connect(process.argv[2], opts);
const tbl = await db.createTable("scale", rows, { mode: "overwrite" });
console.log(`write ${N} rows: ${(performance.now() - t).toFixed(0)}ms`);
t = performance.now();
await tbl.createIndex("text", { config: Index.fts({ withPosition: true, stem: false, removeStopWords: false }) });
console.log(`build FTS index: ${(performance.now() - t).toFixed(0)}ms`);
const fresh = await (await connect(process.argv[2], opts)).openTable("scale");
const queries: [string, any][] = [
  ["rare word", new MatchQuery(words[3000], "text")],
  ["two common words AND", new BooleanQuery([[Occur.Must, new MatchQuery("deploy", "text")], [Occur.Must, new MatchQuery("checkout", "text")]])],
  ["phrase", new PhraseQuery("git push", "text")],
  ["common + visibility filter", new MatchQuery("error", "text")],
];
for (const [label, q] of queries) {
  const times: number[] = [];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    let b = fresh.query().fullTextSearch(q).select(["id", "_score"]).limit(100);
    if (label.includes("visibility")) b = b.where("visibility = 'org' OR owner IN ('u1')");
    n = (await b.toArray()).length;
    times.push(performance.now() - s);
  }
  console.log(`${label}: first ${times[0].toFixed(0)}ms, then ${times.slice(1).map((x) => x.toFixed(0)).join("/")}ms (${n} rows)`);
}
