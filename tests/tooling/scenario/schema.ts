/** The scenario file format (tests/scenarios/README.md is its reference) and its validator. A
 * scenario is parsed with Bun's built-in YAML parser and checked here; any unknown step, unknown
 * field or bad value is reported with the file and the step's index, before anything runs. */

import { parseDuration } from "@seshi/config";

export const STEP_KINDS = [
  "turns",
  "subagent",
  "compact",
  "move-transcript",
  "hook",
  "pass",
  "capture",
  "clock",
  "restart-server",
  "rules",
  "format-bump",
  "sweep",
  "backfill",
  "review",
  "fault",
  "heal",
  "expect",
  "settle",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type ReviewAnswer = "allow" | "redact" | "drop" | "fail";
export type CompactMode = "append" | "shrink";
export type HookEvent = "Stop" | "SessionStart" | "SessionEnd" | "PreCompact" | "none";
export type ServerFact = "present" | "absent" | "stub" | "redacted";

export interface Rule {
  id: string;
  pattern: string;
}

export interface Setup {
  mode: "server" | "local";
  /** The fake reviewer, on for every envelope; its answers come from `review` steps (allow
   * when none is queued). */
  review?: { on_failure: "drop" | "skip" };
  /** Org rule packs at the start, on top of the built-in pack. */
  rules: Rule[];
  /** Folders under the machine's home made git repos, with `.seshi/config.toml` content. */
  repos: Record<string, { config?: string }>;
  /** `checkStore` warnings allowed once quiet. */
  allow: string[];
  seed: number;
  /** Extra server config, as TOML (`default_visibility = "owner"`). */
  server?: string;
}

export interface SessionFacts {
  server?: ServerFact;
  id?: string;
  records?: number;
  traces?: number;
  visibility?: "owner" | "org";
  "matches-transcript"?: boolean;
  "sent-all"?: boolean;
  frozen?: boolean;
  toggle?: "on" | "off" | "none";
  rebuild?: "none" | "waiting" | "due";
  "last-status"?: string;
  retract?: string;
  doctor?: "ok" | string[];
}

export interface Expect {
  pass?: Record<string, number | string>;
  sessions?: Record<string, SessionFacts>;
  bucket?: { has: string[]; lacks: string[] };
  reviewed?: { text: string; times: number }[];
  "store-check"?: { warn: string[] };
  /** Lines of the capture log that must be there (substrings). */
  log?: string[];
}

export type HttpFaultStep = {
  http: string;
  nth: number;
  times: number | "always";
  status?: number;
  code?: string;
  expected?: number;
  "drop-response"?: true;
  reset?: true;
  latency?: number;
};

export type StoreFaultStep = {
  store: "put" | "delete";
  key: string;
  nth: number;
  times: number | "always";
  error: "fail" | "precondition";
  after: boolean;
};

export type Step =
  | {
      kind: "turns";
      session: string;
      count: number;
      secret: boolean;
      mark?: string;
      in?: string;
      hook: HookEvent;
    }
  | {
      kind: "subagent";
      parent: string;
      id: string;
      turns: number;
      secret: boolean;
      mark?: string;
      in?: string;
      hook: boolean;
    }
  | { kind: "compact"; session: string; mode: CompactMode; keep: number; hook: HookEvent }
  | { kind: "move-transcript"; session: string; to: string; hook: HookEvent }
  | { kind: "hook"; session: string; event: Exclude<HookEvent, "none">; in?: string }
  | { kind: "pass"; sweep: boolean }
  | { kind: "capture"; args: string[]; code: number }
  | { kind: "clock"; ms: number }
  | { kind: "restart-server" }
  | { kind: "rules"; add: Rule[]; set?: Rule[] }
  | { kind: "format-bump"; format: string }
  | { kind: "sweep" }
  | { kind: "backfill" }
  | { kind: "review"; answers: ReviewAnswer[] }
  | ({ kind: "fault" } & (HttpFaultStep | StoreFaultStep))
  | { kind: "heal" }
  | ({ kind: "expect" } & Expect)
  | { kind: "settle"; allow: string[]; max: number };

export interface Scenario {
  file: string;
  name: string;
  description: string;
  /** The bug or decision the scenario guards, in words. */
  guards?: string;
  setup: Setup;
  steps: Step[];
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads fields off one mapping, and complains about the ones nobody read. */
class Fields {
  private readonly used = new Set<string>();
  constructor(
    private readonly obj: Obj,
    private readonly where: string,
  ) {}

  fail(message: string): never {
    throw new ScenarioError(`${this.where}: ${message}`);
  }

  private take(name: string): unknown {
    this.used.add(name);
    return this.obj[name];
  }

  has(name: string): boolean {
    return this.obj[name] !== undefined;
  }

  string(name: string): string | undefined {
    const v = this.take(name);
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "") this.fail(`'${name}' must be a non-empty string`);
    return v;
  }

  needString(name: string): string {
    return this.string(name) ?? this.fail(`'${name}' is required`);
  }

  int(name: string, min = 0): number | undefined {
    const v = this.take(name);
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
      this.fail(`'${name}' must be a whole number of at least ${min}`);
    }
    return v;
  }

  bool(name: string): boolean | undefined {
    const v = this.take(name);
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") this.fail(`'${name}' must be true or false`);
    return v;
  }

  oneOf<T extends string>(name: string, values: readonly T[]): T | undefined {
    const v = this.take(name);
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !values.includes(v as T)) {
      this.fail(`'${name}' must be one of ${values.join(", ")}`);
    }
    return v as T;
  }

  strings(name: string): string[] | undefined {
    const v = this.take(name);
    if (v === undefined) return undefined;
    const list = typeof v === "string" ? [v] : v;
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string" || s === "")) {
      this.fail(`'${name}' must be a string or a list of strings`);
    }
    return list as string[];
  }

  duration(name: string): number | undefined {
    const v = this.take(name);
    if (v === undefined) return undefined;
    return durationOf(v, (m) => this.fail(`'${name}' ${m}`));
  }

  raw(name: string): unknown {
    return this.take(name);
  }

  /** Every field must have been read. */
  done(): void {
    for (const key of Object.keys(this.obj)) {
      if (!this.used.has(key)) this.fail(`unknown field '${key}'`);
    }
  }
}

