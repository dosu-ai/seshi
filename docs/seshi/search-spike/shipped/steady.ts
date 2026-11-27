// The steady state of a built index, through the shipped `LanceIndex`:
//   commit <pages>  feed-shaped pages, each one owner's: 15 new sessions, 4 replaced, 1 removed
//                   and 30 continued by 20 records, as the spike's commit.ts. Each step of the
//                   two-step commit is timed (through LanceIndexOptions.beforeStep).
//   optimize        maintain() as the worker runs it after a pass, with optimizeEvery 0.
//   scrub           one page whose removal is a deletion (scrub: true), then maintain(), which
//                   rewrites events and sessions.
//   maintain        maintain() alone: the scrub again when one is still due (after a failed one).
// In scrub and maintain the scrub's index builds are timed (the private scalarIndexes() and
// textIndexes()), so a failure shows which step it was in.
// Run each in its own process (under /usr/bin/time -v) for its peak memory.
// Usage: bun steady.ts <uri> commit <pages> [--round N] | optimize | scrub | maintain
import { lanceIndex } from "@seshi/lance";
import type { IndexStore, PageCommit, SessionUpdate } from "@seshi/search";
import { DEPLOYMENT, EVENTS, type Generated, ms, OWNERS, ownerSessions, pct, rss, time } from "./data";

const [uri, mode, pagesArg] = process.argv.slice(2) as [string, string, string | undefined];
const roundFlag = process.argv.indexOf("--round");
const round = roundFlag < 0 ? 0 : Number(process.argv[roundFlag + 1]);
const now = Date.now();

let marks: [string, number][] = [];
const index = (await lanceIndex({
  uri,
  optimizeEvery: 0,
  beforeStep: (step: string) => {
    marks.push([step, performance.now()]);
  },
} as Parameters<typeof lanceIndex>[0])({ deployment: DEPLOYMENT, events: EVENTS, feed: true })) as IndexStore;
if (mode === "scrub" || mode === "maintain") {
  const proto = Object.getPrototypeOf(index) as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ["createTable", "scalarIndexes", "textIndexes"]) {
    const original = proto[name] as (...a: unknown[]) => Promise<unknown>;
    proto[name] = async function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      console.log(`  ${name} ${String(args[1])} start rss ${rss()}`);
      const table = args[0] as { createIndex?: (column: string, o: unknown) => Promise<unknown>; timed?: true };
      if (name !== "createTable" && table.createIndex && !table.timed) {
        table.timed = true;
        const create = table.createIndex.bind(table);
        table.createIndex = async (column: string, o: unknown) => {
          const c0 = performance.now();
          const out = await create(column, o);
          console.log(`    index ${column} ${ms(performance.now() - c0)} rss ${rss()}`);
          return out;
        };
      }
      const out = await original.apply(this, args);
      console.log(`  ${name} done ${ms(performance.now() - t0)} rss ${rss()}`);
      return out;
    };
  }
}
const gen = await index.generation();
console.log(`generation ${gen} ${JSON.stringify(await index.state())}`);

/** The first `n` sessions the build wrote for owner `o`, from the same generator. */
function built(o: number, n: number): Generated[] {
  const it = ownerSessions(o, { now, days: 120 });
  const out: Generated[] = [];
  for (let i = 0; i < n; i++) out.push(it.next().value as Generated);
  return out;
}

