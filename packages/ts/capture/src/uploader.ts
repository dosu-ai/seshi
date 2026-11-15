/** The uploader (F9.1, F9.3, F9.7): the background process that drains the spool, sends each
 * session's new bytes with the offset and continuation protocol, retracts sessions turned off,
 * and sweeps the agents' folders for sessions hooks missed. A hook starts it when it is not
 * running; it stops after a few idle minutes (or never, with `--keep-alive` as a service).
 *
 * The protocol, per session:
 *
 * - Until the server holds a trace of the session, the whole log is sent (X6.3). A `filtered`
 *   or `dropped` answer keeps nothing, so the whole log goes again once the transcript grows.
 * - Once it holds one, only the new complete lines go, as a chunk at the server's offset; the
 *   session filter never judges a chunk (X4.10), so an agent-only tail is never lost.
 * - 409 `offset_mismatch`: resend from `expected` (from the start when it is 0).
 * - 409 `conflict` on a whole log (rules or the normalizer changed, X4.6): resend with
 *   `replace` when this machine stored the session; otherwise it is a permanent refusal. A
 *   replace model review drops leaves the server's session as it was, which this log no
 *   longer extends: once the transcript grows it goes whole with `replace` again.
 * - 403 `forbidden`, 422: permanent until the transcript changes. 401 or no credential: "sign
 *   in" (B1.6), nothing more is tried this pass. Anything else is retried with backoff, and
 *   three passes in a row of that is "upload failing".
 *
 * Every session's decision goes through the same function hooks use (F9.3). Each upload carries
 * the hash of the session's retraction secret, which stays in the state file; turning the
 * session off sends the secret to retract it (F9.7). Client-side pre-redaction (F2.4) is the
 * `preRedact` seam: the text of each piece passes through it before it is sent. */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ServerError } from "@seshi/client";
import type { CaptureAgent, CaptureHost } from "@seshi/kit";
import {
  type Claims,
  Forbidden,
  OffsetMismatch,
  SessionConflict,
  SessionRejected,
  type StoreSessionResult,
  type Upload,
} from "@seshi/model";
import { appendLog } from "./files";
import type { CapturePaths } from "./paths";
import { placeOf } from "./place";
import { type Decision, decide, type Place } from "./rules";
import { captureRules, type RulesSnapshot } from "./rules-cache";
import { RetractRefused, type SessionSink, SignInNeeded } from "./sink";
import { readSpool, removeSpool } from "./spool";
import {
  type CaptureState,
  isPaused,
  newSecret,
  readState,
  type SessionState,
  sessionKey,
  updateState,
  uploadId,
} from "./state";
import { identifySafely, readHead, sweepAgent } from "./sweep";
import type { HeldUploaderLock } from "./uploader-lock";

/** One piece of a transcript on its way to the server, before pre-redaction. */
export interface PreRedactInput {
  /** The upload format (`claude-code`). */
  agent: string;
  encoding: "jsonl" | "json";
  text: string;
  /** What the last piece of this session left (withheld call ids); none for a whole log. */
  carried?: Record<string, unknown>;
}

/** Client-side pre-redaction (F2.4), so secrets never leave the machine. It must be
 * deterministic and keep one output line per input line, so a whole log sent again still
 * extends what was stored. Branch 07 provides one over the org's rule packs. */
export interface PreRedactor {
  redact(
    input: PreRedactInput,
  ):
    | Promise<{ text: string; carried?: Record<string, unknown> }>
    | { text: string; carried?: Record<string, unknown> };
}

/** No pre-redaction: the server's redaction is authoritative either way (F2.4). */
export const NO_PREREDACTION: PreRedactor = {
  redact: ({ text, carried }) => ({ text, ...(carried ? { carried } : {}) }),
};

/** A working copy's git identity, sent as claims (X5.5). */
export type GitIdentity = (cwd: string) => Promise<{ email?: string; name?: string }>;

