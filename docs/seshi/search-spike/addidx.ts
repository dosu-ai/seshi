// Adds the btree indexes gen.ts gained after the first 1M run: events.id and sessions.archive_id.
// Usage: bun addidx.ts <uri>
import { connect, Index } from "@lancedb/lancedb";
import { ms, time } from "./common";
const db = await connect(process.argv[2]);
const [, a] = await time(async () => (await db.openTable("events")).createIndex("id", { config: Index.btree() }));
const [, b] = await time(async () => (await db.openTable("sessions")).createIndex("archive_id", { config: Index.btree() }));
console.log(`btree events.id ${ms(a)}, sessions.archive_id ${ms(b)}`);
