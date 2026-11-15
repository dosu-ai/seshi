/** The process-mode scenario format: the in-process format (tests/scenarios/README.md) with
 * `setup.mode: process`, the steps that mean the same out of process, and steps only real
 * processes need (a fault proxy on the wire, background work, long-running daemons, kills).
 * Steps shared with the in-process runner are checked by its own validator, so they take the
 * same fields and fail with the same messages; steps that cannot work out of process (`clock`,
 * store faults, the fake reviewer, server parts swapped in-process) fail here, before anything
 * runs, saying why. */

import { parseDuration } from "@seshi/config";
import {
  type Expect,
  parseScenario,
  ScenarioError,
  type Step as SharedStepAny,
} from "../scenario/schema";

export { ScenarioError };

/** In-process steps that work out of process unchanged. */
export const SHARED_KINDS = [
  "turns",
  "subagent",
  "compact",
  "move-transcript",
  "hook",
  "pass",
  "capture",
  "restart-server",
  "heal",
  "expect",
  "settle",
] as const;

/** Steps only process mode has. */
export const PROCESS_KINDS = [
  "fault",
  "background",
  "join",
  "await",
  "daemon",
  "stop",
  "kill",
  "wait",
] as const;

/** In-process steps refused here, and why. */
const REFUSED: Record<string, string> = {
  clock:
    "no time travel out of process: production code gets no test hooks; use 'wait' for real time",
  review: "the fake reviewer lives in the in-process server; a real seshi serve has none",
  rules: "org rules are swapped into the in-process server; not available in process mode",
  "format-bump": "a format bump swaps the in-process server's registry; not available here",
  sweep: "the orphan sweep is run in-process; not available in process mode",
  backfill: "the backfill is run in-process; not available in process mode",
};

type SharedKind = (typeof SHARED_KINDS)[number];
export type SharedStep = Extract<SharedStepAny, { kind: SharedKind }>;

export type ProxyFault = {
  http: string;
  nth: number;
  times: number | "always";
  action:
    | { kind: "delay"; ms: number }
    | { kind: "close-request"; bytes: number }
    | { kind: "close-response"; bytes: number }
    | { kind: "status"; status: number; code?: string; expected?: number }
    | { kind: "drop-response" }
    | { kind: "kill-client"; bytes: number | "all" }
    | { kind: "kill-server"; bytes: number | "all" };
};

/** What `expect` can say of a named background run or daemon. */
export interface RunFacts {
  /** It took the uploader lock (a `daemon --once` that found one held says so and exits). */
  started?: boolean;
  /** This harness killed it (a kill rule, a `kill` step). */
  killed?: boolean;
  code?: number;
  /** Pass summary fields (`uploaded`, `failed`, …), for a background pass. */
  pass?: Record<string, number>;
}

export interface ProcessExpect extends Expect {
  /** Requests the proxy saw over the whole run, by `"<METHOD> <path glob>"`. */
  requests?: Record<string, number>;
  /** How many of the named passes took the uploader lock. */
  started?: { of: string[]; count: number };
  runs?: Record<string, RunFacts>;
  /** `uploader.json`: absent, held by a live process, or left by a dead one. */
  "uploader-lock"?: "absent" | "live" | "stale";
}

export type BackgroundInner = Extract<
  SharedStep,
  { kind: "pass" | "turns" | "hook" | "capture" | "subagent" }
>;

export type Step =
  | Exclude<SharedStep, { kind: "expect" }>
  | ({ kind: "expect" } & ProcessExpect)
  | ({ kind: "fault" } & ProxyFault)
  | { kind: "background"; as: string; step: BackgroundInner }
  | { kind: "join"; names: string[] }
  | { kind: "await"; request: string; nth: number; timeoutMs: number }
  | { kind: "daemon"; as: string; idle?: string; keepAlive: boolean }
  | { kind: "stop"; name: string }
  | { kind: "kill"; name: string }
  | { kind: "wait"; ms: number };

export interface Setup {
  mode: "process";
  repos: Record<string, { config?: string }>;
  allow: string[];
  /** Extra server config, as TOML, before the harness's own tables. */
  server?: string;
}

export interface Scenario {
  file: string;
  name: string;
  description: string;
  guards?: string;
  setup: Setup;
  steps: Step[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const NAME = /^[\w.-]+$/;
/** The longest real-time `wait` (and `await` timeout) a scenario may ask for. */
export const MAX_WAIT_MS = 60_000;

function fail(where: string, message: string): never {
  throw new ScenarioError(`${where}: ${message}`);
}

function keysOf(value: unknown, where: string, allowed: readonly string[]): Obj {
  if (value === undefined || value === null) return {};
  if (!isObj(value)) fail(where, "takes a mapping");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(where, `unknown field '${key}'`);
  }
  return value;
}

function durationMs(value: unknown, where: string, max = MAX_WAIT_MS): number {
  const ms = typeof value === "string" ? parseDuration(value.replace(/^\+/, "")) : undefined;
  if (ms === undefined) fail(where, "must be a duration such as 2s or 500ms");
  if (ms > max) fail(where, `at most ${max / 1000}s of real time`);
  return ms;
}

function name(value: unknown, where: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    fail(where, "a name of letters, digits, '.', '_' or '-'");
  }
  return value;
}

