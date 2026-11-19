/** Runs one process-mode scenario: each step with real processes, the invariants after every step
 * (read from the state file and the bucket on disk), and the quiet checks at `settle` and at the
 * end, as the in-process runner does: `seshi doctor --json` fails nothing, `checkStore` is
 * clean, the server matches each session's capture decision, no proxy rule is left armed.
 * Whatever happens, every process the scenario started is killed by pid before it returns. */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type CaptureState,
  type PassSummary,
  readState,
  readUploaderLock,
  type SessionState,
  sessionKey,
  uploadId,
} from "@seshi/capture";
import type { SessionMetadata } from "@seshi/model";
import { archiveId, checkStore, type Finding, keys } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import type { HookEvent, SessionFacts } from "../scenario/schema";
import { LINES_PER_TURN, SECRETS, summaryLines, turnLines } from "../scenario/transcript";
import { type Child, pidAlive } from "./procs";
import { globRegex } from "./proxy";
import type { BackgroundInner, ProcessExpect, Scenario, Step } from "./schema";
import { AGENT, OWNER, type SessionInfo, World } from "./world";

export class ScenarioFailure extends Error {
  /** Processes left once the runner cleaned up (empty unless cleanup itself failed). */
  survivors: string[] = [];
  /** Processes that were running when the scenario failed, before the cleanup. */
  running: string[] = [];
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

export interface RunReport {
  name: string;
  ms: number;
  /** Proxy rules that fired, in order. */
  faults: string[];
  passes: number;
  /** Processes started. */
  processes: number;
  /** Processes left once it ended (always empty, or the run failed). */
  survivors: string[];
}

/** A pass's outcome as `seshi daemon --once --json` printed it. */
interface PassOutcome {
  /** It took the uploader lock (false: another uploader held it, nothing done). */
  started: boolean;
  summary?: PassSummary;
  killed: boolean;
  code: number | null;
}

/** A named background run or daemon. */
interface Run {
  name: string;
  what: string;
  promise: Promise<void>;
  settled: boolean;
  error?: unknown;
  child?: Child;
  pass?: PassOutcome;
}

interface DoctorSession {
  agent: string;
  session_id: string;
  checks: { id: string; status: string; summary: string; detail?: string[] }[];
}

const slug = (path: string) => path.replace(/[/\\.:]/g, "-");

function sizeOf(path: string | undefined): number | undefined {
  if (!path) return undefined;
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function retractedId(s: SessionState): string | undefined {
  const g = s.generation ?? 0;
  if (g === 0) return undefined;
  return g === 1 ? s.session_id : `${s.session_id}~${g - 1}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (at: string) => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      try {
        if (statSync(path).isDirectory()) visit(path);
        else out.push(path);
      } catch {}
    }
  };
  visit(dir);
  return out;
}

function findingLine(f: Finding): string {
  return `${f.severity} ${f.code}: ${f.message}${f.key ? ` (${f.key})` : ""}`;
}

/** A short form of a step for messages. */
export function describeStep(step: Step): string {
  const { kind, ...rest } = step;
  const words = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  return words ? `${kind} ${words}` : kind;
}

class Runner {
  private index = 0;
  private step: Step | undefined;
  private passes = 0;
  private lastPass: PassOutcome | undefined;
  private readonly runs = new Map<string, Run>();
  /** Where `await` starts counting: the proxy's request count when the last background run or
   * daemon started. */
  private mark = 0;
  private readonly frozenSeen = new Map<string, { offset: number; faults: number; held: number }>();
  private readonly formats = buildFormats();

  constructor(private readonly world: World) {}

  private get scenario(): Scenario {
    return this.world.scenario;
  }

  // --- failures --------------------------------------------------------------------------

  fail(message: string, evidence: string[] = []): never {
    const where = this.step
      ? `step ${this.index} (${describeStep(this.step)})`
      : this.index > this.scenario.steps.length
        ? "at the end"
        : "setup";
    const lines = [`${this.scenario.file}: ${where}: ${message}`, ...evidence.map((e) => `  ${e}`)];
    const fired = this.world.proxy.log;
    if (fired.length > 0) lines.push("  proxy rules fired:", ...fired.map((f) => `    ${f}`));
    const requests = this.world.proxy.requests.slice(-12);
    if (requests.length > 0) {
      lines.push(
        "  requests (last):",
        ...requests.map(
          (r) =>
            `    #${r.n} ${r.method} ${r.path} → ${r.status ?? "-"}${r.outcome && r.outcome !== "answered" ? ` (${r.outcome})` : ""}`,
        ),
      );
    }
    const log = this.captureLog().slice(-12);
    if (log.length > 0) lines.push("  capture log (last lines):", ...log.map((l) => `    ${l}`));
    throw new ScenarioFailure(lines.join("\n"));
  }

  private captureLog(): string[] {
    try {
      return readFileSync(this.world.paths.log, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  // --- reading the world -----------------------------------------------------------------

  private state(): CaptureState {
    return readState(this.world.paths);
  }

  private entry(name: string): SessionState | undefined {
    return this.state().sessions[sessionKey(AGENT, name)];
  }

  private async pointer(id: string): Promise<SessionMetadata | null> {
    const got = await this.world.store.get(keys.metadata(OWNER, archiveId(OWNER, AGENT, id)));
    return got ? (JSON.parse(new TextDecoder().decode(got.body)) as SessionMetadata) : null;
  }

  private recordsOf(path: string, end?: number): number {
    let text = readFileSync(path, "utf8");
    if (end !== undefined) text = Buffer.from(text).subarray(0, end).toString("utf8");
    const cut = text.lastIndexOf("\n");
    text = cut === -1 ? "" : text.slice(0, cut + 1);
    if (!text) return 0;
    return this.formats.normalize({ source: AGENT, transcript: text }).records.length;
  }

  private bucketTexts(): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const path of walk(this.world.bucketDir)) {
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try {
          bytes = gunzipSync(bytes);
        } catch {}
      }
      out.push({ path, text: new TextDecoder().decode(bytes) });
    }
    return out;
  }

  private session(name: string): SessionInfo {
    const info = this.world.sessions.get(name);
    if (!info) this.fail(`no session '${name}' yet: start it with a turns step`);
    return info;
  }

  /** Something runs in the background (a run not joined, a long-running daemon). */
  private busy(): boolean {
    return [...this.runs.values()].some((r) => !r.settled);
  }

  // --- the agent -------------------------------------------------------------------------

  private folder(rel: string): string {
    const path = join(this.world.home, rel);
    mkdirSync(path, { recursive: true });
    return path;
  }

  private transcriptPath(id: string, cwd: string): string {
    const dir = join(this.world.home, ".claude", "projects", slug(cwd));
    mkdirSync(dir, { recursive: true });
    return join(dir, `${id}.jsonl`);
  }

  private async hook(
    info: SessionInfo,
    event: Exclude<HookEvent, "none"> | "SubagentStop",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const payload = {
      session_id: info.id,
      transcript_path: info.path,
      cwd: info.cwd,
      hook_event_name: event,
      ...extra,
    };
    const run = await this.world.run(["hook", AGENT, event], {
      stdin: JSON.stringify(payload),
      label: `hook ${event}`,
    });
    if (run.code !== 0) this.fail(`seshi hook exited ${run.code ?? run.signal}`, [run.err]);
  }

  private async turns(step: Extract<Step, { kind: "turns" }>): Promise<void> {
    let info = this.world.sessions.get(step.session);
    const cwd = this.folder(step.in ?? info?.cwd.slice(this.world.home.length + 1) ?? "code/app");
    if (!info) {
      info = {
        id: step.session,
        cwd,
        path: this.transcriptPath(step.session, cwd),
        turns: 0,
        summaries: 0,
      };
      this.world.sessions.set(step.session, info);
    }
    info.cwd = cwd;
    const first = info.turns;
    appendFileSync(
      info.path,
      turnLines(first, {
        sessionId: info.id,
        cwd,
        count: step.count,
        secret: step.secret,
        ...(step.mark ? { mark: step.mark } : {}),
        now: () => new Date(),
      }),
    );
    info.turns = first + step.count;
    if (step.secret) this.world.planted = true;
    if (step.mark) this.world.marks.push(step.mark);
    if (step.hook !== "none") await this.hook(info, step.hook);
  }

  private async subagent(step: Extract<Step, { kind: "subagent" }>): Promise<void> {
    const parent = this.session(step.parent);
    const id = `agent-${step.id}`;
    let info = this.world.sessions.get(id);
    if (!info) {
      const path = join(dirname(parent.path), parent.id, "subagents", `${id}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      info = { id, path, cwd: parent.cwd, parent: parent.id, turns: 0, summaries: 0 };
      this.world.sessions.set(id, info);
    }
    info.cwd = step.in ? this.folder(step.in) : parent.cwd;
    const first = info.turns;
    appendFileSync(
      info.path,
      turnLines(first, {
        sessionId: id,
        parentId: parent.id,
        cwd: info.cwd,
        count: step.turns,
        secret: step.secret,
        ...(step.mark ? { mark: step.mark } : {}),
        now: () => new Date(),
      }),
    );
    info.turns = first + step.turns;
    if (step.secret) this.world.planted = true;
    if (step.mark) this.world.marks.push(step.mark);
    if (!step.hook) return;
    await this.hook({ ...parent, cwd: info.cwd }, "SubagentStop", {
      agent_id: step.id,
      agent_transcript_path: info.path,
    });
  }

  private async compact(step: Extract<Step, { kind: "compact" }>): Promise<void> {
    const info = this.session(step.session);
    info.summaries++;
    const summary = summaryLines(
      info.parent ?? info.id,
      info.cwd,
      () => new Date(),
      info.summaries,
    );
    if (step.mode === "append") appendFileSync(info.path, summary);
    else {
      const lines = readFileSync(info.path, "utf8").split("\n").filter(Boolean);
      const kept = lines.slice(0, step.keep * LINES_PER_TURN);
      writeFileSync(info.path, `${kept.map((l) => `${l}\n`).join("")}${summary}`);
      this.shrunk.add(info.id);
    }
    if (step.hook !== "none") await this.hook(info, step.hook);
  }

  private readonly shrunk = new Set<string>();

  private async move(step: Extract<Step, { kind: "move-transcript" }>): Promise<void> {
    const info = this.session(step.session);
    const cwd = this.folder(step.to);
    const path = this.transcriptPath(info.id, cwd);
    renameSync(info.path, path);
    info.path = path;
    info.cwd = cwd;
    if (step.hook !== "none") await this.hook(info, step.hook);
  }

  // --- the uploader ----------------------------------------------------------------------

  /** One `seshi daemon --once --json`, as its own process. A pass a kill rule ended is not a
   * failure; one that needs a sign-in, or exits otherwise, is. */
  private async pass(label = "daemon --once", track?: Run): Promise<PassOutcome> {
    const child = this.world.spawn(["daemon", "--once", "--json"], label);
    if (track) track.child = child;
    const exit = await this.world.wait(child);
    this.passes++;
    this.shrunk.clear();
    if (exit.signal) {
      if (child.killed) return { started: true, killed: true, code: null };
      this.fail(`${label} died of ${exit.signal}`, [exit.err.slice(-2000)]);
    }
    let out: Record<string, unknown> = {};
    try {
      out = JSON.parse(exit.out) as Record<string, unknown>;
    } catch {
      this.fail(`${label} exited ${exit.code} and printed no JSON`, [exit.out, exit.err]);
    }
    if (out.started === false) return { started: false, killed: false, code: exit.code };
    const summary = out as unknown as PassSummary;
    if (summary.signIn) this.fail(`the uploader needs a sign-in: ${summary.signIn}`);
    if (exit.code !== 0) this.fail(`${label} exited ${exit.code}`, [exit.err]);
    return { started: true, summary, killed: false, code: 0 };
  }

  // --- steps -----------------------------------------------------------------------------

  private async inner(step: BackgroundInner, track?: Run): Promise<void> {
    switch (step.kind) {
      case "turns":
        return this.turns(step);
      case "subagent":
        return this.subagent(step);
      case "hook": {
        const info = this.session(step.session);
        if (step.in) info.cwd = this.folder(step.in);
        return this.hook(info, step.event);
      }
      case "pass": {
        const outcome = await this.pass(track ? `daemon --once (${track.name})` : undefined, track);
        if (track) track.pass = outcome;
        else this.lastPass = outcome;
        return;
      }
      case "capture": {
        const run = await this.world.run(["capture", ...step.args], {
          env: { SESHI_AGENT: AGENT },
          label: `capture ${step.args.join(" ")}`,
        });
        if (run.code !== step.code) {
          this.fail(
            `seshi capture ${step.args.join(" ")} exited ${run.code ?? run.signal}, not ${step.code}`,
            [...run.out.split("\n"), ...run.err.split("\n")],
          );
        }
        return;
      }
    }
  }

  private async run(step: Step): Promise<void> {
    const world = this.world;
    switch (step.kind) {
      case "turns":
      case "subagent":
      case "hook":
      case "pass":
      case "capture":
        return this.inner(step);
      case "compact":
        return this.compact(step);
      case "move-transcript":
        return this.move(step);
      case "restart-server":
        return world.restartServer();
      case "heal":
        world.proxy.heal();
        return;
      case "fault": {
        const [method, path] = step.http.split(" ") as [string, string];
        const a = step.action;
        const what =
          a.kind === "status"
            ? `${a.status}${a.code ? ` ${a.code}` : ""}`
            : a.kind === "delay"
              ? `delay ${a.ms} ms`
              : "bytes" in a
                ? a.kind === "close-request" && a.bytes < 0
                  ? "reset"
                  : `${a.kind} after ${a.bytes} bytes`
                : a.kind;
        world.proxy.rules.push({
          ...(method !== "*" ? { method } : {}),
          path: globRegex(path),
          nth: step.nth,
          times: step.times,
          seen: 0,
          fired: 0,
          action: a,
          label: `${step.http} #${step.nth}${step.times === 1 ? "" : ` ×${step.times}`} → ${what}`,
        });
        return;
      }
      case "background": {
        if (this.runs.has(step.as)) this.fail(`a run named '${step.as}' already exists`);
        this.mark = world.proxy.requests.length;
        const run: Run = {
          name: step.as,
          what: describeStep(step.step),
          settled: false,
          promise: Promise.resolve(),
        };
        run.promise = this.inner(step.step, run).then(
          () => {
            run.settled = true;
          },
          (err) => {
            run.settled = true;
            run.error = err;
          },
        );
        this.runs.set(step.as, run);
        return;
      }
      case "join":
        for (const name of step.names) await this.join(name);
        return;
      case "await": {
        const deadline = Date.now() + step.timeoutMs;
        while (world.proxy.matching(step.request, this.mark).length < step.nth) {
          if (Date.now() > deadline) {
            this.fail(`no ${step.request} reached the proxy within ${step.timeoutMs} ms`);
          }
          await Bun.sleep(10);
        }
        return;
      }
      case "daemon": {
        this.mark = world.proxy.requests.length;
        const args = [
          "daemon",
          ...(step.keepAlive ? ["--keep-alive"] : []),
          ...(step.idle ? ["--idle", step.idle] : []),
        ];
        const child = world.spawn(args, `daemon (${step.as})`);
        const run: Run = {
          name: step.as,
          what: args.join(" "),
          settled: false,
          child,
          promise: Promise.resolve(),
        };
        run.promise = child.done.then((exit) => {
          run.settled = true;
          if (exit.signal && !child.killed) run.error = new Error(`died of ${exit.signal}`);
          else if (exit.code !== null && exit.code !== 0) {
            run.error = new Error(`exited ${exit.code}: ${exit.err.slice(-500)}`);
          }
        });
        this.runs.set(step.as, run);
        return;
      }
      case "stop":
      case "kill": {
        const run = this.runs.get(step.name) as Run;
        if (!run.child) this.fail(`'${step.name}' has no process of its own to ${step.kind}`);
        await world.procs.kill(run.child, step.kind === "stop" ? "SIGTERM" : "SIGKILL");
        await run.promise;
        return;
      }
      case "wait":
        await Bun.sleep(step.ms);
        return;
      case "expect":
        return this.expect(step);
      case "settle":
        return this.settle(step.allow, step.max);
    }
  }

  private async join(name: string): Promise<void> {
    const run = this.runs.get(name) as Run;
    const done = await Promise.race([
      run.promise.then(() => true),
      Bun.sleep(90_000).then(() => false),
    ]);
    if (!done) this.fail(`'${name}' (${run.what}) did not finish within 90 s`);
    if (run.error) {
      const message = run.error instanceof Error ? run.error.message : String(run.error);
      this.fail(`'${name}' (${run.what}) failed`, message.split("\n"));
    }
  }

  // --- invariants after every step -------------------------------------------------------

  private async invariants(): Promise<void> {
    if (this.world.errors.length > 0) this.fail("the harness saw a problem", this.world.errors);
    const server = this.world.server;
    if (server?.exited && !server.killed) {
      this.fail("seshi serve exited by itself", this.world.serverLog().split("\n").slice(-20));
    }
    const state = this.state();
    const problems: string[] = [];
    for (const [key, s] of Object.entries(state.sessions)) {
      const size = sizeOf(s.path);
      if (size === undefined) continue;
      // 1. The laptop's offsets never run past the transcript.
      if ((s.file_offset ?? 0) > size && !this.shrunk.has(s.session_id)) {
        problems.push(
          `${key}: file_offset ${s.file_offset} is past the transcript's ${size} bytes`,
        );
      }
      // 2. Nothing past a frozen offset is stored; the stop moves only after a lost answer
      //    (a proxy rule fired since).
      if (!s.frozen) this.frozenSeen.delete(key);
      else {
        const pointer = await this.pointer(uploadId(s));
        const stored = pointer?.status === "stored" ? (pointer.normalized?.records ?? 0) : 0;
        const faults = this.world.proxy.log.length;
        let seen = this.frozenSeen.get(key);
        if (!seen || (s.frozen.offset > seen.offset && faults > seen.faults)) {
          seen = { offset: s.frozen.offset, faults, held: stored };
          this.frozenSeen.set(key, seen);
        } else if (s.frozen.offset > seen.offset) {
          problems.push(
            `${key}: the pause stopped it at ${seen.offset} bytes; the stop moved to ${s.frozen.offset} with no lost answer`,
          );
        }
        const allowed = Math.max(
          seen.held,
          s.path ? this.recordsOf(s.path, Math.min(seen.offset, size)) : 0,
        );
        if (stored > allowed) {
          problems.push(
            `${key}: stopped at ${seen.offset} bytes (${allowed} records), yet the server holds ${stored} records`,
          );
        }
      }
    }
    if (problems.length > 0) this.fail("an invariant broke", problems);

    // 3. No planted secret anywhere in the bucket.
    if (this.world.planted) {
      for (const { path, text } of this.bucketTexts()) {
        for (const secret of SECRETS) {
          if (text.includes(secret)) {
            this.fail("a planted secret is stored", [
              `${secret.slice(0, 6)}… in ${path.slice(this.world.dir.length + 1)}`,
            ]);
          }
        }
      }
    }

    // 4. checkStore finds no errors, read while nothing of the scenario's is writing.
    if (!this.busy()) {
      const report = await checkStore(this.world.store);
      const errors = report.findings.filter((f) => f.severity === "error");
      if (errors.length > 0) this.fail("checkStore found errors", errors.map(findingLine));
    }
  }

  // --- quiet ----------------------------------------------------------------------------

  private nextWake(): number | undefined {
    const now = Date.now();
    let next: number | undefined;
    for (const s of Object.values(this.state().sessions)) {
      if (s.toggle === "off" && s.retract !== "pending") continue;
      for (const at of [s.next_attempt_at, s.rebuild?.not_before]) {
        if (!at) continue;
        const ms = Date.parse(at);
        if (ms > now && (next === undefined || ms < next)) next = ms;
      }
    }
    return next;
  }

  /** Join the background runs, stop long-running daemons, then passes (sleeping until the next
   * retry when only retries are left) until nothing is left to do; then the quiet checks. */
  private async settle(allow: string[], max: number): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.settled) continue;
      if (run.child?.label.startsWith("daemon (")) {
        await this.world.procs.kill(run.child, "SIGTERM");
      }
      await this.join(run.name);
    }
    if (!this.world.serverUp) this.fail("settle needs the server: add a restart-server step");
    let quiet = false;
    for (let i = 0; i < max; i++) {
      const outcome = await this.pass();
      this.lastPass = outcome;
      await this.invariants();
      const summary = outcome.summary;
      if (!summary) this.fail("settle's pass did not run (an uploader is still running?)");
      const worked = summary.taken + summary.found + summary.uploaded + summary.retracted > 0;
      const wake = this.nextWake();
      if (!worked && summary.queued === 0 && wake === undefined) {
        quiet = true;
        break;
      }
      if (!worked && wake !== undefined) {
        const ms = wake - Date.now() + 200;
        if (ms > 70_000) {
          this.fail(`settle would wait ${Math.round(ms / 1000)} s of real time for a retry`);
        }
        await Bun.sleep(Math.max(0, ms));
      }
    }
    if (!quiet) {
      this.fail(`not quiet after ${max} passes`, [
        `last pass: ${JSON.stringify(this.lastPass?.summary)}`,
        ...Object.entries(this.state().sessions).map(([k, s]) => `${k}: ${JSON.stringify(s)}`),
      ]);
    }
    const pending = this.world.proxy.pending();
    if (pending.length > 0) {
      this.fail(
        "quiet, but proxy rules are still armed (heal them, or they never matched)",
        pending,
      );
    }
    await this.quietChecks(allow);
  }

  private async doctor(args: string[]): Promise<DoctorSession[]> {
    const run = await this.world.run(["doctor", "--json", ...args], { label: "doctor" });
    if (!run.out) this.fail(`seshi doctor printed nothing (exit ${run.code})`, [run.err]);
    return (JSON.parse(run.out) as { sessions: DoctorSession[] }).sessions;
  }

  private async quietChecks(extraAllow: string[]): Promise<void> {
    const failing: string[] = [];
    for (const session of await this.doctor(["--since", "3650d"])) {
      for (const check of session.checks) {
        if (check.status !== "fail") continue;
        failing.push(`${session.session_id}: ${check.id}: ${check.summary}`);
        for (const line of check.detail ?? []) failing.push(`    ${line}`);
      }
    }
    if (failing.length > 0) this.fail("once quiet, seshi doctor fails a check", failing);

    const allow = new Set([...this.scenario.setup.allow, ...extraAllow]);
    const report = await checkStore(this.world.store);
    const bad = report.findings.filter((f) => f.severity === "error" || !allow.has(f.code));
    if (bad.length > 0) this.fail("once quiet, checkStore is not clean", bad.map(findingLine));

    const problems: string[] = [];
    for (const [key, s] of Object.entries(this.state().sessions)) {
      if (s.agent !== AGENT) continue;
      const id = uploadId(s);
      const current = await this.pointer(id);
      const previous = retractedId(s);
      if (previous !== undefined && s.retract === "done") {
        const old = await this.pointer(previous);
        if (old && old.status !== "redacted") {
          problems.push(`${key}: retracted, but ${previous} is still ${old.status}`);
        }
      }
      if (s.toggle === "off") {
        if (current && current.status !== "redacted") {
          problems.push(`${key}: turned off, but ${id} is ${current.status} on the server`);
        }
      } else if (s.sent && s.stored) {
        if (current?.status !== "stored") {
          problems.push(
            `${key}: stored from here, but the server has ${current?.status ?? "nothing"} for ${id}`,
          );
        }
      } else if (current && current.status === "stored") {
        problems.push(`${key}: never stored from here, but the server holds ${id}`);
      }
    }
    if (problems.length > 0)
      this.fail("once quiet, the server does not match the laptop", problems);
  }

  // --- expect ---------------------------------------------------------------------------

  private async expect(step: ProcessExpect): Promise<void> {
    const problems: string[] = [];
    if (step.pass) {
      const last = this.lastPass;
      if (!last) this.fail("expects a pass summary, but no pass ran");
      if (!last.summary) {
        problems.push(
          `pass: the last pass ${last.killed ? "was killed" : "found another uploader running"}; it has no summary`,
        );
      } else {
        for (const [k, v] of Object.entries(step.pass)) {
          const got = (last.summary as unknown as Record<string, unknown>)[k] ?? 0;
          if (got !== v) problems.push(`pass.${k}: expected ${v}, got ${got}`);
        }
      }
    }
    for (const [name, facts] of Object.entries(step.sessions ?? {})) {
      problems.push(...(await this.sessionFacts(name, facts)));
    }
    if (step.bucket) {
      const texts = this.bucketTexts();
      for (const text of step.bucket.has) {
        if (!texts.some((t) => t.text.includes(text))) {
          problems.push(`bucket: no object holds '${text}'`);
        }
      }
      for (const text of step.bucket.lacks) {
        const found = texts.find((t) => t.text.includes(text));
        if (found) {
          problems.push(`bucket: '${text}' is in ${found.path.slice(this.world.dir.length + 1)}`);
        }
      }
    }
    if (step["store-check"]) {
      const report = await checkStore(this.world.store);
      const warns = new Set<string>(
        report.findings.filter((f) => f.severity === "warn").map((f) => f.code),
      );
      for (const code of step["store-check"].warn) {
        if (!warns.has(code)) {
          problems.push(
            `store-check: no '${code}' warning (warnings: ${[...warns].join(", ") || "none"})`,
          );
        }
      }
    }
    if (step.log) {
      const log = this.captureLog();
      for (const text of step.log) {
        if (!log.some((l) => l.includes(text))) problems.push(`log: no line says '${text}'`);
      }
    }
    for (const [spec, n] of Object.entries(step.requests ?? {})) {
      const got = this.world.proxy.matching(spec).length;
      if (got !== n) problems.push(`requests: ${spec}: expected ${n}, got ${got}`);
    }
    if (step.started) {
      const started = step.started.of.filter((n) => this.runOutcome(n)?.started).length;
      if (started !== step.started.count) {
        problems.push(
          `started: ${started} of ${step.started.of.join(", ")} took the uploader lock, not ${step.started.count}`,
        );
      }
    }
    for (const [name, facts] of Object.entries(step.runs ?? {})) {
      const run = this.runs.get(name) as Run;
      if (!run.settled) problems.push(`runs.${name}: still running (join it first)`);
      const outcome = this.runOutcome(name);
      const say = (fact: string, expected: unknown, got: unknown) => {
        if (expected !== got) {
          problems.push(`runs.${name}: ${fact}: expected ${expected}, got ${got}`);
        }
      };
      if (facts.started !== undefined) say("started", facts.started, outcome?.started);
      if (facts.killed !== undefined) say("killed", facts.killed, run.child?.killed ?? false);
      if (facts.code !== undefined) say("code", facts.code, outcome?.code);
      for (const [k, v] of Object.entries(facts.pass ?? {})) {
        const got = (outcome?.summary as unknown as Record<string, unknown> | undefined)?.[k];
        say(`pass.${k}`, v, got ?? 0);
      }
    }
    if (step["uploader-lock"]) {
      const lock = readUploaderLock(this.world.paths);
      const got = !lock ? "absent" : pidAlive(lock.pid) ? "live" : "stale";
      if (got !== step["uploader-lock"]) {
        problems.push(
          `uploader-lock: expected ${step["uploader-lock"]}, got ${got}${lock ? ` (pid ${lock.pid})` : ""}`,
        );
      }
    }
    if (problems.length > 0) this.fail("expectation not met", problems);
  }

  /** What a named run did, as a pass. A long-running daemon that ran counts as started. */
  private runOutcome(name: string): PassOutcome | undefined {
    const run = this.runs.get(name);
    if (!run) return undefined;
    if (run.pass) return run.pass;
    if (run.child) {
      return { started: true, killed: run.child.killed, code: null };
    }
    return undefined;
  }

  private async sessionFacts(name: string, facts: SessionFacts): Promise<string[]> {
    const problems: string[] = [];
    const say = (fact: string, expected: unknown, got: unknown) => {
      if (JSON.stringify(expected) !== JSON.stringify(got)) {
        problems.push(
          `${name}: ${fact}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
        );
      }
    };
    const base = name.replace(/~\d+$/, "");
    const s = this.entry(base);
    const pointer = await this.pointer(name);
    if (facts.server) {
      const got = !pointer
        ? "absent"
        : pointer.status === "redacted"
          ? "redacted"
          : pointer.head
            ? "present"
            : "stub";
      say("server", facts.server, got);
    }
    if (facts.records !== undefined)
      say("records", facts.records, pointer?.normalized?.records ?? 0);
    if (facts.traces !== undefined) say("traces", facts.traces, pointer?.traces?.length ?? 0);
    if (facts.visibility) say("visibility", facts.visibility, pointer?.visibility);
    const laptop = (fact: string) => {
      if (!s) problems.push(`${name}: ${fact}: the laptop's state has no session ${base}`);
      return s;
    };
    if (facts.id !== undefined && laptop("id")) say("id", facts.id, uploadId(s as SessionState));
    if (facts["matches-transcript"] !== undefined && laptop("matches-transcript")) {
      const entry = s as SessionState;
      const expected = entry.path ? this.recordsOf(entry.path, entry.file_offset ?? 0) : 0;
      const got = pointer?.normalized?.records ?? 0;
      say(
        `matches-transcript (stored ${got} records, the transcript up to ${entry.file_offset ?? 0} bytes ${expected})`,
        facts["matches-transcript"],
        got === expected,
      );
    }
    if (facts["sent-all"] !== undefined && laptop("sent-all")) {
      const entry = s as SessionState;
      const size = sizeOf(entry.path) ?? 0;
      say(
        `sent-all (file_offset ${entry.file_offset ?? 0} of ${size})`,
        facts["sent-all"],
        (entry.file_offset ?? 0) === size,
      );
    }
    if (facts.frozen !== undefined && laptop("frozen")) {
      say("frozen", facts.frozen, s?.frozen !== undefined);
    }
    if (facts.toggle && laptop("toggle")) say("toggle", facts.toggle, s?.toggle ?? "none");
    if (facts.rebuild && laptop("rebuild")) {
      const rebuild = s?.rebuild;
      const got = !rebuild
        ? "none"
        : rebuild.not_before && Date.parse(rebuild.not_before) > Date.now()
          ? "waiting"
          : "due";
      say("rebuild", facts.rebuild, got);
    }
    if (facts["last-status"] && laptop("last-status")) {
      say("last-status", facts["last-status"], s?.last_status);
    }
    if (facts.retract && laptop("retract")) say("retract", facts.retract, s?.retract ?? "none");
    if (facts.doctor) {
      const doctor = (await this.doctor(["--session", base, "--agent", AGENT]))[0];
      const failing = (doctor?.checks ?? []).filter((c) => c.status === "fail");
      const ids = failing.map((c) => c.id).sort();
      const expected = facts.doctor === "ok" ? [] : [...facts.doctor].sort();
      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        problems.push(
          `${name}: doctor: expected ${expected.length ? `failing ${expected.join(", ")}` : "ok"}, got ${ids.length ? `failing ${ids.join(", ")}` : "ok"}`,
          ...failing.map((c) => `    ${c.id}: ${c.summary}`),
        );
      }
    }
    return problems;
  }

  // --- the whole run --------------------------------------------------------------------

  async all(): Promise<number> {
    const steps = this.scenario.steps;
    for (let i = 0; i < steps.length; i++) {
      this.index = i + 1;
      this.step = steps[i] as Step;
      try {
        await this.run(this.step);
      } catch (err) {
        if (err instanceof ScenarioFailure) throw err;
        this.fail((err as Error).message ?? String(err));
      }
      if (this.step.kind !== "settle") await this.invariants();
    }
    if (steps.at(-1)?.kind !== "settle") {
      this.index = steps.length + 1;
      this.step = undefined;
      await this.settle([], 40);
    }
    return this.passes;
  }
}

