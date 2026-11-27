// A first build through the shipped `LanceIndex`: one owner's sessions gathered into commits of
// at least 50,000 records (what `Indexer` does while `batchRecords()` asks for it), with the
// build-time `optimize()` every 100,000 rows that `commit()` runs, then `passDone()`, which
// builds the full-text indexes. Prints each commit, each optimize and the index build.
// Usage: bun build.ts <uri> <records>
import { lanceIndex } from "@seshi/lance";
import type { IndexStore, PageCommit, SessionUpdate } from "@seshi/search";
import { DEPLOYMENT, EVENTS, ms, OWNERS, ownerSessions, rss, time } from "./data";

const [uri, recordsArg] = process.argv.slice(2);
if (!uri || !recordsArg) throw new Error("usage: bun build.ts <uri> <records>");
const records = Number(recordsArg);
const now = Date.now();

const index = (await lanceIndex({ uri })({
  deployment: DEPLOYMENT,
  events: EVENTS,
  feed: true,
})) as IndexStore & {
  batchRecords(gen: string): Promise<number>;
};

// Time what commit() and passDone() do inside: the private optimize() and textIndexes().
const proto = Object.getPrototypeOf(index) as Record<string, (...a: unknown[]) => Promise<unknown>>;
const timed = { optimize: [] as number[], textIndexes: [] as number[] };
for (const name of ["optimize", "textIndexes"] as const) {
  const original = proto[name] as (...a: unknown[]) => Promise<unknown>;
  proto[name] = async function (this: unknown, ...args: unknown[]) {
    const t0 = performance.now();
    const out = await original.apply(this, args);
    const took = performance.now() - t0;
    timed[name].push(took);
    console.log(`  ${name} ${ms(took)} rss ${rss()}`);
    return out;
  };
}

const gen = await index.generation();
const batch = await index.batchRecords(gen);
console.log(`generation ${gen}, batchRecords ${batch}, target ${records} records`);
const perOwner = Math.ceil(records / OWNERS);
const t0 = performance.now();
let total = 0;
let sessions = 0;
let commits = 0;
const commitTimes: number[] = [];
let stamp = 0;
for (let o = 0; o < OWNERS && total < records; o++) {
  const owner = `u${o}`;
  const it = ownerSessions(o, { now, days: 120 });
  let ownerRecords = 0;
  while (ownerRecords < perOwner && total < records) {
    const updates: SessionUpdate[] = [];
    const feed: PageCommit["feed"] = [];
    const seen: PageCommit["seen"] = [];
    let weight = 0;
    while (weight < batch && ownerRecords < perOwner && total < records) {
      const { session, events } = it.next().value as ReturnType<typeof it.next>["value"] & {};
      const name = `${(now + stamp++).toString().padStart(16, "0")}-${session.archive_id}.json`;
      updates.push({ session, events, replace: true, read_at: now });
      feed.push({
        name,
        entry: {
          v: 1,
          kind: "published",
          format: session.format,
          session_id: session.session_id,
          archive_id: session.archive_id,
          content_hash: session.traces[0] as string,
          at: session.updated_at,
        } as unknown as PageCommit["feed"][number]["entry"],
      });
      seen.push({ key: name, at: now });
      weight += 1 + events.length;
      ownerRecords += events.length;
      total += events.length;
      sessions++;
    }
    const [result, took] = await time(() =>
      index.commit({
        generation: gen,
        owner,
        updates,
        removals: [],
        feed,
        seen,
        cursor: (feed.at(-1) as { name: string }).name,
        forgetBefore: now - 5 * 60_000,
      }),
    );
    commits++;
    commitTimes.push(took);
    if (result.stale || result.refused.length > 0) throw new Error(JSON.stringify(result));
    const elapsed = (performance.now() - t0) / 1000;
    console.log(
      `commit ${commits} ${owner} sessions ${updates.length} records ${weight} took ${ms(took)} total ${total} at ${elapsed.toFixed(0)}s (${(total / elapsed).toFixed(0)}/s) rss ${rss()}`,
    );
  }
}
const written = (performance.now() - t0) / 1000;
await index.readThrough(gen, new Date(now).toISOString());
const [, done] = await time(() => index.passDone(gen, new Date().toISOString()));
const totalS = (performance.now() - t0) / 1000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / 1000;
console.log(
  [
    `records ${total}, sessions ${sessions}, commits ${commits}`,
    `commits (incl. build-time optimize) ${written.toFixed(0)}s = ${(total / written).toFixed(0)} records/s`,
    `build-time optimize: ${timed.optimize.length} runs, ${sum(timed.optimize).toFixed(0)}s total, last ${ms(timed.optimize.at(-1) ?? 0)}`,
    `commit time without optimize: ${(sum(commitTimes) - sum(timed.optimize)).toFixed(0)}s`,
    `passDone (full-text indexes) ${(done / 1000).toFixed(0)}s; text indexes ${timed.textIndexes.map(ms).join(", ")}`,
    `total ${totalS.toFixed(0)}s = ${(totalS / 60).toFixed(1)} min, ${(total / totalS).toFixed(0)} records/s`,
    `state ${JSON.stringify(await index.state())}`,
  ].join("\n"),
);
await index.close();
