/** The uploader (F9.1, F9.3, F9.7): the background process that drains the spool, sends each
 * session's new bytes with the offset and continuation protocol, retracts sessions turned off,
 * and sweeps the agents' folders for sessions hooks missed. A hook starts it when it is not
 * running; it stops after a few idle minutes (or never, with `--keep-alive` as a service).
 *
 * The protocol, per session:
 *
 * - Until the server holds a trace of the session, the whole log is sent (X6.3). A `filtered`
 *   answer keeps nothing, so the whole log goes again once the transcript grows. A `dropped`
 *   answer keeps the server's offset (a first envelope review dropped leaves a stub, F3.4), so
 *   what follows goes as a chunk from there; the server never reviews or stores the dropped
 *   part again, even when a whole log is sent later.
 * - Once it holds one, only the new complete lines go, as a chunk at the server's offset; the
 *   session filter never judges a chunk (X4.10), so an agent-only tail is never lost.
 * - 409 `offset_mismatch`: resend from `expected` (from the start when it is 0).
 * - 409 `conflict` on a whole log (rules or the normalizer changed, X4.6): resend with
 *   `replace` when this machine stored the session; otherwise it is a permanent refusal. A
 *   replace model review drops leaves the server's session as it was, which this log no
 *   longer extends: once the transcript grows it goes whole with `replace` again.
 * - A session the server lists as stale (an older normalizer built it, X4.9), or one
 *   `seshi capture resend` marks, goes whole with `rebuild`, once: the server builds and reviews
 *   it again even when the log only extends what is stored. The server is asked at most hourly,
 *   and only by a machine that stored something. A stale session waits a random time within
 *   `resendSpreadMs` (24 h) first, and a pass sends at most `rebuildsPerPass` (2) rebuilds, so a
 *   normalizer bump does not resend every session on every machine in the same hour.
 * - 403 `forbidden`, 422: permanent until the transcript changes. 401 or no credential: "sign
 *   in" (B1.6), nothing more is tried this pass. Anything else is retried with backoff, and
 *   three passes in a row of that is "upload failing".
 *
 * Every session's decision goes through the same function hooks use (F9.3). Each upload carries
 * the hash of the session's retraction secret, which stays in the state file; turning the
 * session off sends the secret to retract it (F9.7). Client-side pre-redaction (F2.4) is the
 * `preRedact` seam: the text of each piece passes through it before it is sent. */

import { createHash, randomUUID } from "node:crypto";
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
  type StaleSession,
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
  freeze,
  newSecret,
  otherFolders,
  pauseWindows,
  readState,
  type SessionState,
  seenIn,
  sendLimit,
  sessionKey,
  sessionToggle,
  stateFacts,
  updateState,
  uploadedOffset,
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

/** `git config user.email` and `user.name` in `cwd`, each bounded at 2 s, with `env` (the
 * command's environment) laid over the process's, so git reads the global config of the home
 * the command runs in (`HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`). */
