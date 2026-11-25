// The write side on an existing table: feed pages committed as in lancedb-search.md (one
// mergeInsert per table, with whenNotMatchedBySourceDelete for replaced and removed sessions),
// then optimize(), whether deleted rows leave the fragments, and a scrub (copy the live rows
// into a fresh table and index it). It changes the table, so run it after bench.ts.
// --split commits each page as an indexed mergeInsert (no by-source clause) and then a delete of
// the replaced and removed sessions' old rows: two commits, but neither scans the whole table.
// Usage: bun commit.ts <uri> [pages] [--scrub] [--split] [--no-optimize] [--offset N]
import { connect, Index, makeArrowTable, type Table } from "@lancedb/lancedb";
import { Table as ArrowTable } from "apache-arrow";
import { EVENTS_SCHEMA, ms, pct, SESSIONS_SCHEMA, sessions, storageOptions, time } from "./common";

const uri = process.argv[2];
const PAGES = Number(process.argv[3] ?? 5);
const scrub = process.argv.includes("--scrub");
const split = process.argv.includes("--split");
const optimize = !process.argv.includes("--no-optimize");
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const OFFSET = Number(flag("--offset") ?? 0);
const db = await connect(uri, { storageOptions: storageOptions() });
const events = await db.openTable("events");
const sess = await db.openTable("sessions");
const sql = (xs: string[]) => xs.map((x) => `'${x}'`).join(", ");

const existing = (await sess.query().select(["owner", "archive_id"]).limit(PAGES * 35 + 10).offset(OFFSET).toArray()).map((r) => ({
  owner: r.owner as string,
  archive: r.archive_id as string,
}));
const fresh = sessions({ seed: 4242, owners: 50, days: 1, now: Date.now() }, 50_000_000 + OFFSET * 100);
const commitTimes: number[] = [];
const sessionTimes: number[] = [];
let deletedTotal = 0;
for (let p = 0; p < PAGES; p++) {
  const slice = existing.slice(p * 35, p * 35 + 35);
  const replaced = slice.slice(0, 4);
  const removed = slice.slice(4, 5);
  const continued = slice.slice(5, 35);
  const rows: Record<string, unknown>[] = [];
  const sessionRows: Record<string, unknown>[] = [];
  // 15 new sessions; their generated rows also give the shape for replacements and appends.
  for (let i = 0; i < 15 + replaced.length + continued.length; i++) {
    const { session, events: ev } = fresh.next().value!;
    const target = i < 15 ? undefined : i < 15 + replaced.length ? replaced[i - 15] : continued[i - 15 - replaced.length];
    const isContinuation = i >= 15 + replaced.length;
    const take = isContinuation ? ev.slice(0, 20) : ev;
    const hash = `o${OFFSET}p${p}x${i}`;
    for (const e of take) {
      if (target) {
        e.owner = target.owner;
        e.archive_id = target.archive;
        e.content_hash = hash;
        e.id = `${target.owner}/${target.archive}/${hash}/${e.event_index}`;
      }
      rows.push(e);
    }
    if (target) {
      session.owner = target.owner;
      session.archive_id = target.archive;
      session.id = `${target.owner}/${target.archive}`;
    }
    sessionRows.push(session);
  }
  const doomed = [...replaced, ...removed].map((s) => s.archive);
  if (split) {
    const hashes = [...new Set(rows.map((r) => r.content_hash as string))];
    const [result, t] = await time(() =>
      events.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(rows, { schema: EVENTS_SCHEMA })),
    );
    const [del, td] = await time(() => events.delete(`archive_id IN (${sql(doomed)}) AND content_hash NOT IN (${sql(hashes)})`));
    commitTimes.push(t + td);
    deletedTotal += del.numDeletedRows;
    const [, ts] = await time(() =>
      sess.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(sessionRows, { schema: SESSIONS_SCHEMA })),
    );
    sessionTimes.push(ts);
    console.log(
      `page ${p}: ${rows.length} records, split: mergeInsert ${ms(t)} (inserted ${result.numInsertedRows}, updated ${result.numUpdatedRows}) + delete ${ms(td)} (deleted ${del.numDeletedRows}), sessions ${ms(ts)}`,
    );
    continue;
  }
  const [result, t] = await time(() =>
    events
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .whenNotMatchedBySourceDelete({ where: `archive_id IN (${sql(doomed)})` })
      .execute(makeArrowTable(rows, { schema: EVENTS_SCHEMA })),
  );
  commitTimes.push(t);
  deletedTotal += result.numDeletedRows;
  const [, ts] = await time(() =>
    sess.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(sessionRows, { schema: SESSIONS_SCHEMA })),
  );
  sessionTimes.push(ts);
  console.log(
    `page ${p}: ${rows.length} records, events mergeInsert ${ms(t)} (inserted ${result.numInsertedRows}, updated ${result.numUpdatedRows}, deleted ${result.numDeletedRows}), sessions ${ms(ts)}`,
  );
}
console.log(`events commit p50 ${ms(pct(commitTimes, 50))} max ${ms(Math.max(...commitTimes))}; sessions p50 ${ms(pct(sessionTimes, 50))}`);

