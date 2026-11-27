// One commit per feed page: upsert the page's records and, in the same mergeInsert, delete the
// rows of replaced or removed sessions that the page no longer holds
// (whenNotMatchedBySourceDelete). Usage: bun replace.ts [uri]
import { connect, Index, MatchQuery } from "@lancedb/lancedb";

const db = await connect(process.argv[2] ?? "./data");
const row = (archive: string, i: number, text: string) => ({ id: `${archive}:${i}`, archive_id: archive, text });
const tbl = await db.createTable(
  "events",
  [row("a", 0, "old alpha zero"), row("a", 1, "old alpha one"), row("a", 2, "old alpha two"),
   row("b", 0, "bravo kept"), row("c", 0, "charlie removed"), row("d", 0, "delta continued")],
  { mode: "overwrite" },
);
await tbl.createIndex("text", { config: Index.fts({ withPosition: true, stem: false, removeStopWords: false }) });
const before = await tbl.version();

// The page: session a is replaced by two records (a:2 must go), c is removed (no new rows),
// d is continued (a new record appended; its old one must stay), b is untouched.
const page = [row("a", 0, "new alpha zero"), row("a", 1, "new alpha one"), row("d", 1, "delta appended")];
const replacedOrRemoved = ["a", "c"];
const result = await tbl
  .mergeInsert("id")
  .whenMatchedUpdateAll()
  .whenNotMatchedInsertAll()
  .whenNotMatchedBySourceDelete({
    where: `archive_id IN (${replacedOrRemoved.map((a) => `'${a}'`).join(", ")})`,
  })
  .execute(page);
console.log("merge result:", JSON.stringify(result));
console.log(`versions: ${before} -> ${await tbl.version()} (one commit expected)`);
const rows = (await tbl.query().select(["id", "text"]).toArray())
  .map((r) => `${r.id}=${r.text}`)
  .sort();
console.log("rows:", rows);
for (const word of ["old", "new", "charlie", "delta"]) {
  const hits = await tbl.query().fullTextSearch(new MatchQuery(word, "text")).select(["id"]).limit(100).toArray();
  console.log(`search ${word}:`, hits.map((h) => h.id).sort());
}
