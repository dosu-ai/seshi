/** Generated scenarios (33): valid step lists from a seed, in the format of
 * tests/scenarios/README.md, for the explorer (`explore.ts`) to run and shrink.
 *
 * fast-check draws a *plan*: a setup choice and a list of abstract choices, each a weighted step
 * kind and four small numbers. `buildScenario` turns a plan into steps, deterministically, by
 * walking the choices with a model of what exists so far (sessions, subagents and their parents,
 * armed faults, a rule change not yet backfilled) and refusing what is invalid by construction:
 * a choice that needs a session when none exists yields nothing, a `backfill` with a store fault
 * armed is preceded by a `heal`, a `shrink` compaction is only made where it really shortens the
 * transcript. The scenario always ends with a `heal` (when anything is armed), a `backfill`
 * (after a rule change) and a `settle`, so the quiet checks run. Because validity is enforced
 * here and not in the arbitraries, every plan fast-check shrinks to (fewer choices, smaller
 * numbers) is still a valid scenario: index 0 of every option list is the plainest choice, so
 * numbers shrinking toward 0 make the steps plainer too. The raw steps go through
 * `parseScenario`, so a generated scenario passes the same validator a hand-written one does. */

import fc from "fast-check";
import { parseScenario, type Scenario } from "./schema";

/** The abstract step kinds, with their weights: the interesting ones (turns, passes, faults)
 * come up most. Kinds that need something missing (a session, server mode, review) yield
 * nothing, so the effective mix depends on the setup. */
export const WEIGHTS = {
  turns: 20,
  subagent: 5,
  compact: 3,
  move: 2,
  hook: 2,
  pass: 18,
  off: 4,
  on: 4,
  pause: 3,
  resume: 2,
  resend: 3,
  path: 1,
  clock: 7,
  restart: 3,
  rules: 2,
  bump: 2,
  backfill: 2,
  sweep: 2,
  review: 5,
  http: 9,
  store: 6,
  heal: 3,
  settle: 2,
} as const;
export type ChoiceKind = keyof typeof WEIGHTS;

export interface Choice {
  kind: ChoiceKind;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface SetupChoice {
  /** 85 or more of 100: local mode (so a shrink, toward 0, prefers server mode). */
  mode: number;
  /** Main sessions, 1 to 3. */
  sessions: number;
  /** 0–2: no review; 3: review, on_failure drop; 4: on_failure skip. */
  review: number;
  /** 4: `default_visibility = "owner"`. */
  visibility: number;
  /** 3: a repo `code/private` with `capture = false`. */
  privateRepo: number;
  /** The uploader's seeded random. */
  seed: number;
}

export interface Plan {
  setup: SetupChoice;
  choices: Choice[];
}

const small = fc.integer({ min: 0, max: 99 });

const kindArb: fc.Arbitrary<ChoiceKind> = fc.oneof(
  ...(Object.entries(WEIGHTS) as [ChoiceKind, number][]).map(([kind, weight]) => ({
    arbitrary: fc.constant(kind),
    weight,
  })),
);

const choiceArb: fc.Arbitrary<Choice> = fc.record({
  kind: kindArb,
  a: small,
  b: small,
  c: small,
  d: small,
});

const setupArb: fc.Arbitrary<SetupChoice> = fc.record({
  mode: small,
  sessions: fc.integer({ min: 1, max: 3 }),
  review: fc.integer({ min: 0, max: 4 }),
  visibility: fc.integer({ min: 0, max: 4 }),
  privateRepo: fc.integer({ min: 0, max: 3 }),
  seed: fc.integer({ min: 1, max: 1000 }),
});

/** Plans of at most `maxSteps` choices (the closing heal, backfill and settle come on top, and a
 * move brings its turns, so a scenario can run a few steps longer). */
export function planArb(maxSteps: number): fc.Arbitrary<Plan> {
  return fc.record({
    setup: setupArb,
    choices: fc.array(choiceArb, { minLength: 1, maxLength: Math.max(1, maxSteps), size: "max" }),
  });
}

const MAIN = ["main", "a", "b"] as const;
const SUBS = ["x", "y"] as const;
const CLOCK = ["+1m", "+5m", "+30m", "+2h", "+1d"] as const;
const PATTERNS = ["typed constant", "module \\d+", "ACME-\\d{4}", "Reading module"] as const;
const ANSWERS = ["allow", "redact", "drop", "fail"] as const;
const HOOKS = ["SessionStart", "SessionEnd", "PreCompact", "Stop"] as const;
const PRIVATE = "code/private";

type Raw = string | Record<string, unknown>;

const pick = <T>(list: readonly T[], n: number): T => list[n % list.length] as T;

/** What the steps so far have made: the preconditions a choice is checked against. */
class Model {
  readonly steps: Raw[] = [];
  /** Main sessions that exist (had a turns step), and their turns. */
  readonly turns = new Map<string, number>();
  /** Main sessions compacted at least once (a later `shrink` would cut through a summary). */
  readonly compacted = new Set<string>();
  /** Subagent id → its parent, fixed by its first turns. */
  readonly subs = new Map<string, string>();
  /** Main sessions that ran in the repo whose config says `capture = false`. */
  readonly ranPrivate = new Set<string>();
  /** A pause, `off` or a path rule came before: some session may not be uploaded by a pass. */
  controlled = false;
  httpArmed = 0;
  storeArmed = 0;
  /** A rule change not yet followed by a backfill: the doctor rightly fails `residue` on
   * sessions not sent again until one runs (32, Observations). */
  rulesDirty = false;
  ruleCount = 0;
  markCount = 0;

