// A synthetic store for the end-to-end build: the same sessions as data.ts, written as Trajectory
// logs through `StoreSeshi.ingest` (normalize, redact, trace, metadata, change entry), so the
// `Indexer` reads feeds, metadata and traces as it does in a deployment.
// Usage: bun store.ts <store-url> <records> [concurrency]
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { StoreSeshi } from "@seshi/pipeline";
import { openStore } from "@seshi/store";
import { type Generated, OWNERS, ownerSessions, rss } from "./data";

const [url, recordsArg, concurrencyArg] = process.argv.slice(2);
if (!url || !recordsArg) throw new Error("usage: bun store.ts <store-url> <records> [concurrency]");
const records = Number(recordsArg);
const concurrency = Number(concurrencyArg ?? 16);
const { store } = openStore(url);
const formats = new FormatRegistry(BUILTIN_FORMATS);
const now = Date.now();
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

/** A session as a Trajectory log: tool calls ride on an assistant record. */
function transcript({ session, events }: Generated): string {
  let out = line({ role: "meta", source: "trajectory", git_branch: session.branch });
  let call = 0;
  for (const e of events) {
    const timestamp = new Date(e.timestamp ?? now).toISOString();
    if (e.role === "tool_call") {
      const id = `c${call++}`;
      const space = e.text.indexOf(" ");
      out += line({
        role: "assistant",
        content: "",
        timestamp,
        tool_calls: [{ id, name: e.tool_name ?? "Bash", args: e.text.slice(space + 1) }],
      });
      out += line({ role: "tool", tool_call_id: id, content: "ok", timestamp });
    } else {
      out += line({ role: e.role, content: e.text, timestamp });
    }
  }
  return out;
}

const perOwner = Math.ceil(records / OWNERS);
const jobs: Generated[][] = [];
let total = 0;
let sessions = 0;
for (let o = 0; o < OWNERS; o++) {
  const it = ownerSessions(o, { now, days: 120 });
  const mine: Generated[] = [];
  let n = 0;
  while (n < perOwner && total < records) {
    const g = it.next().value as Generated;
    // Text is generated again when written: keep only what is needed to regenerate it.
    mine.push(g);
    n += g.events.length;
    total += g.events.length;
    sessions++;
  }
  jobs.push(mine);
  if (total >= records) break;
}
console.log(`${sessions} sessions, ${total} records, ${OWNERS} owners, concurrency ${concurrency}`);
const t0 = performance.now();
let done = 0;
let doneRecords = 0;
const queue = jobs.flatMap((list) => list);
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < queue.length) {
      const g = queue[next++] as Generated;
      const seshi = new StoreSeshi({ store, owner: g.session.owner, formats });
      await seshi.ingest({
        format: "trajectory",
        session_id: g.session.session_id,
        transcript: transcript(g),
        visibility: g.session.visibility,
      });
      done++;
      doneRecords += g.events.length;
      if (done % 500 === 0) {
        const s = (performance.now() - t0) / 1000;
        console.log(`${done}/${queue.length} sessions, ${doneRecords} records, ${s.toFixed(0)}s, rss ${rss()}`);
      }
    }
  }),
);
const s = (performance.now() - t0) / 1000;
console.log(`wrote ${done} sessions, ${doneRecords} records in ${s.toFixed(0)}s`);
