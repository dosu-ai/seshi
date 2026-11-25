// Phase 2 of session-tools.md: how long an index takes to build from the change feeds, and how
// big it is, for the old default (prompts, answers, tool calls) and for every role at the new
// caps. Synthetic sessions only, shaped like the production sample's aggregates (per-role
// counts and lengths, measure-roles.sql): no real text.
//
//   bun docs/seshi/session-tools-measure/rebuild.ts gen <dir> <records>
//   bun docs/seshi/session-tools-measure/rebuild.ts build <dir> sqlite|lance old|all
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { DEFAULT_SEARCH_MAX_CHARS, type EventRole } from "@seshi/model";
import { StoreSeshi } from "@seshi/pipeline";
import { Indexer, type IndexStore, SqliteIndex } from "@seshi/search";
import { FsStore } from "@seshi/store";
import { openLanceIndex } from "../../../packages/ts/search/lance/src/lance";

/** Mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(7);
const normal = () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
/** Log-normal with this median and sigma, capped. */
const lognormal = (median: number, sigma: number, cap: number) =>
  Math.min(cap, Math.max(1, Math.round(median * Math.exp(sigma * normal()))));

const SYLLABLES = "ka lo mi ne ro sa tu vi xe zo ba de fi gu hi jo".split(" ");
const VOCAB = Array.from({ length: 40_000 }, (_, i) => {
  let s = "";
  let n = i + 7;
  while (n > 0) {
    s += SYLLABLES[n % SYLLABLES.length];
    n = Math.floor(n / SYLLABLES.length);
  }
  return s;
});
/** Zipf(1.07) over the vocabulary, by inverse transform on a precomputed table. */
const CDF = (() => {
  const w = VOCAB.map((_, i) => 1 / (i + 1) ** 1.07);
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => (acc += x / total));
})();
function word(): string {
  const u = random();
  let lo = 0;
  let hi = CDF.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((CDF[mid] as number) < u) lo = mid + 1;
    else hi = mid;
  }
  return VOCAB[lo] as string;
}
function text(chars: number): string {
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    const w = random() < 0.08 ? `src/${word()}/${word()}.ts` : word();
    out.push(w);
    n += w.length + 1;
  }
  return out.join(" ").slice(0, chars);
}

// Lengths per role, from the sample's medians and tails (session-tools.md, phase 2). Tool output
// runs past the sample's 2,500-character cut as the local transcripts do: 24% above it.
const LENGTH: Record<string, () => number> = {
  user: () => lognormal(630, 1.6, 120_000),
  assistant: () => lognormal(210, 1.3, 50_000),
  reasoning: () => lognormal(260, 1.1, 50_000),
  tool_call: () => lognormal(350, 1.2, 20_000),
  tool_result: () => lognormal(700, 1.8, 160_000),
};

const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;

/** One session: turns of a prompt, then steps of reasoning, an answer with one tool call, and
 * its output. About 4.2 indexed records a step. */
function session(steps: number, start: number): { log: string; records: number } {
  let log = line({ role: "meta", source: "trajectory", cwd: "/work/app", git_branch: "main" });
  let at = start;
  const ts = () => new Date((at += 5_000)).toISOString();
  let records = 0;
  for (let s = 0; s < steps; s++) {
    if (s % 8 === 0) {
      log += line({ role: "user", content: text(LENGTH.user?.() ?? 1), timestamp: ts() });
      records++;
    }
    log += line({ role: "reasoning", content: text(LENGTH.reasoning?.() ?? 1), timestamp: ts() });
    const id = `c${s}`;
    log += line({
      role: "assistant",
      content: text(LENGTH.assistant?.() ?? 1),
      timestamp: ts(),
      tool_calls: [
        {
          id,
          name: random() < 0.6 ? "Bash" : "Read",
          args: JSON.stringify({ command: text(LENGTH.tool_call?.() ?? 1) }),
        },
      ],
    });
    log += line({
      role: "tool",
      tool_call_id: id,
      content: text(LENGTH.tool_result?.() ?? 1),
      timestamp: ts(),
    });
    records += 4;
  }
  return { log, records };
}

function du(path: string): string {
  return execSync(`du -sh ${JSON.stringify(path)}`).toString().split("\t")[0] as string;
}

async function gen(dir: string, target: number): Promise<void> {
  const store = new FsStore(join(dir, "bucket"));
  const formats = new FormatRegistry(BUILTIN_FORMATS);
  const owners = Array.from({ length: 14 }, (_, i) => `user${i}`);
  const clients = new Map(owners.map((o) => [o, new StoreSeshi({ store, owner: o, formats })]));
  let records = 0;
  let sessions = 0;
  const began = performance.now();
  while (records < target) {
    const owner = owners[sessions % owners.length] as string;
    const made = session(lognormal(25, 1.1, 1_500), Date.parse("2026-10-01") + sessions * 60_000);
    await clients
      .get(owner)
      ?.ingest({ format: "trajectory", session_id: `s${sessions}`, transcript: made.log });
    records += made.records;
    sessions++;
    if (sessions % 500 === 0) {
      console.log(`${sessions} sessions, ~${records} records, ${Math.round((performance.now() - began) / 1000)} s`);
    }
  }
  console.log(JSON.stringify({ sessions, records, bucket: du(join(dir, "bucket")) }));
}

const OLD: EventRole[] = ["user", "assistant", "tool_call"];
const ALL = Object.keys(DEFAULT_SEARCH_MAX_CHARS) as EventRole[];

async function build(dir: string, backend: string, roles: string): Promise<void> {
  const store = new FsStore(join(dir, "bucket"));
  const events = roles === "old" ? OLD : ALL;
  // The old default had one cap, 32 KiB, for every role.
  const maxChars =
    roles === "old"
      ? (Object.fromEntries(ALL.map((r) => [r, 32_768])) as Record<EventRole, number>)
      : DEFAULT_SEARCH_MAX_CHARS;
  const where = join(dir, `index-${backend}-${roles}${backend === "sqlite" ? ".sqlite" : ""}`);
  for (const p of [where, `${where}-wal`, `${where}-shm`]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  const options = { deployment: "bench", events, max_chars: maxChars };
  const index: IndexStore =
    backend === "sqlite"
      ? new SqliteIndex({ path: where, ...options })
      : await openLanceIndex({ uri: where, readConsistency: 0 }, options);
  const indexer = new Indexer({ store, index, events, maxChars, lagMs: 0 });
  const began = performance.now();
  const run = await indexer.catchUp();
  const seconds = (performance.now() - began) / 1000;
  const state = await index.state();
  await index.close();
  console.log(
    JSON.stringify({
      backend,
      roles,
      seconds: Math.round(seconds),
      sessions: state.sessions,
      records: state.events,
      ready: state.ready_at !== undefined,
      entries: run.entries,
      size: du(where),
    }),
  );
}

const [command, dir, a, b] = process.argv.slice(2);
if (command === "gen" && dir && a) await gen(dir, Number(a));
else if (command === "build" && dir && a && b) await build(dir, a, b);
else {
  console.error("usage: rebuild.ts gen <dir> <records> | build <dir> sqlite|lance old|all");
  process.exit(2);
}
