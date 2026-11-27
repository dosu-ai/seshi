// Probe: does @lancedb/lancedb work under Bun, and how does its FTS behave for seshi's needs?
// Usage: bun probe.ts <uri> [storage options as JSON]
import { BooleanQuery, connect, Index, MatchQuery, Occur, PhraseQuery } from "@lancedb/lancedb";

const uri = process.argv[2] ?? "./data";
const storageOptions = process.argv[3] ? JSON.parse(process.argv[3]) : undefined;
const t0 = performance.now();
const ms = () => `${(performance.now() - t0).toFixed(0)}ms`;
const log = (label: string, value: unknown) => console.log(`[${ms()}] ${label}:`, value);

const db = await connect(uri, storageOptions ? { storageOptions } : {});
const rows = [
  { id: "a1:0", owner: "alice", archive_id: "a1", visibility: "org", ts: 1, text: "The flaky checkout test fails on CI again" },
  { id: "a1:1", owner: "alice", archive_id: "a1", visibility: "org", ts: 2, text: "run git push --force to origin main" },
  { id: "a2:0", owner: "alice", archive_id: "a2", visibility: "owner", ts: 3, text: "deploy to staging then production" },
  { id: "b1:0", owner: "bob", archive_id: "b1", visibility: "org", ts: 4, text: "deploy the widget service to production" },
  { id: "b1:1", owner: "bob", archive_id: "b1", visibility: "org", ts: 5, text: "Le café est fermé; edit src/app.ts and deployment.yaml" },
  { id: "b2:0", owner: "bob", archive_id: "b2", visibility: "owner", ts: 6, text: "checkout checkout checkout flaky flaky" },
];
const tbl = await db.createTable("events", rows, { mode: "overwrite" });
await tbl.createIndex("text", {
  config: Index.fts({
    withPosition: true,
    stem: false,
    removeStopWords: false,
    asciiFolding: true,
    lowercase: true,
  }),
});
log("indices", (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`));

async function run(label: string, query: Parameters<typeof tbl.query>[0] extends never ? never : any, where?: string, fast = false) {
  let q = tbl.query().fullTextSearch(query).select(["id", "owner", "text", "_score"]).limit(10);
  if (where) q = q.where(where);
  if (fast) q = q.fastSearch();
  const out = await q.toArray();
  log(label, out.map((r) => `${r.id} ${Number(r._score).toFixed(3)}`));
}

await run("AND: flaky checkout", new BooleanQuery([
  [Occur.Must, new MatchQuery("flaky", "text")],
  [Occur.Must, new MatchQuery("checkout", "text")],
]));
await run("OR (plain string): deploy production", "deploy production");
await run("phrase: \"git push force\"", new PhraseQuery("git push force", "text"));
await run("phrase via punctuation: \"src/app.ts\"", new PhraseQuery("src/app.ts", "text"));
await run("NOT: deploy -staging", new BooleanQuery([
  [Occur.Must, new MatchQuery("deploy", "text")],
  [Occur.MustNot, new MatchQuery("staging", "text")],
]));
await run("accents: cafe ferme", new BooleanQuery([
  [Occur.Must, new MatchQuery("cafe", "text")],
  [Occur.Must, new MatchQuery("ferme", "text")],
]));
await run("case: CHECKOUT", new MatchQuery("CHECKOUT", "text"));
await run("prefix deploy* (fuzzy is not prefix; plain match only)", new MatchQuery("deploy", "text"));
await run(
  "visibility filter as viewer alice (org or own)",
  new MatchQuery("deploy", "text"),
  "visibility = 'org' OR owner IN ('alice')",
);

// Rows added after the index was built, before optimize().
await tbl.add([{ id: "c1:0", owner: "carol", archive_id: "c1", visibility: "org", ts: 7, text: "brand new zeppelin record" }]);
await run("unindexed row, default search", new MatchQuery("zeppelin", "text"));
await run("unindexed row, fastSearch()", new MatchQuery("zeppelin", "text"), undefined, true);

// Retraction: delete a session's rows.
await tbl.delete("archive_id = 'b1'");
await run("after delete b1: deploy", new MatchQuery("deploy", "text"));

// Upsert: replace a session (merge_insert on id).
await tbl.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([
  { id: "a2:0", owner: "alice", archive_id: "a2", visibility: "org", ts: 8, text: "rollback staging deploy" },
]);
await run("after upsert a2: rollback", new MatchQuery("rollback", "text"));

const stats = await tbl.optimize({ cleanupOlderThan: new Date() });
log("optimize", JSON.stringify(stats));
await run("after optimize, fastSearch zeppelin", new MatchQuery("zeppelin", "text"), undefined, true);
log("version", await tbl.version());
log("rows", await tbl.countRows());

// A second, independent connection (as another API instance would) sees the writer's data.
const reader = await (await connect(uri, storageOptions ? { storageOptions } : {})).openTable("events");
log("reader rows", await reader.countRows());
log("runtime", `bun ${Bun.version}`);