export const gitIdentityIn =
  (env: Readonly<Record<string, string | undefined>> = {}): GitIdentity =>
  async (cwd) => {
    const read = async (key: string): Promise<string | undefined> => {
      try {
        const proc = Bun.spawn(["git", "-C", cwd, "config", "--get", key], {
          env: { ...process.env, ...env },
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

/** The identity in the process's own environment. */
export const gitIdentity: GitIdentity = gitIdentityIn();

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
  /** How often to ask the server which sessions are stale (X4.9). Default 1 hour. */
  staleIntervalMs?: number;
  /** A stale session's rebuild waits a random time up to this long, so the machines of a team
   * do not all resend every session in the hour a normalizer bump lands. Default 24 hours. */
  resendSpreadMs?: number;
  /** The most rebuilds one pass sends; the rest wait for the next pass. Default 2. */
  rebuildsPerPass?: number;
  /** In [0, 1): where in `resendSpreadMs` a rebuild lands. `Math.random` by default. */
  random?: () => number;
  /** Stop after this long with nothing to do. Default 5 minutes. */
  idleMs?: number;
  /** While uploads or retractions wait to retry, stay up until this long after the last
   * success (F9.1, revised 15 Nov 2026). Default 30 minutes. */
  retryWindowMs?: number;
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
  /** Of those, the uploads and retractions waiting to retry after a failure (backoff): work
   * still pending, so the pass is not idle. */
  retrying?: number;
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

/** A fresh idempotency key for a rebuild: kept in the state until the rebuild is answered, so
 * a retry after a lost answer is not built and reviewed twice (X4.7). */
export function rebuildKey(): string {
  return `rebuild-${randomUUID()}`;
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

/** A rebuild answered (or refused for good): it is not sent again, and a stale listing for the
 * same format version does not mark the session again. A newer mark (`resend` meanwhile) stays. */
function rebuilt(s: SessionState, rebuild: NonNullable<SessionState["rebuild"]>): void {
  if (rebuild.for) s.rebuilt_for = rebuild.for;
  if (s.rebuild?.key === rebuild.key) delete s.rebuild;
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
  private readonly staleIntervalMs: number;
  private readonly resendSpreadMs: number;
  private readonly rebuildsPerPass: number;
  private readonly random: () => number;
  /** Rebuilds this pass may still send. */
  private rebuildsLeft = 0;
  /** After a failed stale check, not before this (ms). */
  private nextStaleCheck = 0;
  private readonly idleMs: number;
  private readonly retryWindowMs: number;
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
    this.staleIntervalMs = options.staleIntervalMs ?? 60 * 60 * SECOND;
    this.resendSpreadMs = options.resendSpreadMs ?? 24 * 60 * 60 * SECOND;
    this.rebuildsPerPass = options.rebuildsPerPass ?? 2;
    this.random = options.random ?? Math.random;
    this.idleMs = options.idleMs ?? 5 * 60 * SECOND;
    this.retryWindowMs = options.retryWindowMs ?? 30 * 60 * SECOND;
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
   * another uploader takes the lock over. A pass whose uploads or retractions all failed, or
   * all wait in backoff, is not idle: the uploader stays up while such work is pending, for at
   * most `retryWindowMs` after its last success (F9.1), then exits as before. */
  async run(options: { signal?: AbortSignal; keepAlive?: boolean; lock?: HeldUploaderLock } = {}) {
    let lastWork = this.now().getTime();
    let lastSuccess = lastWork;
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
        let succeeded = false;
        let retrying = 0;
        try {
          const summary = await this.pass();
          worked = summary.taken + summary.found + summary.uploaded + summary.retracted > 0;
          succeeded = summary.uploaded + summary.retracted > 0;
          retrying = summary.retrying ?? 0;
        } catch (err) {
          this.log(`pass failed: ${message(err)}`);
        }
        const now = this.now().getTime();
        if (worked) lastWork = now;
        if (succeeded) lastSuccess = now;
        if (!options.keepAlive) {
          if (retrying > 0) {
            if (now - lastSuccess >= this.retryWindowMs) {
              this.log(
                `stopping with ${retrying} upload(s) or retraction(s) waiting to retry: none succeeded for ${Math.round(this.retryWindowMs / 60_000)} minutes`,
              );
              return;
            }
          } else if (now - lastWork >= this.idleMs) return;
        }
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
    this.rebuildsLeft = this.rebuildsPerPass;
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
      let session = state.sessions[key];
      if (!session || this.off(state, session)) continue;
      const agent = this.agents.get(session.agent);
      if (!agent || !this.due(session)) continue;
      const path = await this.transcriptOf(key, session, agent);
      if (!path) continue;
      const size = this.sizeOf(path);
      if (size === undefined || !this.pending(session, size)) continue;
      session = await this.startOf(key, session, agent, path, state);
      const place = placeOf(session.cwd);
      const decision = this.decision(snapshot, session, place, state);
      if (decision.frozen !== undefined && !session.frozen) {
        // Seen during a pause, or started in one: stopped where it is, for good (F9.5).
        const offset = decision.frozen;
        const at = this.now().toISOString();
        session = (await this.save(key, (s) => freeze(s, at, offset))) ?? {
          ...session,
          frozen: { at, offset },
        };
        this.log(`${key}: stopped by a pause at ${offset} bytes`);
      }
      // A stopped session is sent only up to where it stopped: a resend of what the server lost.
      if (!decision.capture && decision.frozen === undefined) continue;
      if (!this.pending(session, size)) continue;
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

    // Last, so a session stored this pass is asked about too; what it marks goes next pass.
    if (!summary.signIn) await this.checkStale();
    const backlog = this.queued(snapshot);
    summary.queued = backlog.queued;
    summary.retrying = backlog.retrying;
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
        if (entry.kind !== "capture" && entry.kind !== "seen" && entry.kind !== "paused") continue;
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
        // A folder a shared rule turns off names the transcript only for a session not known:
        // never moves a known one's path. A hook during a pause names the agent's own
        // transcript as a capture does: a stopped session's transcript that moved is followed,
        // or the sweep would forget the session, its stop and its secret (33).
        if (entry.transcript_path && (entry.kind !== "seen" || !session.path)) {
          session.path = entry.transcript_path;
        }
        if (entry.cwd) seenIn(session, entry.cwd);
        if (entry.parent_session_id) session.parent_session_id = entry.parent_session_id;
        if (entry.kind === "capture" && entry.final) session.final = true;
        // Seen by a hook during a pause: stopped at what it had uploaded (F9.5), unless it was
        // turned on since, which that pause never overrides.
        if (
          entry.kind === "paused" &&
          !(
            session.toggle === "on" &&
            session.toggled_at !== undefined &&
            Date.parse(session.toggled_at) >= Date.parse(entry.at)
          )
        ) {
          freeze(session, entry.at, uploadedOffset(session));
        }
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
        const started = new Date(found.startedMs).toISOString();
        // A subagent's transcript found before any hook named it goes by its parent's toggle.
        const decision = decide(
          {
            rules: snapshot.rules,
            ...(snapshot.error ? { rulesError: snapshot.error } : {}),
            place: placeOf(found.info.cwd),
            ...stateFacts(state, agent.name, undefined, now, found.info.parent_session_id),
            // A subagent found this way is judged by its parent's folders too.
            seen: otherFolders(
              state,
              agent.name,
              undefined,
              found.info.cwd,
              found.info.parent_session_id,
            ).map(placeOf),
            started,
          },
          this.host.platform,
        );
        // Found during a pause, or started in one: kept as stopped (F9.5), so neither a later
        // sweep nor a hook after the pause sends it.
        if (!decision.capture && decision.frozen === undefined) continue;
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
          started_at: started,
          ...(decision.frozen !== undefined
            ? { frozen: { at: now.toISOString(), offset: decision.frozen } }
            : {}),
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

  // --- stale sessions (X4.9) ------------------------------------------------------------

  /** Ask the server which of its sessions an older normalizer built, at most every
   * `staleIntervalMs`, and mark the ones this machine stored for a whole resend with `rebuild`.
   * A session already rebuilt for the same format version is not marked again, so a rebuild
   * that changed nothing on the server (model review dropped it) is not sent every hour. A
   * session turned off is never marked. Only a machine that stored something asks, so a pass
   * with nothing to send still opens no sink. */
  private async checkStale(): Promise<void> {
    const now = this.now();
    const state = readState(this.paths);
    const last = state.uploader?.last_stale_check;
    if (last && now.getTime() - Date.parse(last) < this.staleIntervalMs) return;
    if (now.getTime() < this.nextStaleCheck) return;
    if (!Object.values(state.sessions).some((s) => s.stored)) return;
    let stale: StaleSession[];
    try {
      const sink = await this.getSink();
      stale = sink.stale ? await sink.stale() : [];
    } catch (err) {
      // A sign-in the uploads report; anything else is tried again a while later.
      if (!(err instanceof SignInNeeded)) {
        this.log(`could not ask which sessions are stale: ${message(err)}`);
      }
      this.nextStaleCheck = now.getTime() + this.retryMaxMs;
      return;
    }
    const listed = new Map(stale.map((s) => [`${s.agent}\n${s.session_id}`, s]));
    let marked = 0;
    await updateState(this.paths, (st) => {
      for (const session of Object.values(st.sessions)) {
        const agent = this.agents.get(session.agent);
        if (!agent || !session.stored || session.rebuild || this.off(st, session)) continue;
        const entry = listed.get(`${agent.format}\n${uploadId(session)}`);
        if (!entry || session.rebuilt_for === entry.current) continue;
        // A random time within the spread: one normalizer bump marks every session of its
        // formats stale on every machine at once, and the server reviews each rebuild again.
        const wait = Math.floor(this.random() * this.resendSpreadMs);
        session.rebuild = {
          at: now.toISOString(),
          key: rebuildKey(),
          for: entry.current,
          not_before: new Date(now.getTime() + wait).toISOString(),
        };
        marked++;
      }
      st.uploader = { ...st.uploader, last_stale_check: now.toISOString() };
    });
    if (marked > 0) {
      this.log(
        `${marked} session(s) were built by an older normalizer; resending them whole within ${Math.round(this.resendSpreadMs / 3_600_000)}h`,
      );
    }
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
        ...stateFacts(state, session.agent, session, this.now()),
        seen: otherFolders(state, session.agent, session, place.cwd).map(placeOf),
      },
      this.host.platform,
    );
  }

  /** Turned off, by its own toggle or its parent's, or waiting for its retraction: nothing more
   * of it is sent (F9.5). */
  private off(state: CaptureState, session: SessionState): boolean {
    return session.retract === "pending" || sessionToggle(state, session.agent, session) === "off";
  }

  /** A rebuild whose time has come (one `seshi capture resend` marked has no wait). */
  private rebuildDue(rebuild: NonNullable<SessionState["rebuild"]>): boolean {
    return !rebuild.not_before || Date.parse(rebuild.not_before) <= this.now().getTime();
  }

  /** Not waiting for a retry. */
  private due(session: SessionState): boolean {
    return !session.next_attempt_at || Date.parse(session.next_attempt_at) <= this.now().getTime();
  }

  /** Whether `session` has something to send at transcript size `size`: only up to where a
   * pause stopped it, when one did. */
  private pending(session: SessionState, size: number): boolean {
    if (size === 0) return false;
    if (session.error?.permanent && session.error.size === size) return false;
    const limit = sendLimit(session, size);
    // A rebuild sends the whole log, up to where a pause stopped the session (F9.5). One still
    // waiting for its time leaves the session to its ordinary chunks meanwhile.
    if (session.rebuild && this.rebuildDue(session.rebuild)) return limit > 0;
    if (!session.stored) return limit > 0 && session.held_at_size !== limit;
    return limit !== (session.file_offset ?? 0);
  }

  /** When a session not yet sent started, recorded once while any pause is recorded: one that
   * started during a pause is off even when first seen after it (F9.5). */
  private async startOf(
    key: string,
    session: SessionState,
    agent: CaptureAgent,
    path: string,
    state: CaptureState,
  ): Promise<SessionState> {
    if (session.started_at || session.sent || pauseWindows(state).length === 0) return session;
    const info = identifySafely(agent, path, readHead(path));
    let started = info?.started_at;
    if (!started || !Number.isFinite(Date.parse(started))) {
      try {
        const birth = statSync(path).birthtimeMs;
        started = birth > 0 ? new Date(birth).toISOString() : undefined;
      } catch {
        started = undefined;
      }
    }
    if (!started) return session;
    const at = started;
    return (
      (await this.save(key, (s) => {
        s.started_at = at;
      })) ?? { ...session, started_at: at }
    );
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

  /** Sessions with something not yet uploaded that the rules capture (up to where a pause
   * stopped them), and how many of those, retractions included, wait to retry after a failure. */
  private queued(snapshot: RulesSnapshot): { queued: number; retrying: number } {
    const state = readState(this.paths);
    let queued = 0;
    let retrying = 0;
    const count = (session: SessionState) => {
      queued++;
      if (session.next_attempt_at !== undefined && session.error?.permanent !== true) retrying++;
    };
    for (const session of Object.values(state.sessions)) {
      if (session.retract === "pending") {
        count(session);
        continue;
      }
      if (this.off(state, session) || !session.path) continue;
      const size = this.sizeOf(session.path);
      if (size === undefined || !this.pending(session, size)) continue;
      const decision = this.decision(snapshot, session, placeOf(session.cwd), state);
      if (!decision.capture && decision.frozen === undefined) continue;
      const judged =
        decision.frozen !== undefined && !session.frozen
          ? { ...session, frozen: { at: "", offset: decision.frozen } }
          : session;
      if (this.pending(judged, size)) count(session);
    }
    return { queued, retrying };
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
      // A repo's config may only narrow who reads its sessions (X5.10): a committed
      // `visibility = "org"` (a cloned repo, a PR branch checked out for review) must not widen
      // the sessions of someone whose token keeps them private, so only `owner` is sent.
      ...(repo?.config.visibility === "owner" ? { visibility: "owner" as const } : {}),
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
    /** This sync took one of the pass's rebuilds. */
    let rebuilding = false;
    for (;;) {
      const current = readState(this.paths);
      const session = current.sessions[key];
      // Turned off (or forgotten) while it was being sent: stop; the retraction comes next.
      if (!session || this.off(current, session)) return { uploaded };
      const fileOffset = session.file_offset ?? 0;
      // A session a pause stopped is never sent past where it stopped, whatever the reason for
      // sending (a 409's whole resend, a moved transcript, a replace): read afresh every piece,
      // so a pause that starts mid-session stops it between pieces.
      const limit = sendLimit(session, size);
      // A transcript that moved (a later hook named another file) is not where the offsets
      // point: it goes whole, and the server's own state says what it extends (04).
      const moved = session.sent_path !== undefined && session.sent_path !== path;
      // A replace that review dropped left the server's session as it was: replace it again.
      const replaceAgain = session.stored === true && session.replace_next === true;
      // Stale on the server, or `seshi capture resend`: the whole log, built and reviewed again,
      // once its time has come and while the pass has rebuilds left (the rest go next pass).
      if (!rebuilding && session.rebuild && this.rebuildDue(session.rebuild)) {
        if (this.rebuildsLeft > 0) {
          this.rebuildsLeft--;
          rebuilding = true;
        }
      }
      const rebuild = rebuilding ? session.rebuild : undefined;
      const whole =
        forceWhole ||
        moved ||
        !session.stored ||
        limit < fileOffset ||
        !agent.chunkable ||
        replaceAgain ||
        rebuild !== undefined;
      const replacing = replace || replaceAgain;
      if (!whole && fileOffset >= limit) return { uploaded };
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
      const piece = this.piece(path, whole ? 0 : fileOffset, limit, agent.encoding, whole);
      if (!piece) return { uploaded };

      // The secret is kept before its hash is ever sent, so a crash cannot lose it.
      let secret = session.secret;
      if (!secret || !session.sent) {
        secret ??= newSecret();
        const kept = secret;
        let stopped = false;
        await updateState(this.paths, (state) => {
          const s = state.sessions[key];
          // Turned off since the read above: `capture off` (under this same lock) saw `sent`
          // unset, asked for no retraction and said nothing was uploaded, so nothing may go.
          if (!s || this.off(state, s)) {
            stopped = true;
            return false;
          }
          s.secret = kept;
          s.sent = true;
        });
        if (stopped) return { uploaded };
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
          ...(rebuild
            ? { rebuild: true, idempotency_key: rebuild.key }
            : replacing
              ? { replace: true }
              : {}),
        };
        // A replace (a rebuild is one) proves this machine uploaded the session with its
        // retraction secret (F9.7): with the org key a stated username is not enough (X5.12).
        result = await (await this.getSink()).ingest(
          upload,
          replacing || rebuild ? { retractSecret: secret } : {},
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
              // The last answer's records and prefix describe a log the server has moved past;
              // with nothing left to send, no answer would replace them, and the doctor would
              // compare the server with a stale answer (33). The next answer sets them again.
              delete s.shipped;
              // The server already holds past where a pause stopped the session (a piece whose
              // answer was lost): it keeps that, and nothing past it is sent.
              if (s.frozen && s.frozen.offset < expected) s.frozen.offset = expected;
            });
          }
          continue;
        }
        if (
          err instanceof SessionConflict &&
          whole &&
          (session.stored || session.sent) &&
          !replacing
        ) {
          // This machine stored the session and its log no longer extends it (rules or the
          // normalizer changed, X4.6): only its original writer may replace it, and that is us.
          // `sent` too: an earlier upload whose answer was lost may have stored it (`stored` is
          // only set from an answer), and a rewrite since (a compaction) makes this whole log a
          // conflict. The replace carries the secret, which the server checks against the
          // stored session's hash, so one another machine stored still refuses it (403).
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
        // A rebuild the server refuses (another machine wrote the session, say) is not tried
        // again: the session's next bytes go as they would have without it.
        if (rebuild) await this.save(key, (s) => rebuilt(s, rebuild));
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
        // A pause that began while this piece was on its way stopped the session at what it had
        // uploaded before; the server holds this piece too, so the stop moves to its end.
        if (stored && s.frozen && s.frozen.offset < piece.end) s.frozen.offset = piece.end;
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
          if ((replacing || rebuild) && result.status === "dropped") s.replace_next = true;
          else delete s.replace_next;
        } else {
          // Nothing kept (filtered): the whole log goes again once the transcript grows.
          s.file_offset = 0;
          s.server_offset = 0;
          s.held_at_size = limit;
          delete s.sent_path;
          delete s.shipped;
          delete s.carried;
          delete s.replace_next;
        }
        if (rebuild) rebuilt(s, rebuild);
      });
      if (!stored || piece.end >= limit) return { uploaded };
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
        "rebuild",
        "rebuilt_for",
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
