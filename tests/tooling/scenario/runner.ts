/** Runs one scenario: each step in order, the invariants after every step, and the quiet-state
 * checks at `settle` and at the end (an implicit `settle` when the scenario does not end with
 * one). A failure names the scenario file, the step's index and what it was, and carries the
 * evidence: findings, the session's state, the faults that fired, the capture log's tail. */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type CaptureState,
  readState,
  type SessionState,
  sessionKey,
  uploadId,
} from "@seshi/capture";
import type { SessionMetadata } from "@seshi/model";
import { backfillRedaction } from "@seshi/pipeline";
import { ruleRedactor } from "@seshi/redact";
import { archiveId, checkStore, type Finding, keys, sweepTraces } from "@seshi/store";
import { globRegex } from "./faults";
import type { Expect, HookEvent, Scenario, SessionFacts, Step } from "./schema";
import { LINES_PER_TURN, SECRETS, summaryLines, turnLines } from "./transcript";
import { AGENT, type SessionInfo, World } from "./world";

export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

export interface RunReport {
  name: string;
  steps: number;
  ms: number;
  /** The faults that fired, in order. */
  faults: string[];
  /** Uploader passes made, settles included. */
  passes: number;
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

const slug = (path: string) => path.replace(/[/\\.:]/g, "-");

function touch(path: string, at: Date): void {
  try {
    utimesSync(path, at, at);
  } catch {}
}

function sizeOf(path: string | undefined): number | undefined {
  if (!path) return undefined;
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** The upload id before the last retraction, as the doctor reads it. */
function retractedId(s: SessionState): string | undefined {
  const g = s.generation ?? 0;
  if (g === 0) return undefined;
  return g === 1 ? s.session_id : `${s.session_id}~${g - 1}`;
}

/** Every file in a folder, recursively. */
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
      if (statSync(path).isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(dir);
  return out;
}

interface DoctorSession {
  agent: string;
  session_id: string;
  checks: { id: string; status: string; summary: string; detail?: string[] }[];
}

class Runner {
  private index = 0;
  private step: Step | undefined;
  private passes = 0;
  /** Each frozen session's stop as first seen: how many faults had fired by then, and how many
   * records the server held. */
  private readonly frozenSeen = new Map<string, { offset: number; faults: number; held: number }>();

  constructor(private readonly world: World) {}

  private get scenario(): Scenario {
    return this.world.scenario;
  }

  // --- failures --------------------------------------------------------------------------

  private fail(message: string, evidence: string[] = []): never {
    const where = this.step
      ? `step ${this.index} (${describeStep(this.step)})`
      : this.index > this.scenario.steps.length
        ? "at the end"
        : "setup";
    const lines = [`${this.scenario.file}: ${where}: ${message}`, ...evidence.map((e) => `  ${e}`)];
    const fired = this.world.plan.log;
    if (fired.length > 0) lines.push("  faults fired:", ...fired.map((f) => `    ${f}`));
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

  /** The stored pointer of `id` (an upload id), stubs included. */
  private async pointer(id: string): Promise<SessionMetadata | null> {
    const owner = this.world.owner;
    const got = await this.world.fs.get(keys.metadata(owner, archiveId(owner, AGENT, id)));
    return got ? (JSON.parse(new TextDecoder().decode(got.body)) as SessionMetadata) : null;
  }

  /** Records the format registry makes of the transcript's first `end` bytes (complete lines). */
  private recordsOf(path: string, end?: number): number {
    let text = readFileSync(path, "utf8");
    if (end !== undefined) text = Buffer.from(text).subarray(0, end).toString("utf8");
    const cut = text.lastIndexOf("\n");
    text = cut === -1 ? "" : text.slice(0, cut + 1);
    if (!text) return 0;
    const outcome = this.world.server.formats.normalize({ source: AGENT, transcript: text });
    return outcome.records.length;
  }

  /** Every object in the bucket as text, gzipped ones unzipped. */
  private bucketTexts(): { path: string; text: string }[] {
    return walk(join(this.world.dir, "bucket")).map((path) => {
      let bytes: Uint8Array = readFileSync(path);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try {
          bytes = gunzipSync(bytes);
        } catch {}
      }
      return { path, text: new TextDecoder().decode(bytes) };
    });
  }

  private session(name: string): SessionInfo {
    const info = this.world.sessions.get(name);
    if (!info) this.fail(`no session '${name}' yet: start it with a turns step`);
    return info;
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

  private async hook(info: SessionInfo, event: Exclude<HookEvent, "none">): Promise<void> {
    const payload = {
      session_id: info.id,
      transcript_path: info.path,
      cwd: info.cwd,
      hook_event_name: event,
    };
    const run = await this.world.machine.seshi(["hook", AGENT, event], {
      stdin: JSON.stringify(payload),
    });
    if (run.code !== 0) this.fail(`seshi hook exited ${run.code}`, [run.err]);
  }

  private turnsOf(info: SessionInfo & { turns?: number }): number {
    return info.turns ?? 0;
  }

  private async turns(step: Extract<Step, { kind: "turns" }>): Promise<void> {
    let info = this.world.sessions.get(step.session) as
      | (SessionInfo & { turns?: number })
      | undefined;
    const cwd = this.folder(step.in ?? info?.cwd.slice(this.world.home.length + 1) ?? "code/app");
    if (!info) {
      info = { id: step.session, cwd, path: this.transcriptPath(step.session, cwd), turns: 0 };
      this.world.sessions.set(step.session, info);
    }
    info.cwd = cwd;
    const first = this.turnsOf(info);
    appendFileSync(
      info.path,
      turnLines(first, {
        sessionId: info.id,
        cwd,
        count: step.count,
        secret: step.secret,
        ...(step.mark ? { mark: step.mark } : {}),
        now: this.world.clock.now,
      }),
    );
    info.turns = first + step.count;
    touch(info.path, this.world.clock.now());
    if (step.secret) this.world.planted = true;
    if (step.mark) this.world.marks.push(step.mark);
    if (step.hook !== "none") await this.hook(info, step.hook);
  }

  private async subagent(step: Extract<Step, { kind: "subagent" }>): Promise<void> {
    const parent = this.session(step.parent);
    const id = `agent-${step.id}`;
    let info = this.world.sessions.get(id) as (SessionInfo & { turns?: number }) | undefined;
    if (!info) {
      const path = join(dirname(parent.path), parent.id, "subagents", `${id}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      info = { id, path, cwd: parent.cwd, parent: parent.id, turns: 0 };
      this.world.sessions.set(id, info);
    }
    // A subagent runs where it is told, else where its parent last ran.
    info.cwd = step.in ? this.folder(step.in) : parent.cwd;
    const first = this.turnsOf(info);
    appendFileSync(
      info.path,
      turnLines(first, {
        sessionId: id,
        parentId: parent.id,
        cwd: info.cwd,
        count: step.turns,
        secret: step.secret,
        ...(step.mark ? { mark: step.mark } : {}),
        now: this.world.clock.now,
      }),
    );
    info.turns = first + step.turns;
    touch(info.path, this.world.clock.now());
    if (step.secret) this.world.planted = true;
    if (step.mark) this.world.marks.push(step.mark);
    if (!step.hook) return;
    const run = await this.world.machine.seshi(["hook", AGENT, "SubagentStop"], {
      stdin: JSON.stringify({
        session_id: parent.id,
        transcript_path: parent.path,
        cwd: info.cwd,
        hook_event_name: "SubagentStop",
        agent_id: step.id,
        agent_transcript_path: info.path,
      }),
    });
    if (run.code !== 0) this.fail(`seshi hook exited ${run.code}`, [run.err]);
  }

  private async compact(step: Extract<Step, { kind: "compact" }>): Promise<void> {
    const info = this.session(step.session) as SessionInfo & { turns?: number; summaries?: number };
    const n = (info.summaries ?? 0) + 1;
    info.summaries = n;
    const summary = summaryLines(info.parent ?? info.id, info.cwd, this.world.clock.now, n);
    if (step.mode === "append") appendFileSync(info.path, summary);
    else {
      // Rewritten shorter: the first `keep` turns, then the summary.
      const lines = readFileSync(info.path, "utf8").split("\n").filter(Boolean);
      const kept = lines.slice(0, step.keep * LINES_PER_TURN);
      writeFileSync(info.path, `${kept.map((l) => `${l}\n`).join("")}${summary}`);
      this.world.shrunk.add(info.id);
    }
    touch(info.path, this.world.clock.now());
    if (step.hook !== "none") await this.hook(info, step.hook);
  }

  private async move(step: Extract<Step, { kind: "move-transcript" }>): Promise<void> {
    const info = this.session(step.session);
    const cwd = this.folder(step.to);
    const path = this.transcriptPath(info.id, cwd);
    renameSync(info.path, path);
    info.path = path;
    info.cwd = cwd;
    touch(path, this.world.clock.now());
    if (step.hook !== "none") await this.hook(info, step.hook);
  }

  // --- steps -----------------------------------------------------------------------------

  private async run(step: Step): Promise<void> {
    const world = this.world;
    switch (step.kind) {
      case "turns":
        return this.turns(step);
      case "subagent":
        return this.subagent(step);
      case "compact":
        return this.compact(step);
      case "move-transcript":
        return this.move(step);
      case "hook": {
        const info = this.session(step.session);
        if (step.in) info.cwd = this.folder(step.in);
        return this.hook(info, step.event);
      }
      case "pass": {
        const summary = await world.pass(step.sweep);
        this.passes++;
        if (summary.signIn) this.fail(`the uploader needs a sign-in: ${summary.signIn}`);
        return;
      }
      case "capture": {
        const run = await world.machine.seshi(["capture", ...step.args], {
          env: { SESHI_AGENT: AGENT, NO_COLOR: "1" },
        });
        if (run.code !== step.code) {
          this.fail(`seshi capture ${step.args.join(" ")} exited ${run.code}, not ${step.code}`, [
            ...run.out.split("\n"),
            ...run.err.split("\n"),
          ]);
        }
        return;
      }
      case "clock":
        world.clock.advance(step.ms);
        return;
      case "restart-server":
        return world.server.restart();
      case "rules":
        world.server.rules = step.set
          ? [...step.set, ...step.add]
          : [...world.server.rules, ...step.add];
        return world.server.restart();
      case "format-bump":
        if (!world.server.formats.has(step.format)) this.fail(`no format '${step.format}'`);
        world.server.bumps.set(step.format, (world.server.bumps.get(step.format) ?? 0) + 1);
        return world.server.restart();
      case "sweep": {
        const report = await sweepTraces(world.store, { now: world.clock.now });
        if (report.errors > 0) this.fail(`the sweep failed: ${report.error}`);
        return;
      }
      case "backfill": {
        const instance = world.server.instance as NonNullable<typeof world.server.instance>;
        const report = await backfillRedaction({
          store: world.store,
          redactor: ruleRedactor(instance.redaction),
          writer: { kind: "admin", principal: "admin", source_id: "redaction" },
          now: world.clock.now,
        });
        if (report.outcomes.failed > 0 || report.outcomes.conflict > 0) {
          this.fail("the backfill did not finish", [JSON.stringify(report.outcomes)]);
        }
        return;
      }
      case "review":
        if (!world.reviewer) this.fail("review is off: set 'review: true' in setup");
        world.review.queue.push(...step.answers);
        return;
      case "fault": {
        if ("http" in step) {
          if (this.scenario.setup.mode === "local") {
            this.fail("an HTTP fault needs a server: local mode uploads in-process");
          }
          const [method, path] = step.http.split(" ") as [string, string];
          const action =
            step.status !== undefined
              ? {
                  kind: "status" as const,
                  status: step.status,
                  ...(step.code ? { code: step.code } : {}),
                  ...(step.expected !== undefined ? { expected: step.expected } : {}),
                }
              : step["drop-response"]
                ? { kind: "drop-response" as const }
                : step.reset
                  ? { kind: "reset" as const }
                  : { kind: "latency" as const, ms: step.latency as number };
          const what =
            action.kind === "status"
              ? `${action.status}${"code" in action ? ` ${action.code}` : ""}`
              : action.kind;
          world.plan.http.push({
            ...(method !== "*" ? { method } : {}),
            path: globRegex(path),
            action,
            nth: step.nth,
            times: step.times,
            seen: 0,
            fired: 0,
            label: `${step.http} #${step.nth}${step.times === 1 ? "" : ` ×${step.times}`} → ${what}`,
          });
        } else {
          world.plan.store.push({
            op: step.store,
            key: globRegex(step.key),
            error: step.error,
            after: step.after,
            nth: step.nth,
            times: step.times,
            seen: 0,
            fired: 0,
            label: `store ${step.store} ${step.key} #${step.nth}${step.times === 1 ? "" : ` ×${step.times}`} → ${step.error}${step.after ? " after the write" : ""}`,
          });
        }
        return;
      }
      case "heal":
        world.plan.heal();
        return;
      case "expect":
        return this.expect(step);
      case "settle":
        return this.settle(step.allow, step.max);
    }
  }

