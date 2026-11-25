// Writes `records` searchable records (and their sessions) to <uri>/events and <uri>/sessions,
// then builds the indexes from lancedb-search.md and runs optimize(), timing each step.
// Usage: bun gen.ts <uri> <records> [--no-prefix]
import { connect, Index, makeArrowTable } from "@lancedb/lancedb";
import { EVENTS_SCHEMA, ms, SESSIONS_SCHEMA, sessions, storageOptions, time } from "./common";

const [uri, target] = [process.argv[2], Number(process.argv[3])];
const prefix = !process.argv.includes("--no-prefix");
if (!uri || !target) throw new Error("usage: bun gen.ts <uri> <records> [--no-prefix]");

const db = await connect(uri, { storageOptions: storageOptions() });
const events = await db.createEmptyTable("events", EVENTS_SCHEMA, { mode: "overwrite" });
const sess = await db.createEmptyTable("sessions", SESSIONS_SCHEMA, { mode: "overwrite" });

const BATCH = 100_000;
let rows: Record<string, unknown>[] = [];
let sessionRows: Record<string, unknown>[] = [];
let written = 0;
let sessionCount = 0;
let chars = 0;
const t0 = performance.now();
for (const { session, events: ev } of sessions({ seed: 42, owners: 50, days: 120, now: Date.parse("2026-11-24T00:00:00Z") })) {
  rows.push(...ev);
  sessionRows.push(session);
  sessionCount++;
  for (const e of ev) chars += (e.text as string).length;
  if (rows.length >= BATCH || written + rows.length >= target) {
    await events.add(makeArrowTable(rows, { schema: EVENTS_SCHEMA }));
    await sess.add(makeArrowTable(sessionRows, { schema: SESSIONS_SCHEMA }));
    written += rows.length;
    rows = [];
    sessionRows = [];
    if (written % 1_000_000 < BATCH) {
      console.log(`  ${written} records, ${sessionCount} sessions, ${ms(performance.now() - t0)}`);
    }
    if (written >= target) break;
  }
}
const writeMs = performance.now() - t0;
console.log(
  `write: ${written} records in ${sessionCount} sessions, ${(chars / written).toFixed(0)} chars/record, ${ms(writeMs)}`,
);

const step = async (label: string, fn: () => Promise<unknown>) => {
  const [, t] = await time(fn);
  console.log(`${label}: ${ms(t)}`);
};
await step("index fts text", () =>
  events.createIndex("text", {
    config: Index.fts({ withPosition: true, stem: false, removeStopWords: false }),
  }),
);
if (prefix) {
  await step("index fts text_prefix (ngram 2-12, prefixOnly)", () =>
    events.createIndex("text_prefix", {
      config: Index.fts({
        baseTokenizer: "ngram",
        ngramMinLength: 2,
        ngramMaxLength: 12,
        prefixOnly: true,
        withPosition: false,
      }),
    }),
  );
}
await step("index labelList models, labels", async () => {
  await events.createIndex("models", { config: Index.labelList() });
  await events.createIndex("labels", { config: Index.labelList() });
});
await step("index bitmap visibility, role, format", async () => {
  for (const c of ["visibility", "role", "format"]) await events.createIndex(c, { config: Index.bitmap() });
});
await step("index btree id, owner, archive_id, session_updated", async () => {
  for (const c of ["id", "owner", "archive_id", "session_updated"]) await events.createIndex(c, { config: Index.btree() });
});
await step("sessions btree id, archive_id", async () => {
  await sess.createIndex("id", { config: Index.btree() });
  await sess.createIndex("archive_id", { config: Index.btree() });
});
await step("optimize", () => events.optimize({ cleanupOlderThan: new Date() }));
const stats = await events.stats();
console.log("events stats:", JSON.stringify({ bytes: stats.totalBytes, rows: stats.numRows, fragments: stats.fragmentStats.numFragments, indices: stats.numIndices }));
for (const i of await events.listIndices()) {
  const s = await events.indexStats(i.name);
  console.log(`  index ${i.name}: ${i.indexType}, ${JSON.stringify(s)}`);
}