function names(value: unknown, where: string): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) fail(where, "a name or a list of names");
  return list.map((n) => name(n, where));
}

function bytes(value: unknown, where: string, allowAll: boolean): number | "all" {
  if (allowAll && value === "all") return "all";
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(where, allowAll ? "a byte count (0 or more) or all" : "a byte count (0 or more)");
  }
  return value;
}

const HTTP = /^(GET|POST|PUT|PATCH|DELETE|HEAD|\*) \/\S*$/;

function faultStep(value: unknown, where: string): ProxyFault {
  const actions = [
    "delay",
    "close-request",
    "close-response",
    "status",
    "drop-response",
    "reset",
    "kill-client",
    "kill-server",
  ];
  if (isObj(value) && value.store !== undefined) {
    fail(where, "store faults need the in-process store wrapper; process mode faults the wire");
  }
  if (isObj(value) && value.latency !== undefined) {
    fail(where, "'latency' moves the in-process clock; use 'delay' for real time");
  }
  const f = keysOf(value, where, ["http", "nth", "times", "code", "expected", ...actions]);
  if (typeof f.http !== "string" || !HTTP.test(f.http)) {
    fail(where, "'http' must be '<METHOD> <path>', such as 'POST /v1/sessions' ('*' globs)");
  }
  const nth = f.nth ?? 1;
  if (typeof nth !== "number" || !Number.isInteger(nth) || nth < 1) {
    fail(where, "'nth' must be a whole number of at least 1");
  }
  let times: number | "always" = 1;
  if (f.times === "always") times = "always";
  else if (f.times !== undefined) {
    if (typeof f.times !== "number" || !Number.isInteger(f.times) || f.times < 1) {
      fail(where, "'times' must be a whole number of at least 1, or always");
    }
    times = f.times;
  }
  const chosen = actions.filter((a) => f[a] !== undefined);
  if (chosen.length !== 1) fail(where, `a fault takes exactly one of ${actions.join(", ")}`);
  const kind = chosen[0] as string;
  if ((f.code !== undefined || f.expected !== undefined) && kind !== "status") {
    fail(where, "'code' and 'expected' go with 'status'");
  }
  const v = f[kind];
  let action: ProxyFault["action"];
  switch (kind) {
    case "delay":
      action = { kind, ms: durationMs(v, `${where}: delay`) };
      break;
    case "close-request":
    case "close-response":
      action = { kind, bytes: bytes(v, `${where}: ${kind}`, false) as number };
      break;
    case "reset":
      if (v !== true) fail(where, "'reset' takes true");
      action = { kind: "close-request", bytes: -1 };
      break;
    case "drop-response":
      if (v !== true) fail(where, "'drop-response' takes true");
      action = { kind };
      break;
    case "kill-client":
    case "kill-server":
      action = { kind, bytes: bytes(v, `${where}: ${kind}`, true) };
      break;
    default: {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 100 || v > 599) {
        fail(where, "'status' must be an HTTP status");
      }
      if (v === 409 && typeof f.code !== "string") {
        fail(where, "a 409 needs a 'code': offset_mismatch or conflict");
      }
      action = {
        kind: "status",
        status: v,
        ...(typeof f.code === "string" ? { code: f.code } : {}),
        ...(typeof f.expected === "number" ? { expected: f.expected } : {}),
      };
    }
  }
  return { http: f.http, nth, times, action };
}

const PASS_FIELDS = ["taken", "found", "uploaded", "retracted", "failed", "queued", "retrying"];

function runFacts(value: unknown, where: string): RunFacts {
  const f = keysOf(value, where, ["started", "killed", "code", "pass"]);
  const out: RunFacts = {};
  for (const key of ["started", "killed"] as const) {
    if (f[key] === undefined) continue;
    if (typeof f[key] !== "boolean") fail(where, `'${key}' must be true or false`);
    out[key] = f[key] as boolean;
  }
  if (f.code !== undefined) {
    if (typeof f.code !== "number" || !Number.isInteger(f.code)) fail(where, "'code': a number");
    out.code = f.code;
  }
  if (f.pass !== undefined) {
    const pass = keysOf(f.pass, `${where}: pass`, PASS_FIELDS);
    for (const [k, n] of Object.entries(pass)) {
      if (typeof n !== "number" || !Number.isInteger(n)) fail(where, `'pass.${k}': a number`);
    }
    out.pass = pass as Record<string, number>;
  }
  if (Object.keys(out).length === 0)
    fail(where, "name at least one of started, killed, code, pass");
  return out;
}