function durationOf(v: unknown, fail: (message: string) => never): number {
  if (typeof v !== "string") return fail("must be a duration such as 2h or +30m");
  const ms = parseDuration(v.replace(/^\+/, ""));
  if (ms === undefined) return fail(`must be a duration such as 2h or +30m, not '${v}'`);
  return ms;
}

const HOOKS: readonly HookEvent[] = ["Stop", "SessionStart", "SessionEnd", "PreCompact", "none"];
const SESSION_NAME = /^[\w.-]+$/;

function sessionName(f: Fields, name: string): string {
  const v = f.needString(name);
  if (!SESSION_NAME.test(v)) f.fail(`'${name}' must be letters, digits, '.', '_' or '-'`);
  return v;
}

function folder(f: Fields, name: string): string | undefined {
  const v = f.string(name);
  if (v !== undefined && (v.startsWith("/") || v.split("/").includes(".."))) {
    f.fail(`'${name}' is a folder under the machine's home, such as code/app`);
  }
  return v;
}

function rules(value: unknown, where: string): Rule[] {
  if (!Array.isArray(value)) throw new ScenarioError(`${where}: must be a list of { id, pattern }`);
  return value.map((r, i) => {
    if (!isObj(r)) throw new ScenarioError(`${where}[${i}]: must be { id, pattern }`);
    const f: Fields = new Fields(r, `${where}[${i}]`);
    const rule = { id: f.needString("id"), pattern: f.needString("pattern") };
    f.done();
    return rule;
  });
}