export interface RunOptions {
  /** Keep the scenario's folder (logs, bucket, state) when it fails. */
  keepOnFailure?: boolean;
  /** Print every request the proxy saw, and what became of it. */
  trace?: boolean;
}

/** Run one process-mode scenario. Throws `ScenarioFailure` with the step and evidence when it
 * fails. Every process it started is killed, by pid, before it returns or throws; a process left
 * over after that is itself a failure. */
export async function runProcessScenario(
  scenario: Scenario,
  options: RunOptions = {},
): Promise<RunReport> {
  const started = performance.now();
  const world = new World(scenario);
  const runner = new Runner(world);
  let passes = 0;
  let failed: unknown;
  try {
    await world.start();
    passes = await runner.all();
  } catch (err) {
    failed = err;
  }
  const keep = failed !== undefined && options.keepOnFailure === true;
  const running = world.procs.running().map((c) => `${c.label} (pid ${c.pid})`);
  if (options.trace) {
    for (const r of world.proxy.requests) {
      console.log(
        `    #${r.n} ${r.method} ${r.path} → ${r.status ?? "-"}${r.rule ? ` [${r.rule}]` : ""}${r.outcome && r.outcome !== "answered" ? ` (${r.outcome})` : ""}`,
      );
    }
  }
  await world.stop(keep);
  const survivors = world.procs.survivors();
  if (failed !== undefined) {
    const message = failed instanceof Error ? failed.message : String(failed);
    const extra = [
      ...(keep ? [`  (its folder is kept: ${world.dir})`] : []),
      ...(survivors.length > 0
        ? ["  processes left behind:", ...survivors.map((s) => `    ${s}`)]
        : []),
    ];
    const error = new ScenarioFailure([message, ...extra].join("\n"));
    error.survivors = survivors;
    error.running = running;
    throw error;
  }
  if (survivors.length > 0) {
    throw new ScenarioFailure(
      [`${scenario.file}: processes left behind after the run:`, ...survivors].join("\n  "),
    );
  }
  return {
    name: scenario.name,
    ms: Math.round(performance.now() - started),
    faults: [...world.proxy.log],
    passes,
    processes: world.procs.all.length,
    survivors,
  };
}
