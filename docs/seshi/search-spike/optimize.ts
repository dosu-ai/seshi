// Runs optimize() on events and reports what it changed: unindexed and deleted rows, fragments.
// Usage: bun optimize.ts <uri>
import { connect } from "@lancedb/lancedb";
import { ms, storageOptions, time } from "./common";

const db = await connect(process.argv[2], { storageOptions: storageOptions() });
const events = await db.openTable("events");
const report = async (when: string) => {
  const s = await events.stats();
  const text = await events.indexStats("text_idx");
  console.log(
    `${when}: ${s.numRows} rows, ${s.fragmentStats.numFragments} fragments, ${s.numDeletedRows} deleted, ${text?.numUnindexedRows} not in the text index`,
  );
};
await report("before");
const [opt, t] = await time(() => events.optimize({ cleanupOlderThan: new Date(Date.now() - 60_000) }));
console.log(`optimize: ${ms(t)} ${JSON.stringify(opt.compaction)}`);
await report("after");