const FACT_KEYS = [
  "server",
  "id",
  "records",
  "traces",
  "visibility",
  "matches-transcript",
  "sent-all",
  "frozen",
  "toggle",
  "rebuild",
  "last-status",
  "retract",
  "doctor",
] as const;

function sessionFacts(value: unknown, where: string): SessionFacts {
  if (!isObj(value)) throw new ScenarioError(`${where}: must be a mapping of facts`);
  const f: Fields = new Fields(value, where);
  const facts: SessionFacts = {};
  const server = f.oneOf("server", ["present", "absent", "stub", "redacted"] as const);
  if (server) facts.server = server;
  const id = f.string("id");
  if (id) facts.id = id;
  const records = f.int("records");
  if (records !== undefined) facts.records = records;
  const traces = f.int("traces");
  if (traces !== undefined) facts.traces = traces;
  const visibility = f.oneOf("visibility", ["owner", "org"] as const);
  if (visibility) facts.visibility = visibility;
  for (const key of ["matches-transcript", "sent-all", "frozen"] as const) {
    const v = f.bool(key);
    if (v !== undefined) facts[key] = v;
  }
  const toggle = f.oneOf("toggle", ["on", "off", "none"] as const);
  if (toggle) facts.toggle = toggle;
  const rebuild = f.oneOf("rebuild", ["none", "waiting", "due"] as const);
  if (rebuild) facts.rebuild = rebuild;
  const lastStatus = f.string("last-status");
  if (lastStatus) facts["last-status"] = lastStatus;
  const retract = f.string("retract");
  if (retract) facts.retract = retract;
  if (f.has("doctor")) {
    const doctor = f.raw("doctor");
    if (doctor === "ok") facts.doctor = "ok";
    else if (Array.isArray(doctor) && doctor.every((d) => typeof d === "string")) {
      facts.doctor = doctor as string[];
    } else f.fail(`'doctor' must be ok or a list of the check ids that fail`);
  }
  f.done();
  if (Object.keys(facts).length === 0) {
    throw new ScenarioError(`${where}: name at least one of ${FACT_KEYS.join(", ")}`);
  }
  return facts;
}

const PASS_FIELDS = ["taken", "found", "uploaded", "retracted", "failed", "queued", "retrying"];

function expectStep(value: unknown, where: string): Expect {
  if (!isObj(value)) throw new ScenarioError(`${where}: must be a mapping`);
  const f: Fields = new Fields(value, where);
  const out: Expect = {};
  if (f.has("pass")) {
    const pass = f.raw("pass");
    if (!isObj(pass)) f.fail("'pass' must be a mapping of summary fields");
    for (const [k, v] of Object.entries(pass)) {
      if (k === "signIn" ? typeof v !== "string" : !PASS_FIELDS.includes(k)) {
        f.fail(`'pass.${k}' is not a pass summary field (${PASS_FIELDS.join(", ")}, signIn)`);
      }
      if (k !== "signIn" && (typeof v !== "number" || !Number.isInteger(v))) {
        f.fail(`'pass.${k}' must be a whole number`);
      }
    }
    out.pass = pass as Record<string, number | string>;
  }
  if (f.has("sessions")) {
    const sessions = f.raw("sessions");
    if (!isObj(sessions)) f.fail("'sessions' must map session names to facts");
    out.sessions = {};
    for (const [name, facts] of Object.entries(sessions)) {
      out.sessions[name] = sessionFacts(facts, `${where}: sessions.${name}`);
    }
  }
  if (f.has("bucket")) {
    const bucket = f.raw("bucket");
    if (!isObj(bucket)) f.fail("'bucket' must be { has, lacks }");
    const b: Fields = new Fields(bucket, `${where}: bucket`);
    out.bucket = { has: b.strings("has") ?? [], lacks: b.strings("lacks") ?? [] };
    b.done();
  }
  if (f.has("reviewed")) {
    const reviewed = f.raw("reviewed");
    const list = Array.isArray(reviewed) ? reviewed : [reviewed];
    out.reviewed = list.map((r, i) => {
      if (!isObj(r)) f.fail(`'reviewed[${i}]' must be { text, times }`);
      const g: Fields = new Fields(r, `${where}: reviewed[${i}]`);
      const entry = { text: g.needString("text"), times: g.int("times") ?? g.fail("'times'") };
      g.done();
      return entry;
    });
  }
  if (f.has("store-check")) {
    const check = f.raw("store-check");
    if (!isObj(check)) f.fail("'store-check' must be { warn: [codes] }");
    const c: Fields = new Fields(check, `${where}: store-check`);
    out["store-check"] = { warn: c.strings("warn") ?? [] };
    c.done();
  }
  const log = f.strings("log");
  if (log) out.log = log;
  f.done();
  if (Object.keys(out).length === 0) throw new ScenarioError(`${where}: expects nothing`);
  return out;
}

