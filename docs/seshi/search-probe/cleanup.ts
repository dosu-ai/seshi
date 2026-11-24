// Run after probe.ts on the same URI: optimize twice with version pruning and deleteUnverified,
// to see when deleted rows leave the data files. Usage: bun cleanup.ts <uri> <storage options JSON>
import { connect } from "@lancedb/lancedb";
const opts = { storageOptions: JSON.parse(process.argv[3]) };
const tbl = await (await connect(process.argv[2], opts)).openTable("events");
for (let i = 0; i < 2; i++) {
  const s = await tbl.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
  console.log(`optimize ${i + 1}:`, JSON.stringify(s));
}
console.log("stats:", JSON.stringify(await tbl.stats()));
