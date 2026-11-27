// The spike's synthetic sessions (../common.ts), emitted as what the shipped code takes:
// `IndexedSession` and `IndexedEvent`, one owner at a time, because a commit is one owner's.
// Same vocabulary, Zipf(1.07) frequencies, record counts, roles, placed query words and rare
// markers as the spike, so the numbers compare. ../common.ts imports apache-arrow, which the
// workspace does not hoist to its root, so the generator is repeated here without it.
import type { IndexedEvent, IndexedSession } from "@seshi/search";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = "ka lo mi ne ro sa tu vi xe zo ba de fi gu hi jo".split(" ");
function makeWord(i: number): string {
  let s = "";
  let n = i + 7;
  while (n > 0) {
    s += SYLLABLES[n % SYLLABLES.length];
    n = Math.floor(n / SYLLABLES.length);
  }
  return s;
}
const PLACED: Record<number, string> = {
  3: "the",
  5: "file",
  9: "error",
  14: "test",
  40: "deploy",
  70: "staging",
  120: "deployment",
  400: "deployer",
  800: "checkout",
  1200: "flaky",
  2500: "rollback",
  6000: "deploys",
};
const VOCAB = 40_000;
const WORDS: string[] = Array.from({ length: VOCAB }, (_, i) => PLACED[i] ?? makeWord(i));

let table: Uint16Array | undefined;
function zipfTable(): Uint16Array {
  if (table) return table;
  const r = rng(42);
  const weights = WORDS.map((_, i) => 1 / (i + 1) ** 1.07);
  const total = weights.reduce((a, b) => a + b, 0);
  table = new Uint16Array(1_000_000);
  let k = 0;
  for (let i = 0; i < VOCAB && k < table.length; i++) {
    const n = Math.round((weights[i] / total) * table.length);
    for (let j = 0; j < n && k < table.length; j++) table[k++] = i;
  }
  while (k < table.length) table[k++] = Math.floor(r() * VOCAB);
  return table;
}

const REPOS = Array.from({ length: 30 }, (_, i) => `github.com/acme/${makeWord(i * 13)}`);
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "Task"];
const FORMATS: [string, number][] = [
  ["claude-code", 0.72],
  ["codex", 0.17],
  ["cursor", 0.04],
  ["vcs:checkout", 0.05],
  ["pi", 0.02],
];
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.2", "gemini-3"];

export interface Generated {
  session: IndexedSession;
  events: IndexedEvent[];
}

/** One owner's sessions, forever. Archive ids are unique across owners. */
export function* ownerSessions(
  owner: number,
  options: { now: number; days: number; seed?: number; first?: number },
): Generator<Generated> {
  const r = rng((options.seed ?? 42) + owner * 7919);
  const zipf = zipfTable();
  const word = () => WORDS[zipf[Math.floor(r() * zipf.length)]] as string;
  const words = (n: number) => {
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i] = word();
    return out.join(" ");
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const name = `u${owner}`;
  for (let s = options.first ?? 0; ; s++) {
    const archive = `a${owner.toString(36)}x${s.toString(36)}`;
    let f = r();
    let format = FORMATS[0]?.[0] as string;
    for (const [fmt, p] of FORMATS) {
      if ((f -= p) <= 0) {
        format = fmt;
        break;
      }
    }
    const visibility = r() < 0.85 ? "org" : "owner";
    const repo = REPOS[Math.floor(r() * REPOS.length)] as string;
    const branch = r() < 0.4 ? "main" : `feat/${word()}`;
    const models =
      r() < 0.3
        ? [MODELS[0] as string, MODELS[1] as string]
        : [MODELS[Math.floor(r() * MODELS.length)] as string];
    const labels: Record<string, string> =
      r() < 0.2 ? { team: "core", "dosu.project": "app" } : { team: "core" };
    const updated = options.now - Math.floor(r() * options.days * 86_400_000);
    const count = Math.min(16_000, Math.max(1, Math.round(Math.exp(3.61 + 1.29 * normal()))));
    const hash = (s * 1_000 + owner).toString(16).padStart(64, "0");
    const events: IndexedEvent[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const roll = r();
      const role = roll < 0.15 ? "user" : roll < 0.55 ? "assistant" : "tool_call";
      const tool = role === "tool_call" ? (TOOLS[Math.floor(r() * TOOLS.length)] as string) : null;
      let text =
        role === "assistant"
          ? words(110 + Math.floor(r() * 300))
          : role === "user"
            ? words(30 + Math.floor(r() * 150))
            : `${tool} {"command":"${words(4)}","file_path":"src/${word()}/${word()}.ts"} ${words(45 + Math.floor(r() * 80))}`;
      if (r() < 0.005) text += " the flaky checkout test failed again";
      if (r() < 0.00001) text += " zeppelinx";
      events[i] = {
        content_hash: hash,
        event_index: i,
        role,
        ...(tool ? { tool_name: tool } : {}),
        timestamp: updated - (count - i) * 20_000,
        text,
      };
    }
    yield {
      events,
      session: {
        owner: name,
        archive_id: archive,
        format,
        session_id: archive,
        branch,
        repo,
        harness: format,
        agent_version: "2.1.0",
        models,
        labels,
        source_id: "upload",
        visibility,
        started_at: updated - count * 20_000,
        ended_at: updated,
        updated_at: new Date(updated).toISOString(),
        traces: [hash],
      },
    };
  }
}

/** More words from the same distribution, for continuations. */
export function wordsFor(seed: number): (n: number) => string {
  const r = rng(seed);
  const zipf = zipfTable();
  return (n) => {
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i] = WORDS[zipf[Math.floor(r() * zipf.length)]] as string;
    return out.join(" ");
  };
}

export const OWNERS = 50;

export async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

export function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
}

export const ms = (x: number) => `${x.toFixed(0)}ms`;
export const rss = () => `${(process.memoryUsage().rss / 2 ** 30).toFixed(1)}GB`;
export const EVENTS = ["user", "assistant", "tool_call"] as const;
export const DEPLOYMENT = "bench";