function faultStep(value: unknown, where: string): HttpFaultStep | StoreFaultStep {
  if (!isObj(value)) throw new ScenarioError(`${where}: must be a mapping`);
  const f: Fields = new Fields(value, where);
  const nth = f.int("nth", 1) ?? 1;
  const timesRaw = f.raw("times");
  let times: number | "always" = 1;
  if (timesRaw === "always") times = "always";
  else if (timesRaw !== undefined) {
    if (typeof timesRaw !== "number" || !Number.isInteger(timesRaw) || timesRaw < 1) {
      f.fail("'times' must be a whole number of at least 1, or always");
    }
    times = timesRaw;
  }
  if (f.has("http")) {
    const http = f.needString("http");
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|\*) \/\S*$/.test(http)) {
      f.fail("'http' must be '<METHOD> <path>', such as 'POST /v1/sessions' ('*' globs)");
    }
    const step: HttpFaultStep = { http, nth, times };
    const status = f.int("status", 100);
    const drop = f.bool("drop-response");
    const reset = f.bool("reset");
    const latency = f.duration("latency");
    const actions = [status !== undefined, drop === true, reset === true, latency !== undefined];
    if (actions.filter(Boolean).length !== 1) {
      f.fail("an http fault takes exactly one of status, drop-response, reset, latency");
    }
    if (status !== undefined) step.status = status;
    if (drop) step["drop-response"] = true;
    if (reset) step.reset = true;
    if (latency !== undefined) step.latency = latency;
    const code = f.string("code");
    if (code) step.code = code;
    const expected = f.int("expected");
    if (expected !== undefined) step.expected = expected;
    if ((code || expected !== undefined) && status === undefined) {
      f.fail("'code' and 'expected' go with 'status'");
    }
    if (status === 409 && !code) f.fail("a 409 needs a 'code': offset_mismatch or conflict");
    f.done();
    return step;
  }
  if (f.has("store")) {
    const store = f.oneOf("store", ["put", "delete"] as const) as "put" | "delete";
    const step: StoreFaultStep = {
      store,
      key: f.needString("key"),
      nth,
      times,
      error: f.oneOf("error", ["fail", "precondition"] as const) ?? "fail",
      after: f.bool("after") ?? false,
    };
    f.done();
    return step;
  }
  return f.fail("a fault names 'http' or 'store'");
}