  constructor(
    readonly server: boolean,
    readonly review: boolean,
    readonly names: readonly string[],
    readonly privateRepo: boolean,
  ) {}

  push(step: Raw): void {
    this.steps.push(step);
  }

  existing(n: number): string | undefined {
    const live = this.names.filter((name) => this.turns.has(name));
    return live.length === 0 ? undefined : pick(live, n);
  }

  /** Any session that exists, subagents included (for capture commands). */
  anySession(n: number): string | undefined {
    const live = [
      ...this.names.filter((name) => this.turns.has(name)),
      ...[...this.subs.keys()].map((id) => `agent-${id}`),
    ];
    return live.length === 0 ? undefined : pick(live, n);
  }

  heal(): void {
    if (this.httpArmed + this.storeArmed === 0) return;
    this.push("heal");
    this.httpArmed = 0;
    this.storeArmed = 0;
  }

  /** The bucket is written by the backfill and the sweep themselves: a store fault armed would
   * fail them, which the runner treats as the step failing, not as a finding. */
  healStore(): void {
    if (this.storeArmed > 0) this.heal();
  }

  backfill(): void {
    this.healStore();
    this.push("backfill");
    this.rulesDirty = false;
  }

  /** What every settle needs first: no fault armed, and no rule change left un-backfilled. */
  beforeSettle(): void {
    this.heal();
    if (this.rulesDirty) this.backfill();
  }