/** `git config user.email` and `user.name` in `cwd`, each bounded at 2 s. */
export const gitIdentity: GitIdentity = async (cwd) => {
  const read = async (key: string): Promise<string | undefined> => {
    try {
      const proc = Bun.spawn(["git", "-C", cwd, "config", "--get", key], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      const timer = setTimeout(() => proc.kill(), 2000);
      const text = await new Response(proc.stdout).text();
      clearTimeout(timer);
      return (await proc.exited) === 0 && text.trim() ? text.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const [email, name] = await Promise.all([read("user.email"), read("user.name")]);
  return { ...(email ? { email } : {}), ...(name ? { name } : {}) };
};

export interface UploaderOptions {
  paths: CapturePaths;
  host: CaptureHost;
  /** The agents this binary captures. */
  agents: readonly CaptureAgent[];
  /** Where sessions go; built once, on first need. */
  sink: () => Promise<SessionSink>;
  /** The capture rules; from the CLI config (cached) by default. */
  rules?: () => Promise<RulesSnapshot>;
  preRedact?: PreRedactor;
  git?: GitIdentity;
  now?: () => Date;
  /** Where log lines go; the capture log by default. */
  log?: (line: string) => void;
  /** How often to sweep while running. Default 15 minutes. */
  sweepIntervalMs?: number;
  /** Stop after this long with nothing to do. Default 5 minutes. */
  idleMs?: number;
  /** How often to look at the spool. Default 2 s. */
  pollMs?: number;
  /** The most bytes one chunk carries; a longer tail goes in several. Default 8 MiB. */
  maxChunkBytes?: number;
  /** The first retry's delay; it doubles per failure in a row up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface PassOptions {
  /** Sweep now, whatever the timer says. */
  sweep?: boolean;
  /** Sweep from this time instead of when capture was installed (`seshi upload --since`). */
  sweepSince?: Date;
  /** Look only at these sessions (keys). */
  only?: ReadonlySet<string>;
}

export interface PassSummary {
  /** Spool entries taken in. */
  taken: number;
  /** Sessions the sweep found. */
  found: number;
  /** Uploads the server answered. */
  uploaded: number;
  retracted: number;
  /** Sessions refused or failing this pass. */
  failed: number;
  /** Sessions with something not yet uploaded at the end of the pass. */
  queued: number;
  /** Set when a sign-in is needed; nothing was sent after it. */
  signIn?: string;
}

const SECOND = 1000;

/** Bytes of a string in UTF-8. */
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/** The hash of a retraction secret, as the server keeps it. */
export function retractHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Whether an error is worth retrying later (the network, the server, the store) rather than a
 * refusal of this session. */
function transient(err: unknown): boolean {
  if (err instanceof ServerError) {
    return err.status >= 500 || err.status === 408 || err.status === 429;
  }
  return !(
    err instanceof SessionRejected ||
    err instanceof Forbidden ||
    err instanceof SessionConflict
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Uploader {
  private readonly paths: CapturePaths;
  private readonly host: CaptureHost;
  private readonly agents: Map<string, CaptureAgent>;
  private readonly sinkFactory: () => Promise<SessionSink>;
  private readonly rulesOf: () => Promise<RulesSnapshot>;
  private readonly preRedact: PreRedactor;
  private readonly git: GitIdentity;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly sweepIntervalMs: number;
  private readonly idleMs: number;
  private readonly pollMs: number;
  private readonly maxChunkBytes: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private sink: SessionSink | undefined;
  private readonly identities = new Map<string, Promise<{ email?: string; name?: string }>>();
  private readonly accounts = new Map<string, Record<string, string>>();

  constructor(options: UploaderOptions) {
    this.paths = options.paths;
    this.host = options.host;
    this.agents = new Map(options.agents.map((a) => [a.name, a]));
    this.sinkFactory = options.sink;
    this.rulesOf = options.rules ?? (() => captureRules(options.host, options.paths));
    this.preRedact = options.preRedact ?? NO_PREREDACTION;
    this.git = options.git ?? gitIdentity;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => appendLog(options.paths.log, `uploader: ${line}`));
    this.sweepIntervalMs = options.sweepIntervalMs ?? 15 * 60 * SECOND;
    this.idleMs = options.idleMs ?? 5 * 60 * SECOND;
    this.pollMs = options.pollMs ?? 2 * SECOND;
    this.maxChunkBytes = options.maxChunkBytes ?? 8 * 1024 * 1024;
    this.retryBaseMs = options.retryBaseMs ?? 5 * SECOND;
    this.retryMaxMs = options.retryMaxMs ?? 5 * 60 * SECOND;
  }

  private async getSink(): Promise<SessionSink> {
    this.sink ??= await this.sinkFactory();
    return this.sink;
  }

  /** Run passes until idle for `idleMs` (never, with `keepAlive`), the signal aborts, or
   * another uploader takes the lock over. */
  async run(options: { signal?: AbortSignal; keepAlive?: boolean; lock?: HeldUploaderLock } = {}) {
    let lastWork = this.now().getTime();
    const lock = options.lock;
    // A long pass (a backlog, a slow server) renews the heartbeat between sessions, so a hook
    // does not take this uploader for a hung one and start another.
    if (lock) this.heartbeat = () => lock.beat(this.now());
    try {
      while (!options.signal?.aborted) {
        if (lock && !lock.beat(this.now())) {
          this.log("another uploader took over; stopping");
          return;
        }
        let worked = false;
        try {
          const summary = await this.pass();
          worked = summary.taken + summary.found + summary.uploaded + summary.retracted > 0;
        } catch (err) {
          this.log(`pass failed: ${message(err)}`);
        }
        const now = this.now().getTime();
        if (worked) lastWork = now;
        if (!options.keepAlive && now - lastWork >= this.idleMs) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, this.pollMs);
          options.signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.heartbeat = undefined;
    }
  }

  /** Renews the running uploader's lock; false once another uploader took it over. */
  private heartbeat: (() => boolean) | undefined;

  /** Whether to go on with this pass: false once another uploader took the lock over. */
  private stillHeld(): boolean {
    if (!this.heartbeat || this.heartbeat()) return true;
    this.log("another uploader took over; stopping this pass");
    return false;
  }

  /** One pass: take in the spool, sweep when due, retract, upload, and write the summary the
   * status line reads. */
  async pass(options: PassOptions = {}): Promise<PassSummary> {
    const summary: PassSummary = {
      taken: 0,
      found: 0,
      uploaded: 0,
      retracted: 0,
      failed: 0,
      queued: 0,
    };
    summary.taken = await this.takeSpool();
    const snapshot = await this.rulesOf();
    const before = readState(this.paths);
    const sweepDue =
      options.sweep ||
      !before.uploader?.last_sweep ||
      this.now().getTime() - Date.parse(before.uploader.last_sweep) >= this.sweepIntervalMs;
    if (sweepDue) summary.found = await this.sweep(snapshot, options.sweepSince);

    let transientFailure: string | undefined;
    let succeeded = false;
    const state = readState(this.paths);
    const keys = Object.keys(state.sessions)
      .filter((k) => !options.only || options.only.has(k))
      // Oldest first; the key breaks ties, so sessions seen at the same moment go in the same
      // order whatever order the spool entries were read in.
      .sort(
        (a, b) =>
          (state.sessions[a]?.last_seen ?? "").localeCompare(state.sessions[b]?.last_seen ?? "") ||
          (a < b ? -1 : a > b ? 1 : 0),
      );

    // Retractions first: a session turned off stops before anything more of it is sent.
    for (const key of keys) {
      if (summary.signIn) break;
      const session = state.sessions[key] as SessionState;
      if (session.retract !== "pending" || !this.due(session)) continue;
      if (!this.stillHeld()) break;
      const outcome = await this.retract(key, session);
      if (outcome.signIn) summary.signIn = outcome.signIn;
      else if (outcome.ok) {
        summary.retracted++;
        succeeded = true;
      } else {
        summary.failed++;
        if (outcome.transient) transientFailure = outcome.transient;
      }
    }

    for (const key of keys) {
      if (summary.signIn) break;
      // The pass's snapshot is enough to tell what is due; `sync` reads the session afresh
      // before each piece, so a toggle set meanwhile still stops it.
      const session = state.sessions[key];
      if (!session || session.toggle === "off" || session.retract === "pending") continue;
      const agent = this.agents.get(session.agent);
      if (!agent || !this.due(session)) continue;
      const path = await this.transcriptOf(key, session, agent);
      if (!path) continue;
      const size = this.sizeOf(path);
      if (size === undefined || !this.pending(session, size)) continue;
      const place = placeOf(session.cwd);
      if (!this.decision(snapshot, session, place, state).capture) continue;
      if (!this.stillHeld()) break;
      const outcome = await this.sync(key, agent, place, path, size);
      summary.uploaded += outcome.uploaded;
      if (outcome.uploaded > 0) succeeded = true;
      if (outcome.signIn) summary.signIn = outcome.signIn;
      else if (outcome.failed) {
        summary.failed++;
        if (outcome.transient) transientFailure = outcome.transient;
      }
    }

    // A pending sign-in problem clears once a credential is there again, even with nothing to
    // send yet.
    let signedIn = succeeded;
    if (!summary.signIn && !succeeded && state.problems?.sign_in) {
      try {
        await (await this.getSink()).ready();
        signedIn = true;
      } catch (err) {
        if (err instanceof SignInNeeded) summary.signIn = err.message;
        else this.log(`could not check the credential: ${message(err)}`);
      }
    }

    summary.queued = this.queued(snapshot);
    await this.finish(summary, { succeeded, signedIn, transientFailure });
    return summary;
  }

  // --- the spool and the sweep -------------------------------------------------------------

  /** Take the spool's entries into the state file, then remove them. */
  private async takeSpool(): Promise<number> {
    const { items, unreadable } = readSpool(this.paths);
    for (const name of unreadable) this.log(`removed a spool entry it could not read: ${name}`);
    if (items.length === 0) {
      removeSpool(this.paths, unreadable);
      return 0;
    }
    await updateState(this.paths, (state) => {
      for (const { entry } of items) {
        if (entry.kind !== "capture") continue;
        if (!this.agents.has(entry.agent)) {
          this.log(`ignored a hook for an agent this binary does not know: ${entry.agent}`);
          continue;
        }
        const key = sessionKey(entry.agent, entry.session_id);
        const session: SessionState = state.sessions[key] ?? {
          agent: entry.agent,
          session_id: entry.session_id,
          first_seen: entry.at,
        };
        if (entry.transcript_path) session.path = entry.transcript_path;
        if (entry.cwd) session.cwd = entry.cwd;
        if (entry.parent_session_id) session.parent_session_id = entry.parent_session_id;
        if (entry.final) session.final = true;
        session.last_seen = entry.at;
        state.sessions[key] = session;
        // A hook that runs means capture is installed for its agent, whoever installed it
        // (seshi capture install, a plugin, managed settings): the sweep starts from here.
        state.agents[entry.agent] ??= { installed_at: entry.at };
      }
    });
    removeSpool(this.paths, [...items.map((i) => i.name), ...unreadable]);
    return items.length;
  }

  /** Look through each installed agent's folders (F9.3). New sessions the rules capture are
   * added; sessions whose transcript is gone are forgotten (unless a retraction waits). */
  private async sweep(snapshot: RulesSnapshot, since?: Date): Promise<number> {
    const now = this.now();
    const state = readState(this.paths);
    const paused = isPaused(state, now);
    const additions: SessionState[] = [];
    const paths = new Map<string, string>();
    for (const agent of this.agents.values()) {
      const installed = state.agents[agent.name]?.installed_at;
      const floor = since ?? (installed ? new Date(installed) : undefined);
      if (!floor) continue;
      for (const found of sweepAgent(agent, this.host, floor.getTime())) {
        const key = sessionKey(agent.name, found.info.session_id);
        const known = state.sessions[key];
        if (known) {
          if (known.path !== found.path) paths.set(key, found.path);
          continue;
        }
        const decision = decide(
          {
            rules: snapshot.rules,
            ...(snapshot.error ? { rulesError: snapshot.error } : {}),
            place: placeOf(found.info.cwd),
            paused,
          },
          this.host.platform,
        );
        if (!decision.capture) continue;
        additions.push({
          agent: agent.name,
          session_id: found.info.session_id,
          path: found.path,
          ...(found.info.cwd ? { cwd: found.info.cwd } : {}),
          ...(found.info.parent_session_id
            ? { parent_session_id: found.info.parent_session_id }
            : {}),
          first_seen: now.toISOString(),
          last_seen: new Date(found.mtimeMs).toISOString(),
        });
      }
    }
    await updateState(this.paths, (st) => {
      for (const session of additions) {
        const key = sessionKey(session.agent, session.session_id);
        st.sessions[key] ??= session;
      }
      for (const [key, path] of paths) {
        const session = st.sessions[key];
        if (session) session.path = path;
      }
      for (const [key, session] of Object.entries(st.sessions)) {
        if (session.retract === "pending") continue;
        if (!session.path && session.toggle) {
          // A toggle set before any hook named the transcript stays while the transcript
          // exists (F9.3): forgetting it would let a later hook or sweep capture the session.
          const found = this.agents.get(session.agent)?.locate?.(session.session_id, this.host);
          if (found) {
            session.path = found;
            continue;
          }
        }
        const gone = session.path
          ? !existsSync(session.path)
          : now.getTime() - Date.parse(session.first_seen) > 24 * 3600 * SECOND;
        if (gone) delete st.sessions[key];
      }
      st.uploader = { ...st.uploader, last_sweep: now.toISOString() };
    });
    if (additions.length > 0) this.log(`sweep found ${additions.length} session(s)`);
    return additions.length;
  }

  // --- deciding ----------------------------------------------------------------------------

  private decision(
    snapshot: RulesSnapshot,
    session: SessionState,
    place: Place,
    state: CaptureState,
  ): Decision {
    return decide(
      {
        rules: snapshot.rules,
        ...(snapshot.error ? { rulesError: snapshot.error } : {}),
        place,
        ...(session.toggle ? { toggle: session.toggle } : {}),
        paused: isPaused(state, this.now()),
      },
      this.host.platform,
    );
  }

  /** Not waiting for a retry. */
  private due(session: SessionState): boolean {
    return !session.next_attempt_at || Date.parse(session.next_attempt_at) <= this.now().getTime();
  }

  /** Whether `session` has something to send at transcript size `size`. */
  private pending(session: SessionState, size: number): boolean {
    if (size === 0) return false;
    if (session.error?.permanent && session.error.size === size) return false;
    if (!session.stored) return session.held_at_size !== size;
    return size !== (session.file_offset ?? 0);
  }

  private sizeOf(path: string): number | undefined {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }

  /** The session's transcript: as recorded, or found by the agent (a hook that did not name
   * it, as Cursor's first prompt). */
  private async transcriptOf(
    key: string,
    session: SessionState,
    agent: CaptureAgent,
  ): Promise<string | undefined> {
    if (session.path) return session.path;
    const found = agent.locate?.(session.session_id, this.host);
    if (found) {
      await this.save(key, (s) => {
        s.path = found;
      });
    }
    return found;
  }

  /** Sessions with something not yet uploaded that the rules capture. */
  private queued(snapshot: RulesSnapshot): number {
    const state = readState(this.paths);
    let n = 0;
    for (const session of Object.values(state.sessions)) {
      if (session.retract === "pending") {
        n++;
        continue;
      }
      if (session.toggle === "off" || !session.path) continue;
      const size = this.sizeOf(session.path);
      if (size === undefined || !this.pending(session, size)) continue;
      if (this.decision(snapshot, session, placeOf(session.cwd), state).capture) n++;
    }
    return n;
  }

  // --- uploading ---------------------------------------------------------------------------

  /** Change one session in the state file and return it as written. */
  private async save(
    key: string,
    step: (session: SessionState) => void,
  ): Promise<SessionState | undefined> {
    let saved: SessionState | undefined;
    await updateState(this.paths, (state) => {
      const session = state.sessions[key];
      if (!session) return false;
      step(session);
      saved = session;
    });
    return saved;
  }

  /** Back off a session after a failure worth retrying. */
  private async backoff(key: string, code: string, text: string): Promise<void> {
    await this.save(key, (s) => {
      s.failures = (s.failures ?? 0) + 1;
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (s.failures - 1));
      s.next_attempt_at = new Date(this.now().getTime() + delay).toISOString();
      s.error = { code, message: text, permanent: false, at: this.now().toISOString() };
    });
  }

  /** A refusal that will not change until the transcript does. */
  private async refuse(key: string, code: string, text: string, size: number): Promise<void> {
    this.log(`${key}: ${code}: ${text}`);
    await this.save(key, (s) => {
      s.error = { code, message: text, permanent: true, at: this.now().toISOString(), size };
      delete s.next_attempt_at;
      delete s.failures;
    });
  }

  /** The bytes of a piece to send: the complete lines from `start` (at most `maxChunkBytes` of
   * them unless `whole`), or the whole document for `json`. Null when nothing complete is
   * there yet (a line, or a document, still being written). */
  private piece(
    path: string,
    start: number,
    size: number,
    encoding: "jsonl" | "json",
    whole: boolean,
  ): { text: string; end: number } | null {
    const length = size - start;
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    let read = 0;
    try {
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    const bytes = buffer.subarray(0, read);
    if (encoding === "json") {
      const text = bytes.toString("utf8");
      try {
        JSON.parse(text);
      } catch {
        return null;
      }
      return { text, end: start + read };
    }
    let cut = bytes.lastIndexOf(0x0a);
    if (cut === -1) return null;
    if (!whole && cut + 1 > this.maxChunkBytes) {
      const capped = bytes.lastIndexOf(0x0a, this.maxChunkBytes - 1);
      cut = capped === -1 ? bytes.indexOf(0x0a) : capped;
    }
    return { text: bytes.subarray(0, cut + 1).toString("utf8"), end: start + cut + 1 };
  }

  /** What an upload says about where the session ran and who ran it. */
  private async details(session: SessionState, agent: CaptureAgent, place: Place) {
    const repo = place.repo;
    const folder = repo?.root ?? session.cwd;
    const claims: Claims = {};
    if (session.cwd) {
      let identity = this.identities.get(session.cwd);
      if (!identity) {
        identity = this.git(session.cwd).catch(() => ({}));
        this.identities.set(session.cwd, identity);
      }
      const { email, name } = await identity;
      if (email) claims.git_email = email;
      if (name) claims.git_name = name;
    }
    let accounts = this.accounts.get(agent.name);
    if (!accounts) {
      try {
        accounts = agent.accountIds?.(this.host) ?? {};
      } catch {
        accounts = {};
      }
      this.accounts.set(agent.name, accounts);
    }
    if (Object.keys(accounts).length > 0) claims.account_ids = accounts;
    return {
      ...(folder ? { project: basename(folder) } : {}),
      ...(repo?.branch ? { branch: repo.branch } : {}),
      ...(repo?.config.visibility ? { visibility: repo.config.visibility } : {}),
      ...(session.parent_session_id ? { parent_session_id: session.parent_session_id } : {}),
      ...(Object.keys(claims).length > 0 ? { claims } : {}),
    };
  }

  /** Send what `key` has not sent yet, recovering from the protocol's answers. */
  private async sync(
    key: string,
    agent: CaptureAgent,
    place: Place,
    path: string,
    size: number,
  ): Promise<{ uploaded: number; failed?: boolean; transient?: string; signIn?: string }> {
    let uploaded = 0;
    let replace = false;
    let recoveries = 0;
    let forceWhole = false;
    for (;;) {
      const session = readState(this.paths).sessions[key];
      // Turned off (or forgotten) while it was being sent: stop; the retraction comes next.
      if (!session || session.toggle === "off" || session.retract === "pending")
        return { uploaded };
      const fileOffset = session.file_offset ?? 0;
      // A transcript that moved (a later hook named another file) is not where the offsets
      // point: it goes whole, and the server's own state says what it extends (04).
      const moved = session.sent_path !== undefined && session.sent_path !== path;
      // A replace that review dropped left the server's session as it was: replace it again.
      const replaceAgain = session.stored === true && session.replace_next === true;
      const whole =
        forceWhole ||
        moved ||
        !session.stored ||
        size < fileOffset ||
        !agent.chunkable ||
        replaceAgain;
      const replacing = replace || replaceAgain;
      if (!whole && fileOffset >= size) return { uploaded };
      // A path comes from a hook payload: send only a file the agent itself says is this
      // session's transcript, never whatever file a payload named. Chunks too: a later hook
      // can name another file for a session already stored.
      const info = identifySafely(agent, path, readHead(path));
      if (info?.session_id !== session.session_id) {
        await this.refuse(
          key,
          "not_a_transcript",
          info
            ? `${path} is session ${info.session_id}'s transcript`
            : `${path} is not a ${agent.name} transcript`,
          size,
        );
        return { uploaded, failed: true };
      }
      const piece = this.piece(path, whole ? 0 : fileOffset, size, agent.encoding, whole);
      if (!piece) return { uploaded };

      // The secret is kept before its hash is ever sent, so a crash cannot lose it.
      let secret = session.secret;
      if (!secret || !session.sent) {
        secret ??= newSecret();
        const kept = secret;
        await this.save(key, (s) => {
          s.secret = kept;
          s.sent = true;
        });
      }
      let redacted: { text: string; carried?: Record<string, unknown> };
      let result: StoreSessionResult;
      try {
        // Inside the try: fetching the org's rules can need a sign-in or fail for a while, and
        // then nothing is sent, exactly as when the upload itself does.
        redacted = await this.preRedact.redact({
          agent: agent.format,
          encoding: agent.encoding,
          text: piece.text,
          ...(!whole && session.carried ? { carried: session.carried } : {}),
        });
        const upload: Upload = {
          agent: agent.format,
          session_id: uploadId(session),
          transcript: redacted.text,
          format: agent.encoding,
          offset: whole ? 0 : (session.server_offset ?? 0),
          retract_hash: retractHash(secret),
          ...(await this.details(session, agent, place)),
          // No `shipped`: the server's own state decides whether a whole log extends the
          // session (04), and a client's prefix once let a fresh tail be judged by the session
          // filter.
          ...(replacing ? { replace: true } : {}),
        };
        // A replace proves this machine uploaded the session with its retraction secret (F9.7):
        // with the org key a stated username is not enough (X5.12).
        result = await (await this.getSink()).ingest(
          upload,
          replacing ? { retractSecret: secret } : {},
        );
      } catch (err) {
        if (err instanceof SignInNeeded) return { uploaded, signIn: err.message };
        if (err instanceof OffsetMismatch && recoveries < 3) {
          recoveries++;
          const expected = err.expected;
          if (expected === 0 || session.aligned === false || expected > size) {
            // The server holds nothing (or a length this machine cannot map back): the whole log.
            forceWhole = true;
            if (expected === 0) {
              await this.save(key, (s) => {
                s.stored = false;
                s.file_offset = 0;
                s.server_offset = 0;
              });
            }
          } else {
            forceWhole = false;
            await this.save(key, (s) => {
              s.file_offset = expected;
              s.server_offset = expected;
            });
          }
          continue;
        }
        if (err instanceof SessionConflict && whole && session.stored && !replacing) {
          // This machine stored the session and its log no longer extends it (rules or the
          // normalizer changed, X4.6): only its original writer may replace it, and that is us.
          replace = true;
          recoveries++;
          continue;
        }
        if (transient(err)) {
          this.log(`${key}: will retry: ${message(err)}`);
          await this.backoff(key, "unavailable", message(err));
          return { uploaded, failed: true, transient: message(err) };
        }
        const code =
          err instanceof SessionRejected
            ? err.code
            : err instanceof SessionConflict
              ? "conflict"
              : err instanceof Forbidden
                ? "forbidden"
                : err instanceof ServerError
                  ? err.code
                  : "refused";
        await this.refuse(key, code, message(err), size);
        return { uploaded, failed: true };
      }

      uploaded++;
      const stored = result.bytes_total > 0;
      const keptLength = bytesOf(redacted.text) === bytesOf(piece.text);
      const now = this.now().toISOString();
      await this.save(key, (s) => {
        s.stored = stored;
        s.last_status = result.status;
        s.uploaded_at = now;
        delete s.error;
        delete s.failures;
        delete s.next_attempt_at;
        if (stored) {
          s.sent_path = path;
          s.file_offset = piece.end;
          s.server_offset = result.bytes_total;
          s.aligned = (whole ? true : s.aligned !== false) && keptLength;
          s.shipped = { records: result.records_total, prefix_sha256: result.prefix_sha256 };
          if (redacted.carried) s.carried = redacted.carried;
          else delete s.carried;
          delete s.held_at_size;
          // A dropped replace answers with what the server kept, which this log does not
          // extend: the offsets only wait for the transcript to grow, and then it goes whole.
          if (replacing && result.status === "dropped") s.replace_next = true;
          else delete s.replace_next;
        } else {
          // Nothing kept (filtered, or dropped before it had a trace): the whole log goes again
          // once the transcript grows.
          s.file_offset = 0;
          s.server_offset = 0;
          s.held_at_size = size;
          delete s.sent_path;
          delete s.shipped;
          delete s.carried;
          delete s.replace_next;
        }
      });
      if (!stored || piece.end >= size) return { uploaded };
      replace = false;
      forceWhole = false;
    }
  }

  // --- retracting (F9.7) -------------------------------------------------------------------

  private async retract(
    key: string,
    session: SessionState,
  ): Promise<{ ok?: boolean; transient?: string; signIn?: string }> {
    const agent = this.agents.get(session.agent);
    const reset = (s: SessionState) => {
      s.retract = "done";
      delete s.retract_error;
      if (s.sent) s.generation = (s.generation ?? 0) + 1;
      for (const field of [
        "secret",
        "sent",
        "stored",
        "file_offset",
        "server_offset",
        "aligned",
        "sent_path",
        "shipped",
        "carried",
        "held_at_size",
        "replace_next",
        "error",
        "failures",
        "next_attempt_at",
      ] as const) {
        delete s[field];
      }
      s.last_status = "retracted";
    };
    if (!session.secret || !session.sent || !agent) {
      // Nothing of it was ever sent from here.
      await this.save(key, reset);
      return { ok: true };
    }
    try {
      const outcome = await (await this.getSink()).retract(
        agent.format,
        uploadId(session),
        session.secret,
      );
      if (outcome === "absent" && session.stored) {
        // The server stored it for this machine, yet has no such session for this credential's
        // owner (uploaded under another username, before a sign-in that changed the owner):
        // never report that as retracted. Turning it off again tries again.
        const text = `${uploadId(session)} was stored from here, but the server has no such session for this credential's owner (was it uploaded under another username?); remove it with seshi sessions rm, or ask an admin`;
        this.log(`${key}: retraction found nothing: ${text}`);
        await this.save(key, (s) => {
          s.retract = "failed";
          s.retract_error = text;
        });
        return {};
      }
      this.log(
        `${key}: ${outcome === "retracted" ? "retracted" : outcome === "gone" ? "already removed on the server" : "nothing to retract on the server"}`,
      );
      await this.save(key, reset);
      return { ok: true };
    } catch (err) {
      if (err instanceof SignInNeeded) return { signIn: err.message };
      if (err instanceof RetractRefused) {
        this.log(`${key}: retraction refused: ${err.message}`);
        await this.save(key, (s) => {
          s.retract = "failed";
          s.retract_error = err.message;
        });
        return {};
      }
      this.log(`${key}: retraction will retry: ${message(err)}`);
      await this.backoff(key, "unavailable", message(err));
      return { transient: message(err) };
    }
  }

  // --- the summary the status line reads ---------------------------------------------------

  private async finish(
    summary: PassSummary,
    outcome: { succeeded: boolean; signedIn: boolean; transientFailure?: string },
  ): Promise<void> {
    const now = this.now().toISOString();
    const target = this.sink?.target;
    const worked = summary.taken + summary.found + summary.uploaded + summary.retracted > 0;
    await updateState(this.paths, (state) => {
      const failures = outcome.transientFailure
        ? (state.uploader?.failures ?? 0) + 1
        : outcome.succeeded
          ? 0
          : (state.uploader?.failures ?? 0);
      const problems = { ...state.problems };
      if (summary.signIn) {
        problems.sign_in =
          state.problems?.sign_in?.message === summary.signIn
            ? state.problems.sign_in
            : { message: summary.signIn, at: now };
      } else if (outcome.signedIn) delete problems.sign_in;
      if (failures >= 3 && outcome.transientFailure) {
        problems.upload = { message: outcome.transientFailure, at: now };
      } else if (failures === 0) delete problems.upload;
      const uploader = {
        ...state.uploader,
        queued: summary.queued,
        failures,
        ...(target ? { target } : {}),
      };
      // An idle pass that changes nothing writes nothing: the uploader looks every few seconds.
      const same =
        JSON.stringify({ ...uploader, last_run: undefined }) ===
          JSON.stringify({ ...state.uploader, last_run: undefined }) &&
        JSON.stringify(problems) === JSON.stringify(state.problems ?? {});
      if (same && !worked && state.uploader?.last_run) return false;
      state.uploader = { ...uploader, last_run: now };
      if (Object.keys(problems).length > 0) state.problems = problems;
      else delete state.problems;
    });
  }
}