/** One step, from its YAML form: `- pass` or `- turns: { … }`. */
function step(raw: unknown, where: string): Step {
  let kind: string;
  let body: unknown;
  if (typeof raw === "string") {
    kind = raw;
    body = undefined;
  } else if (isObj(raw) && Object.keys(raw).length === 1) {
    kind = Object.keys(raw)[0] as string;
    body = raw[kind];
  } else {
    throw new ScenarioError(`${where}: a step is one word (- pass) or one key (- turns: {…})`);
  }
  if (!STEP_KINDS.includes(kind as StepKind)) {
    throw new ScenarioError(`${where}: unknown step '${kind}' (steps: ${STEP_KINDS.join(", ")})`);
  }
  const here = `${where} (${kind})`;
  const obj = (): Fields => {
    if (body === undefined || body === null) return new Fields({}, here);
    if (!isObj(body)) throw new ScenarioError(`${here}: takes a mapping`);
    return new Fields(body, here);
  };
  const none = () => {
    if (body !== undefined && body !== null && !(isObj(body) && Object.keys(body).length === 0)) {
      throw new ScenarioError(`${here}: takes nothing`);
    }
  };
  switch (kind as StepKind) {
    case "turns": {
      const f: Fields = obj();
      const out: Step = {
        kind: "turns",
        session: sessionName(f, "session"),
        count: f.int("count", 1) ?? 1,
        secret: f.bool("secret") ?? false,
        hook: f.oneOf("hook", HOOKS) ?? "Stop",
      };
      const mark = f.string("mark");
      if (mark) out.mark = mark;
      const at = folder(f, "in");
      if (at) out.in = at;
      f.done();
      return out;
    }
    case "subagent": {
      const f: Fields = obj();
      const out: Step = {
        kind: "subagent",
        parent: sessionName(f, "parent"),
        id: sessionName(f, "id"),
        turns: f.int("turns", 1) ?? 2,
        secret: f.bool("secret") ?? false,
        hook: f.bool("hook") ?? true,
      };
      const mark = f.string("mark");
      if (mark) out.mark = mark;
      const at = folder(f, "in");
      if (at) out.in = at;
      f.done();
      return out;
    }
    case "compact": {
      const f: Fields = obj();
      const out: Step = {
        kind: "compact",
        session: sessionName(f, "session"),
        mode: f.oneOf("mode", ["append", "shrink"] as const) ?? "append",
        keep: f.int("keep", 0) ?? 1,
        hook: f.oneOf("hook", HOOKS) ?? "Stop",
      };
      f.done();
      return out;
    }
    case "move-transcript": {
      const f: Fields = obj();
      const out: Step = {
        kind: "move-transcript",
        session: sessionName(f, "session"),
        to: folder(f, "to") ?? "code/moved",
        hook: f.oneOf("hook", HOOKS) ?? "Stop",
      };
      f.done();
      return out;
    }
    case "hook": {
      const f: Fields = obj();
      const event = f.oneOf("event", HOOKS) ?? "Stop";
      if (event === "none") f.fail("'event' cannot be none here");
      const out: Step = { kind: "hook", session: sessionName(f, "session"), event };
      const at = folder(f, "in");
      if (at) out.in = at;
      f.done();
      return out;
    }
    case "pass": {
      const f: Fields = obj();
      const out: Step = { kind: "pass", sweep: f.bool("sweep") ?? true };
      f.done();
      return out;
    }
    case "capture": {
      if (typeof body === "string") {
        return { kind: "capture", args: body.split(/\s+/).filter(Boolean), code: 0 };
      }
      const f: Fields = obj();
      const args = f.needString("args").split(/\s+/).filter(Boolean);
      const out: Step = { kind: "capture", args, code: f.int("code") ?? 0 };
      f.done();
      return out;
    }
    case "clock":
      return {
        kind: "clock",
        ms: durationOf(body, (m) => {
          throw new ScenarioError(`${here}: ${m}`);
        }),
      };
    case "restart-server":
      none();
      return { kind: "restart-server" };
    case "rules": {
      const f: Fields = obj();
      const out: Step = {
        kind: "rules",
        add: f.has("add") ? rules(f.raw("add"), `${here}: add`) : [],
      };
      if (f.has("set")) out.set = rules(f.raw("set"), `${here}: set`);
      if (out.add.length === 0 && !out.set) f.fail("name rules to 'add' or 'set'");
      f.done();
      return out;
    }
    case "format-bump":
      if (typeof body !== "string" || body === "") {
        throw new ScenarioError(`${here}: names a format, such as claude-code`);
      }
      return { kind: "format-bump", format: body };
    case "sweep":
      none();
      return { kind: "sweep" };
    case "backfill":
      none();
      return { kind: "backfill" };
    case "review": {
      const list = typeof body === "string" ? [body] : body;
      const answers = ["allow", "redact", "drop", "fail"];
      if (!Array.isArray(list) || list.length === 0 || list.some((a) => !answers.includes(a))) {
        throw new ScenarioError(`${here}: a list of ${answers.join(", ")}`);
      }
      return { kind: "review", answers: list as ReviewAnswer[] };
    }
    case "fault":
      return { kind: "fault", ...faultStep(body, here) };
    case "heal":
      none();
      return { kind: "heal" };
    case "expect":
      return { kind: "expect", ...expectStep(body, here) };
    case "settle": {
      const f: Fields = obj();
      const out: Step = {
        kind: "settle",
        allow: f.strings("allow") ?? [],
        max: f.int("max", 1) ?? 40,
      };
      f.done();
      return out;
    }
  }
}

