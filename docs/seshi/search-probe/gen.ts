// 1M synthetic event records (40 words each, skewed vocabulary) with analytics-ish columns,
// written as a Lance table with an FTS index. Usage: bun gen.ts <uri> [storage options JSON]
import { connect, Index } from "@lancedb/lancedb";
const opts = process.argv[3] ? { storageOptions: JSON.parse(process.argv[3]) } : {};
const words = ["the", "test", "deploy", "checkout", "git", "push", "error", "file", "run", "fix",
  ...Array.from({ length: 20000 }, (_, i) => `w${i}`)];
const models = ["opus", "sonnet", "haiku", "gpt", "gemini"];
let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const db = await connect(process.argv[2], opts);
const N = 1_000_000, BATCH = 100_000;
let t = performance.now();
let tbl;
for (let b = 0; b < N; b += BATCH) {
  const rows = Array.from({ length: BATCH }, (_, j) => {
    const i = b + j;
    return {
      id: `s${i >> 4}:${i & 15}`, owner: `u${i % 200}`, archive_id: `s${i >> 4}`,
      visibility: i % 7 === 0 ? "owner" : "org", model: models[i % 5], ts: 1_760_000_000_000 + i * 60_000,
      input_tokens: Math.floor(rand() * 5000), output_tokens: Math.floor(rand() * 1000),
      text: Array.from({ length: 40 }, () => words[Math.floor(rand() ** 3 * words.length)]).join(" "),
    };
  });
  tbl = b === 0 ? await db.createTable("events", rows, { mode: "overwrite" }) : (await tbl!.add(rows), tbl!);
}
console.log(`write ${N}: ${(performance.now() - t).toFixed(0)}ms`);
t = performance.now();
await tbl!.createIndex("text", { config: Index.fts({ withPosition: true, stem: false, removeStopWords: false }) });
console.log(`FTS index: ${(performance.now() - t).toFixed(0)}ms`);
t = performance.now();
await tbl!.optimize();
console.log(`optimize: ${(performance.now() - t).toFixed(0)}ms`);