  // --- invariants after every step -------------------------------------------------------

  private async invariants(): Promise<void> {
    const state = this.state();
    const problems: string[] = [];
    for (const [key, s] of Object.entries(state.sessions)) {
      const size = sizeOf(s.path);
      if (size === undefined) continue;
      // 1. The laptop's offsets never run past the transcript (a compaction that shrank it is
      //    allowed until the uploader has sent it again: a pass may skip it, waiting out a
      //    backoff, 33).
      if ((s.file_offset ?? 0) <= size) this.world.shrunk.delete(s.session_id);
      else if (!this.world.shrunk.has(s.session_id)) {
        problems.push(
          `${key}: file_offset ${s.file_offset} is past the transcript's ${size} bytes`,
        );
      }
      // 2. Nothing past a frozen offset is stored. The uploader moves a stop forward only when
      //    the server turns out to hold more than it knew (an answer lost on the way, a 409
      //    naming a later offset), so a stop that moves with no fault fired since is a break,
      //    and the records are judged against the stop as first seen.
      //    What the server already held when the stop was set (a piece whose answer was lost
      //    before the pause) is allowed too.
      if (!s.frozen) this.frozenSeen.delete(key);
      else {
        const pointer = await this.pointer(uploadId(s));
        const stored = pointer?.status === "stored" ? (pointer.normalized?.records ?? 0) : 0;
        const faults = this.world.plan.log.length;
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

    // 3. No planted secret anywhere in the bucket, nor in what review was sent.
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
      for (const text of this.world.review.all) {
        for (const secret of SECRETS) {
          if (text.includes(secret))
            this.fail(`review was sent a planted secret (${secret.slice(0, 6)}…)`);
        }
      }
    }

    // 4. checkStore finds no errors (warnings may be transient mid-scenario). One error is
    //    transient too: trace objects of a session whose tombstone landed but answered as failed
    //    stay until the retraction's retry removes them (`finishTombstone`, 33), so while this
    //    machine's retraction of that session is pending they are not yet a finding; once
    //    quiet they are.
    const retracting = new Set(
      Object.values(state.sessions)
        .filter((s) => s.retract === "pending")
        .map((s) => archiveId(this.world.owner, AGENT, uploadId(s))),
    );
    const report = await checkStore(this.world.store, { now: this.world.clock.now });
    const errors = report.findings.filter(
      (f) =>
        f.severity === "error" &&
        !(f.code === "redacted_trace_object" && retracting.has(f.archive_id ?? "")) &&
        !(f.code === "stub_trace_object" && this.tracePutFailed()),
    );
    if (errors.length > 0) this.fail("checkStore found errors", errors.map(findingLine));
  }

  // --- quiet ----------------------------------------------------------------------------

  /** The earliest time a session waits for (a retry, a spread rebuild), if any is ahead. */
  private nextWake(): number | undefined {
    const now = this.world.clock.ms();
    let next: number | undefined;
    for (const s of Object.values(this.state().sessions)) {
      // A session turned off waits for nothing, except a retraction: it waits out the backoff
      // an earlier failure set (uploader.ts retracts only sessions that are `due`).
      if (s.toggle === "off" && s.retract !== "pending") continue;
      for (const at of [s.next_attempt_at, s.rebuild?.not_before]) {
        if (!at) continue;
        const ms = Date.parse(at);
        if (ms > now && (next === undefined || ms < next)) next = ms;
      }
    }
    return next;
  }

  /** Passes and clock moves until nothing is left to do, then the quiet checks. */
  private async settle(allow: string[], max: number): Promise<void> {
    let quiet = false;
    for (let i = 0; i < max; i++) {
      const summary = await this.world.pass(true);
      this.passes++;
      if (summary.signIn) this.fail(`the uploader needs a sign-in: ${summary.signIn}`);
      await this.invariants();
      const worked = summary.taken + summary.found + summary.uploaded + summary.retracted > 0;
      const wake = this.nextWake();
      if (!worked && summary.queued === 0 && wake === undefined) {
        quiet = true;
        break;
      }
      if (!worked && wake !== undefined) this.world.clock.advanceTo(wake + 1000);
    }
    if (!quiet) {
      this.fail(`not quiet after ${max} passes`, [
        `last pass: ${JSON.stringify(this.world.lastPass)}`,
        ...Object.entries(this.state().sessions).map(
          ([k, s]) => `${k}: ${JSON.stringify(stateLine(s))}`,
        ),
      ]);
    }
    const pending = this.world.plan.pending();
    if (pending.length > 0) {
      this.fail("quiet, but faults are still armed (heal them, or they never matched)", pending);
    }
    await this.quietChecks(allow);
  }

  private async doctorAll(): Promise<DoctorSession[]> {
    const run = await this.world.machine.seshi(["doctor", "--json", "--since", "3650d"], {
      env: { NO_COLOR: "1" },
    });
    if (!run.out) this.fail(`seshi doctor printed nothing (exit ${run.code})`, [run.err]);
    return (JSON.parse(run.out) as { sessions: DoctorSession[] }).sessions;
  }

  private async doctorOne(name: string): Promise<DoctorSession | undefined> {
    const run = await this.world.machine.seshi(
      ["doctor", "--session", name, "--agent", AGENT, "--json"],
      { env: { NO_COLOR: "1" } },
    );
    if (!run.out) this.fail(`seshi doctor printed nothing (exit ${run.code})`, [run.err]);
    return (JSON.parse(run.out) as { sessions: DoctorSession[] }).sessions[0];
  }

  /** Whether a store fault failed a trace object's write (after it landed, or before). */
  private tracePutFailed(): boolean {
    return this.world.plan.log.some((l) => /^store put \S*\/trace\.\S+:/.test(l));
  }

  private async quietChecks(extraAllow: string[]): Promise<void> {
    // The doctor: no check fails for any session the laptop knows.
    const failing: string[] = [];
    for (const session of await this.doctorAll()) {
      for (const check of session.checks) {
        if (check.status !== "fail") continue;
        failing.push(`${session.session_id}: ${check.id}: ${check.summary}`);
        for (const line of check.detail ?? []) failing.push(`    ${line}`);
      }
    }
    if (failing.length > 0) this.fail("once quiet, seshi doctor fails a check", failing);

    // The bucket: no errors, and only the warnings the scenario allows.
    const allow = new Set([...this.scenario.setup.allow, ...extraAllow]);
    // A change entry whose write failed after it landed, or whose pointer write then failed, is
    // left behind for good by design (19, X6.4, decision 7: readers and checkers tolerate it,
    // checkStore warns, never errors). Allowed only when such a store fault fired.
    if (this.world.plan.log.some((l) => CHANGE_WRITE_FAULT.test(l))) {
      allow.add("change_orphan");
      allow.add("change_not_applied");
    }
    // A trace object written by a write that then failed (its pointer, its own answer) and
    // retried with other content, or one a failed delete left, is named by nothing: the orphan
    // sweep (F2.5) removes it once it is an hour old (32, scenario 14). Allowed once any store
    // fault fired.
    if (this.world.plan.log.some((l) => l.startsWith("store "))) allow.add("orphan_trace");
    // The same leftover in the folder of a session that is now a stub (review dropped its next
    // attempt) is checkStore's `stub_trace_object`, an error once it is older than the sweep's
    // hour, because the sweep should have removed it by then (F2.5); the scenario runs no
    // worker. Allowed only when a trace object's write failed.
    if (this.tracePutFailed()) allow.add("stub_trace_object");
    const report = await checkStore(this.world.store, { now: this.world.clock.now });
    const bad = report.findings.filter(
      (f) => !allow.has(f.code) || (f.severity === "error" && f.code !== "stub_trace_object"),
    );
    if (bad.length > 0) this.fail("once quiet, checkStore is not clean", bad.map(findingLine));

    // The server matches each session's capture decision.
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
      } else if (current && current.status === "stored" && !s.sent) {
        // Sent but never answered as stored is allowed: `stored` is set only from an answer, and
        // a session whose answer was lost and which is not sent again (a pause stopped it, F9.5;
        // it went into a folder that turns capture off, 27 #13) keeps what it uploaded without
        // ever hearing so. Quiet, nothing waits to be sent, so anything still captured would
        // have been answered by now. Invariant 2 bounds what a stopped session may hold.
        problems.push(`${key}: never sent from here, but the server holds ${id}`);
      }
    }
    if (problems.length > 0)
      this.fail("once quiet, the server does not match the laptop", problems);
  }

  // --- expect ---------------------------------------------------------------------------

  private async expect(step: Expect): Promise<void> {
    const problems: string[] = [];
    if (step.pass) {
      const last = this.world.lastPass;
      if (!last) this.fail("expects a pass summary, but no pass ran");
      for (const [k, v] of Object.entries(step.pass)) {
        const got = (last as unknown as Record<string, unknown>)[k] ?? 0;
        if (got !== v) problems.push(`pass.${k}: expected ${v}, got ${got}`);
      }
    }
    for (const [name, facts] of Object.entries(step.sessions ?? {})) {
      problems.push(...(await this.sessionFacts(name, facts)));
    }
    if (step.bucket) {
      const texts = this.bucketTexts();
      for (const text of step.bucket.has) {
        if (!texts.some((t) => t.text.includes(text)))
          problems.push(`bucket: no object holds '${text}'`);
      }
      for (const text of step.bucket.lacks) {
        const found = texts.find((t) => t.text.includes(text));
        if (found) {
          problems.push(`bucket: '${text}' is in ${found.path.slice(this.world.dir.length + 1)}`);
        }
      }
    }
    for (const { text, times } of step.reviewed ?? []) {
      const got = this.world.review.seen.filter((u) => u.includes(text)).length;
      if (got !== times)
        problems.push(`reviewed: '${text}' was sent to review ${got} time(s), not ${times}`);
    }
    if (step["store-check"]) {
      const report = await checkStore(this.world.store, { now: this.world.clock.now });
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
    if (problems.length > 0) this.fail("expectation not met", problems);
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
    if (facts.frozen !== undefined && laptop("frozen"))
      say("frozen", facts.frozen, s?.frozen !== undefined);
    if (facts.toggle && laptop("toggle")) say("toggle", facts.toggle, s?.toggle ?? "none");
    if (facts.rebuild && laptop("rebuild")) {
      const rebuild = s?.rebuild;
      const got = !rebuild
        ? "none"
        : rebuild.not_before && Date.parse(rebuild.not_before) > this.world.clock.ms()
          ? "waiting"
          : "due";
      say("rebuild", facts.rebuild, got);
    }
    if (facts["last-status"] && laptop("last-status"))
      say("last-status", facts["last-status"], s?.last_status);
    if (facts.retract && laptop("retract")) say("retract", facts.retract, s?.retract ?? "none");
    if (facts.doctor) {
      const doctor = await this.doctorOne(base);
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
      await this.run(this.step);
      // A settle already checked the invariants after each of its passes.
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

/** A fired store fault on a change entry or a session pointer, as the fault log words it. */
const CHANGE_WRITE_FAULT = /^store put \S*\/(changes\/\S+|sessions\/[^/\s]+\/metadata\.json):/;

function findingLine(f: Finding): string {
  return `${f.severity} ${f.code}: ${f.message}${f.key ? ` (${f.key})` : ""}`;
}

/** The state fields worth showing when a session is not quiet. */
function stateLine(s: SessionState): Record<string, unknown> {
  const {
    secret: _secret,
    first_seen: _first,
    folders: _folders,
    shipped: _shipped,
    carried: _carried,
    ...rest
  } = s as SessionState & { folders?: unknown };
  return rest;
}

/** Run one scenario. Throws `ScenarioFailure` with the step and evidence when it fails. */
export async function runScenario(scenario: Scenario): Promise<RunReport> {
  const started = performance.now();
  const world = new World(scenario);
  const runner = new Runner(world);
  let passes = 0;
  try {
    await world.start();
    passes = await runner.all();
  } finally {
    await world.stop();
  }
  return {
    name: scenario.name,
    steps: scenario.steps.length,
    ms: Math.round(performance.now() - started),
    faults: [...world.plan.log],
    passes,
  };
}