/** One shared step, checked by the in-process validator (renumbered to this file's index). */
function shared(file: string, index: number, raw: unknown): SharedStep {
  try {
    const parsed = parseScenario(file, { name: "-", description: "-", steps: [raw] });
    return parsed.steps[0] as SharedStep;
  } catch (err) {
    if (!(err instanceof ScenarioError)) throw err;
    throw new ScenarioError(err.message.replace(`${file}: step 1`, `${file}: step ${index}`));
  }
}

function expectStep(file: string, index: number, body: unknown, where: string): Step {
  if (!isObj(body)) fail(where, "must be a mapping");
  const own = ["requests", "started", "runs", "uploader-lock"];
  const rest: Obj = {};
  const out: ProcessExpect = {};
  for (const [key, value] of Object.entries(body)) {
    if (!own.includes(key)) {
      rest[key] = value;
      continue;
    }
    if (key === "requests") {
      if (!isObj(value)) fail(where, "'requests' maps '<METHOD> <path>' to a count");
      out.requests = {};
      for (const [spec, n] of Object.entries(value)) {
        if (!HTTP.test(spec)) fail(where, `requests: '${spec}' is not '<METHOD> <path>'`);
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
          fail(where, `requests: '${spec}' takes a count`);
        }
        out.requests[spec] = n;
      }
    } else if (key === "started") {
      const s = keysOf(value, `${where}: started`, ["of", "count"]);
      if (typeof s.count !== "number" || !Number.isInteger(s.count) || s.count < 0) {
        fail(where, "started: 'count' must be a whole number");
      }
      out.started = { of: names(s.of, `${where}: started.of`), count: s.count };
    } else if (key === "runs") {
      if (!isObj(value)) fail(where, "'runs' maps run names to facts");
      out.runs = {};
      for (const [run, facts] of Object.entries(value)) {
        out.runs[name(run, `${where}: runs`)] = runFacts(facts, `${where}: runs.${run}`);
      }
    } else {
      if (value !== "absent" && value !== "live" && value !== "stale") {
        fail(where, "'uploader-lock' must be absent, live or stale");
      }
      out["uploader-lock"] = value;
    }
  }
  if (rest.reviewed !== undefined) {
    fail(where, "'reviewed' reads the fake reviewer, which process mode does not have");
  }
  if (Object.keys(rest).length > 0) {
    const parsed = shared(file, index, { expect: rest }) as Extract<Step, { kind: "expect" }>;
    Object.assign(out, parsed);
  }
  if (Object.keys(out).length === 0) fail(where, "expects nothing");
  return { ...out, kind: "expect" };
}

function step(file: string, index: number, raw: unknown, nested = false): Step {
  const where0 = `${file}: step ${index}`;
  let kind: string;
  let body: unknown;
  if (typeof raw === "string") kind = raw;
  else if (isObj(raw) && Object.keys(raw).length === 1) {
    kind = Object.keys(raw)[0] as string;
    body = raw[kind];
  } else {
    return fail(where0, "a step is one word (- pass) or one key (- turns: {…})");
  }
  const where = `${where0} (${kind})`;
  if (REFUSED[kind]) fail(where, `not in process mode: ${REFUSED[kind]}`);
  if (!(SHARED_KINDS as readonly string[]).includes(kind)) {
    if (!(PROCESS_KINDS as readonly string[]).includes(kind)) {
      fail(
        where0,
        `unknown step '${kind}' (process mode steps: ${[...SHARED_KINDS, ...PROCESS_KINDS].join(", ")})`,
      );
    }
  }
  switch (kind) {
    case "expect":
      return expectStep(file, index, body, where);
    case "fault":
      return { kind: "fault", ...faultStep(body, where) };
    case "background": {
      if (nested) fail(where, "cannot be nested");
      const f = keysOf(body, where, ["as", "step"]);
      const inner = step(file, index, f.step, true);
      if (!["pass", "turns", "hook", "capture", "subagent"].includes(inner.kind)) {
        fail(where, "runs pass, turns, hook, subagent or capture in the background");
      }
      return { kind: "background", as: name(f.as, `${where}: as`), step: inner as BackgroundInner };
    }
    case "join":
      return { kind: "join", names: names(body, where) };
    case "await": {
      const f = keysOf(body, where, ["request", "nth", "timeout"]);
      if (typeof f.request !== "string" || !HTTP.test(f.request)) {
        fail(where, "'request' must be '<METHOD> <path>'");
      }
      const nth = f.nth ?? 1;
      if (typeof nth !== "number" || !Number.isInteger(nth) || nth < 1) {
        fail(where, "'nth' must be a whole number of at least 1");
      }
      const timeoutMs = f.timeout === undefined ? 20_000 : durationMs(f.timeout, where);
      return { kind: "await", request: f.request, nth, timeoutMs };
    }
    case "daemon": {
      const f = keysOf(body, where, ["as", "idle", "keep-alive"]);
      const out: Extract<Step, { kind: "daemon" }> = {
        kind: "daemon",
        as: name(f.as, `${where}: as`),
        keepAlive: false,
      };
      if (f.idle !== undefined) {
        durationMs(f.idle, `${where}: idle`, 10 * 60_000);
        out.idle = f.idle as string;
      }
      if (f["keep-alive"] !== undefined) {
        if (typeof f["keep-alive"] !== "boolean") fail(where, "'keep-alive' must be true or false");
        out.keepAlive = f["keep-alive"];
      }
      return out;
    }
    case "stop":
    case "kill":
      return { kind, name: name(body, where) };
    case "wait":
      return { kind: "wait", ms: durationMs(body, where) };
    default: {
      const parsed = shared(file, index, raw);
      if (parsed.kind === "pass" && !parsed.sweep) {
        fail(where, "'sweep: false' cannot be had out of process: seshi daemon --once sweeps");
      }
      return parsed;
    }
  }
}