async function page(p: number, scrub: boolean) {
  const o = p % OWNERS;
  const owner = `u${o}`;
  // Each round of 50 pages takes the next 35 sessions of each owner.
  const r = Math.floor(p / OWNERS);
  const existing = built(o, 35 * (r + 1)).slice(35 * r);
  const held = await index.sessions(
    gen,
    owner,
    existing.map((g) => g.session.archive_id),
  );
  const fresh = ownerSessions(o, { now, days: 1, seed: 4242, first: 1_000_000 + p * 100 });
  const updates: SessionUpdate[] = [];
  const t = now + p;
  for (let i = 0; i < 15; i++) {
    const g = fresh.next().value as Generated;
    updates.push({ ...g, replace: true, read_at: t });
  }
  for (const target of existing.slice(0, 4)) {
    const g = fresh.next().value as Generated;
    const hash = `${(p * 100 + updates.length).toString(16).padStart(60, "0")}beef`;
    updates.push({
      session: { ...target.session, updated_at: new Date(now).toISOString(), traces: [hash] },
      events: g.events.map((e) => ({ ...e, content_hash: hash })),
      replace: true,
      read_at: t,
    });
  }
  const removal = existing[4] as Generated;
  for (const target of existing.slice(5, 35)) {
    const base = held.get(target.session.archive_id)?.traces;
    if (!base) continue;
    const g = fresh.next().value as Generated;
    const hash = `${(p * 100 + updates.length).toString(16).padStart(60, "0")}cafe`;
    updates.push({
      session: { ...target.session, updated_at: new Date(now).toISOString(), traces: [...base, hash] },
      events: g.events.slice(0, 20).map((e) => ({ ...e, content_hash: hash })),
      replace: false,
      base,
      read_at: t,
    });
  }
  const records = updates.reduce((n, u) => n + u.events.length, 0);
  const name = (i: number) => `${(now + p * 1000 + i).toString().padStart(16, "0")}-p${p}x${i}.json`;
  const commit: PageCommit = {
    generation: gen,
    owner,
    updates,
    removals: [{ archive: removal.session.archive_id, read_at: t, scrub }],
    feed: [],
    seen: updates.map((_, i) => ({ key: name(i), at: now })),
    cursor: name(updates.length),
    forgetBefore: now - 5 * 60_000,
  };
  marks = [];
  const t0 = performance.now();
  const [result, took] = await time(() => index.commit(commit));
  const steps: Record<string, number> = {};
  let last = t0;
  let lastName = "check";
  for (const [step, at] of marks) {
    steps[lastName] = at - last;
    last = at;
    lastName = step;
  }
  steps[lastName] = t0 + took - last;
  return { took, records, sessions: updates.length, held: held.size, result, steps };
}

if (mode === "commit") {
  const pages = Number(pagesArg ?? 10);
  const times: number[] = [];
  const stepTimes: Record<string, number[]> = {};
  for (let i = 0; i < pages; i++) {
    const p = round * OWNERS + i;
    const r = await page(p, false);
    times.push(r.took);
    for (const [k, v] of Object.entries(r.steps)) (stepTimes[k] ??= []).push(v);
    console.log(
      `page ${p} u${p % OWNERS}: ${r.sessions} sessions (${r.held} held), ${r.records} records, refused ${r.result.refused.length}, removed ${r.result.removed}: ${ms(r.took)} ${Object.entries(
        r.steps,
      )
        .map(([k, v]) => `${k} ${ms(v)}`)
        .join(", ")} rss ${rss()}`,
    );
  }
  console.log(`commit p50 ${ms(pct(times, 50))} p90 ${ms(pct(times, 90))} max ${ms(Math.max(...times))}`);
  for (const [k, v] of Object.entries(stepTimes)) {
    console.log(`  ${k}: p50 ${ms(pct(v, 50))} max ${ms(Math.max(...v))}`);
  }
} else if (mode === "optimize") {
  const [, took] = await time(() => index.maintain(new AbortController().signal));
  console.log(`maintain (optimize every table) ${(took / 1000).toFixed(1)}s rss ${rss()}`);
} else if (mode === "scrub") {
  const r = await page(OWNERS * 2, true);
  console.log(`scrub page: ${ms(r.took)}, removed ${r.result.removed}`);
  const [, took] = await time(() => index.maintain(new AbortController().signal));
  console.log(`maintain (scrub) ${(took / 1000).toFixed(1)}s rss ${rss()}`);
} else if (mode === "maintain") {
  const [, took] = await time(() => index.maintain(new AbortController().signal));
  console.log(`maintain ${(took / 1000).toFixed(1)}s rss ${rss()}`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
console.log(`state ${JSON.stringify(await index.state())}`);
await index.close();
