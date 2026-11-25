// Shared by the spike scripts: the events and sessions schemas from lancedb-search.md, a
// seeded generator of sessions shaped like the sample in its "Sizes" section, and timing.
import {
  Bool,
  Field,
  Float64,
  Int32,
  Int64,
  List,
  Schema,
  TimestampMillisecond,
  Utf8,
} from "apache-arrow";

const str = (name: string, nullable = false) => new Field(name, new Utf8(), nullable);
const strList = (name: string) =>
  new Field(name, new List(new Field("item", new Utf8(), true)), false);

export const EVENTS_SCHEMA = new Schema([
  str("id"),
  str("owner"),
  str("archive_id"),
  str("content_hash"),
  new Field("event_index", new Int32(), false),
  str("role"),
  str("tool_name", true),
  new Field("ts", new TimestampMillisecond(), true),
  str("text"),
  str("text_prefix"),
  str("format"),
  str("origin_agent", true),
  str("repo", true),
  str("branch", true),
  str("harness", true),
  str("agent_version", true),
  str("source_id", true),
  strList("models"),
  strList("labels"),
  str("visibility"),
  new Field("session_updated", new TimestampMillisecond(), false),
]);

export const SESSIONS_SCHEMA = new Schema([
  str("id"),
  str("owner"),
  str("archive_id"),
  str("format"),
  str("session_id"),
  str("repo", true),
  str("branch", true),
  str("visibility"),
  strList("models"),
  str("labels"),
  new Field("updated_ms", new Int64(), false),
  strList("traces"),
  new Field("read_at", new Int64(), false),
  new Field("removed", new Bool(), false),
  new Field("records", new Float64(), false),
]);

/** Mulberry32: small, fast, seeded. */
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

// A vocabulary with a Zipf-like frequency: English-ish words, code identifiers, paths. The
// words the benchmark queries for are placed at known ranks.
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
export const PLACED: Record<number, string> = {
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
export const WORDS: string[] = Array.from({ length: VOCAB }, (_, i) => PLACED[i] ?? makeWord(i));

/** One million draws from Zipf(1.07) over the vocabulary; a draw is then one array lookup. */
function zipfTable(r: () => number): Uint16Array {
  const weights = WORDS.map((_, i) => 1 / (i + 1) ** 1.07);
  const total = weights.reduce((a, b) => a + b, 0);
  const table = new Uint16Array(1_000_000);
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

export interface GenOptions {
  seed: number;
  owners: number;
  /** Sessions end within this many days before `now`. */
  days: number;
  now: number;
}

export type EventRow = Record<string, unknown>;
export type SessionRow = Record<string, unknown>;

/** Sessions shaped like the sample: records per session log-normal with median 37 and p90
 * about 194, capped at 16,000; about 900 characters per record on average. */
export function* sessions(
  o: GenOptions,
  start = 0,
): Generator<{ session: SessionRow; events: EventRow[] }> {
  const r = rng(o.seed + start * 7919);
  const zipf = zipfTable(rng(o.seed));
  const word = () => WORDS[zipf[Math.floor(r() * zipf.length)]];
  const words = (n: number) => {
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i] = word();
    return out.join(" ");
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  for (let s = start; ; s++) {
    const owner = `u${Math.floor(r() * o.owners)}`;
    const archive = `a${s.toString(36)}`;
    let f = r();
    let format = FORMATS[0][0];
    for (const [name, p] of FORMATS) {
      if ((f -= p) <= 0) {
        format = name;
        break;
      }
    }
    const visibility = r() < 0.85 ? "org" : "owner";
    const repo = REPOS[Math.floor(r() * REPOS.length)];
    const branch = r() < 0.4 ? "main" : `feat/${word()}`;
    const models = r() < 0.3 ? [MODELS[0], MODELS[1]] : [MODELS[Math.floor(r() * MODELS.length)]];
    const labels = r() < 0.2 ? ["team=core", "dosu.project=app"] : ["team=core"];
    const updated = o.now - Math.floor(r() * o.days * 86_400_000);
    const count = Math.min(16_000, Math.max(1, Math.round(Math.exp(3.61 + 1.29 * normal()))));
    const hash = `h${s.toString(36)}`;
    const events: EventRow[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const roll = r();
      const role = roll < 0.15 ? "user" : roll < 0.55 ? "assistant" : "tool_call";
      const tool = role === "tool_call" ? TOOLS[Math.floor(r() * TOOLS.length)] : null;
      let text =
        role === "assistant"
          ? words(110 + Math.floor(r() * 300))
          : role === "user"
            ? words(30 + Math.floor(r() * 150))
            : `${tool} {"command":"${words(4)}","file_path":"src/${word()}/${word()}.ts"} ${words(45 + Math.floor(r() * 80))}`;
      if (r() < 0.005) text += " the flaky checkout test failed again";
      if (r() < 0.00001) text += " zeppelinx";
      events[i] = {
        id: `${owner}/${archive}/${hash}/${i}`,
        owner,
        archive_id: archive,
        content_hash: hash,
        event_index: i,
        role,
        tool_name: tool,
        ts: new Date(updated - (count - i) * 20_000),
        text,
        text_prefix: text,
        format,
        origin_agent: null,
        repo,
        branch,
        harness: format,
        agent_version: "2.1.0",
        source_id: "upload",
        models,
        labels,
        visibility,
        session_updated: new Date(updated),
      };
    }
    yield {
      events,
      session: {
        id: `${owner}/${archive}`,
        owner,
        archive_id: archive,
        format,
        session_id: archive,
        repo,
        branch,
        visibility,
        models,
        labels: JSON.stringify(Object.fromEntries(labels.map((l) => l.split("=")))),
        updated_ms: BigInt(updated),
        traces: [hash],
        read_at: BigInt(updated),
        removed: false,
        records: count,
      },
    };
  }
}

export function storageOptions(): Record<string, string> | undefined {
  // On GCE, LanceDB's object store reads credentials from the metadata server.
  return undefined;
}

export async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

export function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export const ms = (x: number) => `${x.toFixed(0)}ms`;