  mark(): string {
    this.markCount++;
    return `m${this.markCount}`;
  }
}

function choose(m: Model, ch: Choice): void {
  const { a, b, c, d } = ch;
  switch (ch.kind) {
    case "turns": {
      const session = pick(m.names, a);
      const step: Record<string, unknown> = { session, count: pick([2, 1, 3], b) };
      const extra = c % 10;
      if (extra === 7 || extra === 9) step.secret = true;
      if (extra === 8 || extra === 9) step.mark = m.mark();
      const where = d % 10;
      if (where === 6) step.hook = "none";
      if (where === 7) step.hook = "SessionEnd";
      if (where === 8) step.in = "code/other";
      if (where === 9) step.in = m.privateRepo ? PRIVATE : "code/other";
      if (step.in === PRIVATE) m.ranPrivate.add(session);
      m.push({ turns: step });
      m.turns.set(session, (m.turns.get(session) ?? 0) + (step.count as number));
      return;
    }
    case "subagent": {
      const id = pick(SUBS, b);
      const parent = m.subs.get(id) ?? m.existing(a);
      if (!parent) return;
      const step: Record<string, unknown> = { parent, id, turns: pick([2, 1, 3], c) };
      if (d % 7 === 1) step.secret = true;
      if (d % 7 === 2) step.mark = m.mark();
      if (d % 5 === 4) step.hook = false;
      m.push({ subagent: step });
      m.subs.set(id, parent);
      return;
    }
    case "compact": {
      const session = m.existing(a);
      if (!session) return;
      const turns = m.turns.get(session) ?? 0;
      const keep = pick([1, 0, 2], c);
      // A shrink keeps a prefix of whole turns and adds a summary shorter than a turn, so the
      // file ends shorter than any upload past that prefix (the uploader sees a rewrite) or
      // extends it (an append). Through an earlier summary, keeping it all, or growing again
      // before a pass has sent it, it would be the in-place rewrite that leaves the transcript
      // longer, which build note 32 records as undetected by design (Observations: transcripts
      // are append-only for every agent captured today). So a shrink is settled at once (the
      // uploader sends it whole), and only for a session every pass uploads: no pause, `off` or
      // path rule before, never in the repo that turns capture off.
      const plain = !m.controlled && !m.ranPrivate.has(session);
      if (b % 3 === 2 && !m.compacted.has(session) && keep < turns && plain) {
        m.push({ compact: { session, mode: "shrink", keep } });
        m.turns.set(session, keep);
        m.beforeSettle();
        m.push("settle");
      } else {
        m.push({ compact: { session } });
      }
      m.compacted.add(session);
      return;
    }
    case "move": {
      const session = m.existing(a);
      if (!session) return;
      const step: Record<string, unknown> = { session, to: pick(["code/moved", "code/other"], b) };
      if (c % 2 === 1) step.hook = "none";
      m.push({ "move-transcript": step });
      // A moved transcript goes whole only once it has new bytes (README).
      m.push({ turns: { session, count: 1 } });
      m.turns.set(session, (m.turns.get(session) ?? 0) + 1);
      return;
    }
    case "hook": {
      const session = m.existing(a);
      if (!session) return;
      m.push({ hook: { session, event: pick(HOOKS, b) } });
      return;
    }
    case "pass":
      m.push(c % 5 === 4 ? { pass: { sweep: false } } : "pass");
      return;
    case "off":
    case "on": {
      const session = d % 4 === 3 ? m.anySession(a) : m.existing(a);
      if (!session) return;
      m.push({ capture: `${ch.kind} --session ${session}` });
      if (ch.kind === "off") m.controlled = true;
      return;
    }
    case "pause":
      m.push({ capture: pick(["pause 2h", "pause", "pause 30m"], b) });
      m.controlled = true;
      return;
    case "resume":
      m.push({ capture: "resume" });
      return;
    case "resend":
      // `--all` always exits 0; `--session` exits 4 or 9 depending on what the uploader did,
      // which the generator cannot know ahead.
      m.push({ capture: "resend --all" });
      return;
    case "path":
      m.push({ capture: pick(["off --path code/other", "on --path code/other", "off", "on"], b) });
      m.controlled = true;
      return;
    case "clock":
      m.push({ clock: pick(CLOCK, b) });
      return;
    case "restart":
      m.push("restart-server");
      return;
    case "rules": {
      m.ruleCount++;
      const rule = { id: `r${m.ruleCount}`, pattern: pick(PATTERNS, c) };
      m.push({ rules: b % 4 === 3 ? { set: [rule] } : { add: [rule] } });
      m.rulesDirty = true;
      return;
    }
    case "bump":
      m.push({ "format-bump": "claude-code" });
      return;
    case "backfill":
      m.backfill();
      return;
    case "sweep":
      m.healStore();
      m.push("sweep");
      return;
    case "review": {
      if (!m.review) return;
      const n = 1 + (b % 3);
      const x = c * 100 + d;
      const answers = Array.from({ length: n }, (_, i) => pick(ANSWERS, Math.floor(x / 4 ** i)));
      m.push({ review: answers });
      return;
    }
    case "http": {
      if (!m.server) return;
      const path = b % 10;
      const http =
        path < 7
          ? "POST /v1/sessions"
          : path < 9
            ? "DELETE /v1/sessions/*"
            : "GET /v1/sessions/stale";
      const fault: Record<string, unknown> = { http };
      // No injected `409 conflict`: a server answers it to a whole log that no longer extends
      // what it holds, and the uploader then replaces only a session it stored itself; for any
      // other it is a permanent refusal by design (uploader.ts, X4.6: another machine's
      // session), which the doctor rightly reports. Injected blind, it lands on first uploads
      // and chunks, where it can only be a lie or another machine; the real conflict path is
      // reached through `rules` and a whole resend (a move, a shrink, `expected: 0`).
      const action = c % 11;
      const post = http === "POST /v1/sessions";
      if (action <= 3 || action === 10 || (!post && (action === 8 || action === 9))) {
        fault.status = pick([503, 500, 502, 429], action);
      } else if (action === 4) fault["drop-response"] = true;
      else if (action === 5) fault.reset = true;
      else if (action === 6) fault.latency = "2s";
      else if (action === 7) fault.latency = "5m";
      else {
        // The two answers a server can give that do not depend on what it holds: nothing here
        // (expected 0), or more than this transcript has (a length it cannot map back). Both
        // send the whole log again (uploader.ts, 409 offset_mismatch).
        fault.status = 409;
        fault.code = "offset_mismatch";
        fault.expected = action === 8 ? 0 : 99_999_999;
      }
      const t = d % 4;
      if (t === 1) fault.times = 2;
      if (t === 2) fault.times = "always";
      if (t === 3) fault.nth = 2;
      m.push({ fault });
      m.httpArmed++;
      return;
    }
    case "store": {
      const del = b % 4 === 3;
      const key = del
        ? pick(["owners/*/sessions/*/trace.*", "owners/*/sessions/*/metadata.json"], c)
        : pick(
            [
              "owners/*/sessions/*/metadata.json",
              "owners/*/changes/*",
              "owners/*/sessions/*/trace.*",
            ],
            c,
          );
      const fault: Record<string, unknown> = { store: del ? "delete" : "put", key };
      const after = d % 3 === 1;
      if (after) fault.after = true;
      // `PreconditionFailed` before the write is what a store says to a compare-and-swap that
      // lost a race: of these keys only the pointer is written that way. Trace objects and
      // change entries are put only if absent (publish.ts, json.ts); refused before they land
      // would be a store saying "it exists" of something missing. After the write (a retried
      // request that already landed) it is true of every put. Deletes here are unconditional.
      if (!del && d % 4 === 3 && (after || key.endsWith("metadata.json"))) {
        fault.error = "precondition";
      }
      if (Math.floor(d / 4) % 3 === 2) fault.times = 2;
      m.push({ fault });
      m.storeArmed++;
      return;
    }
    case "heal":
      m.heal();
      return;
    case "settle":
      m.beforeSettle();
      m.push("settle");
      return;
  }
}

export interface Generated {
  /** The scenario as YAML-shaped data: `{ name, description, setup?, steps }`. */
  raw: Record<string, unknown>;
  scenario: Scenario;
}

/** The scenario a plan makes. `label` names it in messages (`generated:<seed>`). */
export function buildScenario(plan: Plan, label: string): Generated {
  const s = plan.setup;
  const server = s.mode < 85;
  const review = s.review >= 3;
  const privateRepo = s.privateRepo === 3;
  const setup: Record<string, unknown> = {};
  if (!server) setup.mode = "local";
  if (review) setup.review = s.review === 3 ? true : { on_failure: "skip" };
  if (privateRepo) setup.repos = { [PRIVATE]: { config: "capture = false\n" } };
  if (s.visibility === 4) setup.server = 'default_visibility = "owner"\n';
  if (s.seed !== 1) setup.seed = s.seed;
  const m = new Model(server, review, MAIN.slice(0, s.sessions), privateRepo);
  for (const choice of plan.choices) choose(m, choice);
  m.beforeSettle();
  m.push("settle");
  const raw: Record<string, unknown> = {
    name: `generated ${label}`,
    description: `Generated by tests/tooling/scenario/generate.ts (${label}).`,
    ...(Object.keys(setup).length > 0 ? { setup } : {}),
    steps: m.steps,
  };
  return { raw, scenario: parseScenario(label, raw) };
}

// --- YAML ---------------------------------------------------------------------------------

const PLAIN = /^[A-Za-z_+][\w./+ -]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

/** A scalar as plain YAML when it reads back as the same string, else double-quoted (JSON's
 * escapes are YAML's). */
function scalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  if (PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(" ") && !s.includes(" #")) return s;
  return JSON.stringify(s);
}

function flow(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flow).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([k, v]) => `${scalar(k)}: ${flow(v)}`);
    return `{ ${entries.join(", ")} }`;
  }
  return scalar(value);
}

/** A generated scenario as YAML in the style of the hand-written ones: one line per step. */
export function toYaml(raw: Record<string, unknown>): string {
  const lines = [`name: ${scalar(raw.name)}`, `description: ${scalar(raw.description)}`];
  if (raw.guards) lines.push(`guards: ${scalar(raw.guards)}`);
  if (raw.setup) lines.push(`setup: ${flow(raw.setup)}`);
  lines.push("steps:");
  for (const step of raw.steps as Raw[]) {
    if (typeof step === "string") lines.push(`  - ${step}`);
    else {
      const [kind, body] = Object.entries(step)[0] as [string, unknown];
      lines.push(`  - ${kind}: ${flow(body)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