const indices = await events.listIndices();
if (!optimize) process.exit(0);
const before = await events.stats();
const [opt, tOpt] = await time(() => events.optimize({ cleanupOlderThan: new Date(Date.now() - 60_000) }));
const after = await events.stats();
console.log(`optimize: ${ms(tOpt)} ${JSON.stringify(opt.compaction)}`);
console.log(
  `deleted rows still in fragments: before optimize ${before.numDeletedRows}, after ${after.numDeletedRows} (deleted this run: ${deletedTotal})`,
);
for (const i of indices) {
  const s = await events.indexStats(i.name);
  if (s && s.numUnindexedRows > 0) console.log(`  ${i.name}: ${s.numUnindexedRows} unindexed after optimize`);
}

if (scrub) {
  // Copy the live rows into a fresh table, then index it: what the scrub does per table.
  const t0 = performance.now();
  const copy = await db.createEmptyTable("events_scrub", EVENTS_SCHEMA, { mode: "overwrite" });
  let copied = 0;
  // One add per large batch: Arrow will not join batches streamed from different fragments.
  const query = events.query().select(EVENTS_SCHEMA.fields.map((f) => f.name));
  // biome-ignore lint/suspicious/noExplicitAny: execute() is protected; it takes the batch size.
  for await (const batch of (query as any).execute({ maxBatchLength: 200_000 })) {
    await copy.add(new ArrowTable(batch));
    copied += batch.numRows;
  }
  const tCopy = performance.now() - t0;
  const step = async (label: string, fn: () => Promise<unknown>) => {
    const [, t] = await time(fn);
    console.log(`scrub ${label}: ${ms(t)}`);
  };
  console.log(`scrub copy: ${copied} rows in ${ms(tCopy)}`);
  await step("fts text", () => copy.createIndex("text", { config: Index.fts({ withPosition: true, stem: false, removeStopWords: false }) }));
  if (indices.some((i) => i.columns.includes("text_prefix"))) {
    await step("fts text_prefix", () =>
      copy.createIndex("text_prefix", {
        config: Index.fts({ baseTokenizer: "ngram", ngramMinLength: 2, ngramMaxLength: 12, prefixOnly: true, withPosition: false }),
      }),
    );
  }
  await step("scalar indexes", async () => {
    await copy.createIndex("models", { config: Index.labelList() });
    await copy.createIndex("labels", { config: Index.labelList() });
    for (const c of ["visibility", "role", "format"]) await copy.createIndex(c, { config: Index.bitmap() });
    for (const c of ["owner", "archive_id", "session_updated"]) await copy.createIndex(c, { config: Index.btree() });
  });
  console.log(`scrub total: ${ms(performance.now() - t0)}; deleted rows in the copy: ${(await copy.stats()).numDeletedRows}`);
  await db.dropTable("events_scrub");
}

export type { Table };