function setup(raw: unknown, where: string): Setup {
  const out: Setup = { mode: "server", rules: [], repos: {}, allow: [], seed: 1 };
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) throw new ScenarioError(`${where}: must be a mapping`);
  const f: Fields = new Fields(raw, where);
  out.mode = f.oneOf("mode", ["server", "local"] as const) ?? "server";
  if (f.has("review")) {
    const review = f.raw("review");
    if (review === true) out.review = { on_failure: "drop" };
    else if (isObj(review)) {
      const r: Fields = new Fields(review, `${where}: review`);
      out.review = { on_failure: r.oneOf("on_failure", ["drop", "skip"] as const) ?? "drop" };
      r.done();
    } else if (review !== false) f.fail("'review' must be true or { on_failure }");
  }
  if (f.has("rules")) out.rules = rules(f.raw("rules"), `${where}: rules`);
  if (f.has("repos")) {
    const repos = f.raw("repos");
    if (!isObj(repos)) f.fail("'repos' must map folders to { config }");
    for (const [dir, repo] of Object.entries(repos)) {
      if (dir.startsWith("/") || dir.split("/").includes("..")) {
        f.fail(`repos: '${dir}' is a folder under the machine's home, such as code/app`);
      }
      const r: Fields = new Fields(isObj(repo) ? repo : {}, `${where}: repos.${dir}`);
      if (repo !== null && !isObj(repo)) r.fail("must be { config } or nothing");
      const config = r.string("config");
      r.done();
      out.repos[dir] = config === undefined ? {} : { config };
    }
  }
  out.allow = f.strings("allow") ?? [];
  out.seed = f.int("seed") ?? 1;
  const server = f.string("server");
  if (server) out.server = server;
  f.done();
  return out;
}

/** Check a parsed scenario file. Throws `ScenarioError` naming the file and step. */
export function parseScenario(file: string, value: unknown): Scenario {
  if (!isObj(value)) throw new ScenarioError(`${file}: a scenario is a mapping`);
  const f: Fields = new Fields(value, file);
  const name = f.needString("name");
  const description = f.needString("description");
  const guards = f.string("guards");
  const parsedSetup = setup(f.raw("setup"), `${file}: setup`);
  const rawSteps = f.raw("steps");
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) f.fail("'steps' must be a list");
  f.done();
  const steps = rawSteps.map((s, i) => step(s, `${file}: step ${i + 1}`));
  return {
    file,
    name,
    description,
    ...(guards ? { guards } : {}),
    setup: parsedSetup,
    steps,
  };
}

/** Parse YAML text with Bun's built-in parser, then check it. */
export function loadScenario(file: string, text: string): Scenario {
  let value: unknown;
  try {
    value = Bun.YAML.parse(text);
  } catch (err) {
    throw new ScenarioError(`${file}: not YAML: ${(err as Error).message}`);
  }
  return parseScenario(file, value);
}