function setup(raw: unknown, where: string): Setup {
  if (!isObj(raw) || raw.mode !== "process") {
    fail(where, "a process-mode scenario says 'mode: process'");
  }
  for (const key of ["review", "rules", "seed"]) {
    if (raw[key] !== undefined) {
      fail(
        where,
        `'${key}' is in-process only (the fake reviewer, swapped rules, the seeded random)`,
      );
    }
  }
  const f = keysOf(raw, where, ["mode", "repos", "allow", "server"]);
  // The in-process validator checks repos, allow and server the same way.
  const checked = parseScenario(where, {
    name: "-",
    description: "-",
    setup: {
      ...(f.repos !== undefined ? { repos: f.repos } : {}),
      ...(f.allow !== undefined ? { allow: f.allow } : {}),
      ...(f.server !== undefined ? { server: f.server } : {}),
    },
    steps: ["pass"],
  }).setup;
  return {
    mode: "process",
    repos: checked.repos,
    allow: checked.allow,
    ...(checked.server ? { server: checked.server } : {}),
  };
}

/** Check a parsed process-mode scenario. Throws `ScenarioError` naming the file and step. */
export function parseProcessScenario(file: string, value: unknown): Scenario {
  if (!isObj(value)) fail(file, "a scenario is a mapping");
  const top = keysOf(value, file, ["name", "description", "guards", "setup", "steps"]);
  for (const key of ["name", "description"]) {
    if (typeof top[key] !== "string" || top[key] === "") fail(file, `'${key}' is required`);
  }
  if (top.guards !== undefined && typeof top.guards !== "string") fail(file, "'guards': a string");
  const parsedSetup = setup(top.setup, `${file}: setup`);
  if (!Array.isArray(top.steps) || top.steps.length === 0) fail(file, "'steps' must be a list");
  const steps = top.steps.map((s, i) => step(file, i + 1, s));
  const declared = new Set<string>();
  for (const [i, s] of steps.entries()) {
    const here = `${file}: step ${i + 1} (${s.kind})`;
    if (s.kind === "background" || s.kind === "daemon") {
      if (declared.has(s.as)) fail(here, `'${s.as}' is already a run's name`);
      declared.add(s.as);
    }
    const used =
      s.kind === "join"
        ? s.names
        : s.kind === "stop" || s.kind === "kill"
          ? [s.name]
          : s.kind === "expect"
            ? [...(s.started?.of ?? []), ...Object.keys(s.runs ?? {})]
            : [];
    for (const n of used) if (!declared.has(n)) fail(here, `no run named '${n}' before this step`);
  }
  return {
    file,
    name: top.name as string,
    description: top.description as string,
    ...(typeof top.guards === "string" ? { guards: top.guards } : {}),
    setup: parsedSetup,
    steps,
  };
}

/** Parse YAML text with Bun's built-in parser, then check it. */
export function loadProcessScenario(file: string, text: string): Scenario {
  let value: unknown;
  try {
    value = Bun.YAML.parse(text);
  } catch (err) {
    throw new ScenarioError(`${file}: not YAML: ${(err as Error).message}`);
  }
  return parseProcessScenario(file, value);
}
