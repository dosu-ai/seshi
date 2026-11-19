import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ServerError } from "@seshi/client";
import { type CaptureAgent, type CaptureHost, keptAgentDir } from "@seshi/kit";
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
import {
  type Decision,
  decide,
  type Place,
  type RepoConfig,
  turnedOff,
  turnedOnSince,
} from "./rules";
import { captureRules, type RulesSnapshot } from "./rules-cache";
import { type HoldWord, RetractRefused, type SessionSink, SignInNeeded } from "./sink";
import { readSpool, removeSpool, type SpoolEntry } from "./spool";
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
import { type FoundTranscript, identifySafely, readHead, sweepAgent } from "./sweep";
import type { HeldUploaderLock } from "./uploader-lock";

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

export const NO_PREREDACTION: PreRedactor = {
  redact: ({ text, carried }) => ({ text, ...(carried ? { carried } : {}) }),
};

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

export const gitIdentity: GitIdentity = gitIdentityIn();

export interface UploaderOptions {
  paths: CapturePaths;
  host: CaptureHost;
  agents: readonly CaptureAgent[];
  /** Where sessions go; built once, on first need. */
  sink: () => Promise<SessionSink>;
  /** A whole log the server says does not extend the stored session goes on as a new session
   * that forks it (`<id>~r<n>`, `fork_of`), never replacing it. For a machine whose transcripts
   * and upload state can be older than what it uploaded, or gone (a Cursor Cloud VM rebuilt for
   * a follow-up): its log is not to be trusted over the stored one. */
  continueOnConflict?: boolean;
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

interface PassProgress {
  succeeded: boolean;
  transientFailure?: string;
}

const SECOND = 1000;

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

function markRebuildAnswered(s: SessionState, rebuild: Rebuild): void {
  if (rebuild.for) s.rebuilt_for = rebuild.for;
  if (s.rebuild?.key === rebuild.key) delete s.rebuild;
}

function rebuildIdempotencyKey(rebuild: Rebuild, end: number): string {
  return `${rebuild.key}@${end}`;
}

type HookSpoolEntry = Extract<SpoolEntry, { kind: "capture" | "seen" | "paused" }>;

function followsTranscriptPath(
  entry: HookSpoolEntry,
  session: SessionState,
): entry is HookSpoolEntry & { transcript_path: string } {
  return !!entry.transcript_path && (entry.kind !== "seen" || !session.path);
}

function shouldRelocate(session: SessionState): boolean {
  return session.path ? !existsSync(session.path) : session.toggle !== undefined;
}

function repoVisibilityClaim(config: RepoConfig | undefined): { visibility?: "owner" } {
  return config?.visibility === "owner" ? { visibility: "owner" } : {};
}

function mustSendWhole(
  session: SessionState,
  path: string,
  limit: number,
  agent: CaptureAgent,
): boolean {
  const transcriptMoved = session.sent_path !== undefined && session.sent_path !== path;
  return (
    transcriptMoved || !session.stored || limit < (session.file_offset ?? 0) || !agent.chunkable
  );
}

function whyNotSessionTranscript(
  agent: CaptureAgent,
  path: string,
  session: SessionState,
): string | undefined {
  const info = identifySafely(agent, path, readHead(path));
  if (info?.session_id === session.session_id) return undefined;
  return info
    ? `${path} is session ${info.session_id}'s transcript`
    : `${path} is not a ${agent.name} transcript`;
}

function mayReplaceOwnSession(session: SessionState): boolean {
  return session.stored === true || session.sent === true;
}

type SessionStep = (session: SessionState) => void;

type Rebuild = NonNullable<SessionState["rebuild"]>;

interface SyncOutcome {
  uploaded: number;
  failed?: boolean;
  transient?: string;
  signIn?: string;
}

/** How the next send of one sync differs from a plain one. */
interface Retry {
  replace: boolean;
  forceWhole: boolean;
  recoveries: number;
}

/** One send: the session as read before it, what it carries and how. */
interface Attempt {
  session: SessionState;
  limit: number;
  whole: boolean;
  replacing: boolean;
  rebuild: Rebuild | undefined;
  piece: { text: string; end: number };
  secret: string;
}

interface Sent {
  result: StoreSessionResult;
  redacted: { text: string; carried?: Record<string, unknown> };
  keptLength: boolean;
}

/** What an answer leads to: the state changes to save after it, in order, then whether to send
 * again. */
interface Handled {
  saves: SessionStep[];
  next: { again: Retry } | { stop: Omit<SyncOutcome, "uploaded"> };
}

function refusalCode(err: unknown): string {
  return err instanceof SessionRejected
    ? err.code
    : err instanceof SessionConflict
      ? "conflict"
      : err instanceof Forbidden
        ? "forbidden"
        : err instanceof ServerError
          ? err.code
          : "refused";
}

function onOffsetMismatch(expected: number, attempt: Attempt, retry: Retry, size: number): Handled {
  const recoveries = retry.recoveries + 1;
  if (expected === 0 || attempt.session.aligned === false || expected > size) {
    return {
      saves:
        expected === 0
          ? [
              (s) => {
                s.stored = false;
                s.file_offset = 0;
                s.server_offset = 0;
              },
            ]
          : [],
      next: { again: { ...retry, forceWhole: true, recoveries } },
    };
  }
  return {
    saves: [
      (s) => {
        s.file_offset = expected;
        s.server_offset = expected;
        delete s.shipped;
        if (s.frozen && s.frozen.offset < expected) s.frozen.offset = expected;
      },
    ],
    next: { again: { ...retry, forceWhole: false, recoveries } },
  };
}

/** A new session that forks the one stored, whose start this log is not (`continueOnConflict`):
 * the next continuation id, sent whole. */
function onConflictContinue(retry: Retry): Handled {
  return {
    saves: [
      (s) => {
        // What this machine stored under the old id is still its own to retract.
        if (s.stored) s.retract_also = [...(s.retract_also ?? []), uploadId(s)];
        s.fork_of = uploadId(s);
        s.continuation = (s.continuation ?? 0) + 1;
        for (const field of [
          "stored",
          "file_offset",
          "server_offset",
          "aligned",
          "sent_path",
          "shipped",
          "carried",
          "replace_next",
        ] as const) {
          delete s[field];
        }
      },
    ],
    next: { again: { ...retry, forceWhole: true, recoveries: retry.recoveries + 1 } },
  };
}

function onConflictReplaceOwn(retry: Retry): Handled {
  return {
    saves: [],
    next: { again: { ...retry, replace: true, recoveries: retry.recoveries + 1 } },
  };
}

export class Uploader {
  private readonly paths: CapturePaths;
  private readonly host: CaptureHost;
  private readonly agents: Map<string, CaptureAgent>;
  private readonly sinkFactory: () => Promise<SessionSink>;
  /** The status word of the last hold this pass met (`SignInNeeded.word`). */
  private holdWord: HoldWord = "sign in";
  private readonly rulesOf: () => Promise<RulesSnapshot>;
  private readonly preRedact: PreRedactor;
  private readonly git: GitIdentity;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly sweepIntervalMs: number;
  private readonly logged = new Set<string>();
  private readonly staleIntervalMs: number;
  private readonly resendSpreadMs: number;
  private readonly rebuildsPerPass: number;
  private readonly random: () => number;
  private rebuildsLeft = 0;
  private nextStaleCheck = 0;
  private readonly idleMs: number;
  private readonly retryWindowMs: number;
  private readonly pollMs: number;
  private readonly maxChunkBytes: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly continueOnConflict: boolean;
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
    this.continueOnConflict = options.continueOnConflict ?? false;
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

  private heartbeat: (() => boolean) | undefined;

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

    const state = readState(this.paths);
    const keys = Object.keys(state.sessions)
      .filter((k) => !options.only || options.only.has(k))
      .sort(
        (a, b) =>
          (state.sessions[a]?.last_seen ?? "").localeCompare(state.sessions[b]?.last_seen ?? "") ||
          (a < b ? -1 : a > b ? 1 : 0),
      );
    const retracted = await this.retractPending(keys, state, summary);
    const uploaded = await this.uploadPending(keys, state, snapshot, summary);
    const succeeded = retracted.succeeded || uploaded.succeeded;
    const transientFailure = uploaded.transientFailure ?? retracted.transientFailure;
    const signedIn = await this.clearSignInWhenReady(state, summary, succeeded);
    if (!summary.signIn) await this.checkStale();
    const backlog = this.queued(snapshot);
    summary.queued = backlog.queued;
    summary.retrying = backlog.retrying;
    await this.finish(summary, { succeeded, signedIn, transientFailure });
    return summary;
  }

  private async retractPending(
    keys: readonly string[],
    state: CaptureState,
    summary: PassSummary,
  ): Promise<PassProgress> {
    let transientFailure: string | undefined;
    let succeeded = false;
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
    return { succeeded, ...(transientFailure !== undefined ? { transientFailure } : {}) };
  }

  private async uploadPending(
    keys: readonly string[],
    state: CaptureState,
    snapshot: RulesSnapshot,
    summary: PassSummary,
  ): Promise<PassProgress> {
    let transientFailure: string | undefined;
    let succeeded = false;
    for (const key of keys) {
      if (summary.signIn) break;
      let session = state.sessions[key];
      if (!session || this.off(state, session)) continue;
      const agent = this.agents.get(session.agent);
      if (!agent || !this.due(session)) continue;
      const path = await this.transcriptOf(key, session, agent);
      if (!path) continue;
      // An agent whose upload is composed (`compose`) is judged before it is composed (a session
      // not captured gets no copy here), unless nothing changed since and all of it was sent.
      const composed = agent.compose?.current?.(session.session_id, path, this.host)
        ? agent.compose.path(session.session_id, this.host)
        : undefined;
      if (!agent.compose || composed) {
        const size = this.sizeOf(composed ?? path);
        if (size === undefined || !this.pending(session, size)) continue;
      }
      session = await this.startOf(key, session, agent, path, state);
      const place = placeOf(session.cwd);
      const decision = this.decision(snapshot, session, place, state);
      if (decision.frozen !== undefined && !session.frozen) {
        const offset = decision.frozen;
        const at = this.now().toISOString();
        session = (await this.save(key, (s) => freeze(s, at, offset))) ?? {
          ...session,
          frozen: { at, offset },
        };
        this.log(`${key}: stopped by a pause at ${offset} bytes`);
      }
      if (!decision.capture && decision.frozen === undefined) continue;
      // A paused session sends no more than it had, so its upload is not composed further.
      const from = decision.capture
        ? this.composed(key, agent, session, path)
        : (agent.compose?.path(session.session_id, this.host) ?? path);
      if (from === undefined) continue;
      const size = this.sizeOf(from);
      if (size === undefined || !this.pending(session, size)) continue;
      if (!this.stillHeld()) break;
      const outcome = await this.sync(key, agent, place, path, size, from);
      summary.uploaded += outcome.uploaded;
      if (outcome.uploaded > 0) succeeded = true;
      if (outcome.signIn) summary.signIn = outcome.signIn;
      else if (outcome.failed) {
        summary.failed++;
        if (outcome.transient) transientFailure = outcome.transient;
      }
    }
    return { succeeded, ...(transientFailure !== undefined ? { transientFailure } : {}) };
  }

  private async clearSignInWhenReady(
    state: CaptureState,
    summary: PassSummary,
    succeeded: boolean,
  ): Promise<boolean> {
    let signedIn = succeeded;
    if (!summary.signIn && !succeeded && state.problems?.sign_in) {
      try {
        await (await this.getSink()).ready();
        signedIn = true;
      } catch (err) {
        if (err instanceof SignInNeeded) summary.signIn = this.held(err);
        else this.log(`could not check the credential: ${message(err)}`);
      }
    }
    return signedIn;
  }

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
        if (followsTranscriptPath(entry, session)) session.path = entry.transcript_path;
        if (entry.cwd) seenIn(session, entry.cwd);
        if (entry.parent_session_id) session.parent_session_id = entry.parent_session_id;
        if (entry.kind === "capture" && entry.final) session.final = true;
        if (
          entry.kind === "paused" &&
          !turnedOnSince(session.toggle, session.toggled_at, entry.at)
        ) {
          freeze(session, entry.at, uploadedOffset(session));
        }
        session.last_seen = entry.at;
        state.sessions[key] = session;
        state.agents[entry.agent] ??= { installed_at: entry.at };
      }
    });
    removeSpool(this.paths, [...items.map((i) => i.name), ...unreadable]);
    return items.length;
  }

  private async sweep(snapshot: RulesSnapshot, since?: Date): Promise<number> {
    const now = this.now();
    const state = readState(this.paths);
    const additions: SessionState[] = [];
    const paths = new Map<string, string>();
    for (const agent of this.agents.values()) {
      const installed = state.agents[agent.name]?.installed_at;
      const floor = since ?? (installed ? new Date(installed) : undefined);
      if (!floor) continue;
      const swept = await sweepAgent(agent, this.host, floor.getTime(), {
        onProblem: (problem) => this.logOnce(`sweep: ${problem}`),
        known: (id) => state.sessions[sessionKey(agent.name, id)] !== undefined,
      });
      for (const found of swept) {
        const key = sessionKey(agent.name, found.info.session_id);
        const known = state.sessions[key];
        if (known) {
          // A session found newer in the agent's store than seshi's copy: the copy catches up,
          // for a session still captured.
          if (found.keep) {
            const place = placeOf(known.cwd ?? found.info.cwd);
            if (!this.decision(snapshot, known, place, state).capture || !this.kept(found)) {
              continue;
            }
          }
          if (known.path !== found.path) paths.set(key, found.path);
          continue;
        }
        const started = new Date(found.startedMs).toISOString();
        const decision = decide(
          {
            rules: snapshot.rules,
            ...(snapshot.error ? { rulesError: snapshot.error } : {}),
            place: placeOf(found.info.cwd),
            ...stateFacts(state, agent.name, undefined, now, found.info.parent_session_id),
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
        if (!decision.capture && decision.frozen === undefined) continue;
        // A session found only in the agent's store is written out for capture alone.
        if (found.keep && (!decision.capture || !this.kept(found))) continue;
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
        if (shouldRelocate(session)) {
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
    this.pruneKept(readState(this.paths), snapshot, now);
    return additions.length;
  }

  /** Remove what agents' hooks kept beside sessions a rule has turned off since, and beside sessions
   * the state file no longer holds (gone, or never captured from here: a Cursor subagent's tool
   * results) a day after it last changed. */
  private pruneKept(state: CaptureState, snapshot: RulesSnapshot, now: Date): void {
    for (const agent of this.agents.values()) {
      if (!agent.compose) continue;
      const root = keptAgentDir(this.host, agent.name);
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const id of names) {
        const dir = join(root, id);
        const session = state.sessions[sessionKey(agent.name, id)];
        if (session) {
          const place = placeOf(session.cwd);
          if (turnedOff(this.decision(snapshot, session, place, state))) {
            rmSync(dir, { recursive: true, force: true });
          }
          continue;
        }
        const changed = Math.max(...[dir, join(dir, "results")].map((p) => this.mtimeOf(p) ?? 0));
        if (now.getTime() - changed < 24 * 3600 * SECOND) continue;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  private mtimeOf(path: string): number | undefined {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Write out a session found in its agent's store; false, logged, when that fails. */
  private kept(found: FoundTranscript): boolean {
    try {
      found.keep?.();
      return true;
    } catch (err) {
      this.log(
        `sweep: could not keep ${found.agent.name} session ${found.info.session_id}: ${message(err)}`,
      );
      return false;
    }
  }

  /** Log `line` once in this uploader's life: a sweep repeats every interval. */
  private logOnce(line: string): void {
    if (this.logged.has(line)) return;
    this.logged.add(line);
    this.log(line);
  }

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

  private off(state: CaptureState, session: SessionState): boolean {
    return session.retract === "pending" || sessionToggle(state, session.agent, session) === "off";
  }

  private rebuildDue(rebuild: NonNullable<SessionState["rebuild"]>): boolean {
    return !rebuild.not_before || Date.parse(rebuild.not_before) <= this.now().getTime();
  }

  private due(session: SessionState): boolean {
    return !session.next_attempt_at || Date.parse(session.next_attempt_at) <= this.now().getTime();
  }

  private pending(session: SessionState, size: number): boolean {
    if (size === 0) return false;
    if (session.error?.permanent && session.error.size === size) return false;
    const limit = sendLimit(session, size);
    if (session.rebuild && this.rebuildDue(session.rebuild)) return limit > 0;
    if (!session.stored) return limit > 0 && session.held_at_size !== limit;
    return limit !== (session.file_offset ?? 0);
  }

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

  /** The file to read `session` from: its transcript, or for an agent that composes its upload
   * (`compose`), that file brought up to date. Undefined, logged, when it cannot be composed; the
   * session waits for the next pass rather than go from the transcript, whose bytes may differ from
   * what was sent. */
  private composed(
    key: string,
    agent: CaptureAgent,
    session: SessionState,
    path: string,
  ): string | undefined {
    if (!agent.compose) return path;
    try {
      return agent.compose.update(session.session_id, path, this.host);
    } catch (err) {
      this.logOnce(`${key}: could not add what the hooks kept to the transcript: ${message(err)}`);
      return undefined;
    }
  }

  private sizeOf(path: string): number | undefined {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }

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
      const composed = this.agents.get(session.agent)?.compose?.path(session.session_id, this.host);
      const size = this.sizeOf(composed ?? session.path);
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

  private async save(key: string, step: SessionStep): Promise<SessionState | undefined> {
    let saved: SessionState | undefined;
    await updateState(this.paths, (state) => {
      const session = state.sessions[key];
      if (!session) return false;
      step(session);
      saved = session;
    });
    return saved;
  }

  private backoffStep(code: string, text: string): SessionStep {
    return (s) => {
      s.failures = (s.failures ?? 0) + 1;
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (s.failures - 1));
      s.next_attempt_at = new Date(this.now().getTime() + delay).toISOString();
      s.error = { code, message: text, permanent: false, at: this.now().toISOString() };
    };
  }

  private async backoff(key: string, code: string, text: string): Promise<void> {
    await this.save(key, this.backoffStep(code, text));
  }

  private refusedStep(code: string, text: string, size: number): SessionStep {
    return (s) => {
      s.error = { code, message: text, permanent: true, at: this.now().toISOString(), size };
      delete s.next_attempt_at;
      delete s.failures;
    };
  }

  private async refuse(key: string, code: string, text: string, size: number): Promise<void> {
    this.log(`${key}: ${code}: ${text}`);
    await this.save(key, this.refusedStep(code, text, size));
  }

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
      ...(repo ? { project: repo.name } : folder ? { project: basename(folder) } : {}),
      ...(repo?.branch ? { branch: repo.branch } : {}),
      ...repoVisibilityClaim(repo?.config),
      ...(session.parent_session_id ? { parent_session_id: session.parent_session_id } : {}),
      ...(Object.keys(claims).length > 0 ? { claims } : {}),
    };
  }

  private async keepSecretUnlessTurnedOff(key: string, secret: string): Promise<boolean> {
    let kept = true;
    await updateState(this.paths, (state) => {
      const s = state.sessions[key];
      if (!s || this.off(state, s)) {
        kept = false;
        return false;
      }
      s.secret = secret;
      s.sent = true;
    });
    return kept;
  }

  private async markMisalignedBeforeSend(key: string, session: SessionState): Promise<void> {
    if (session.aligned === false) return;
    await this.save(key, (s) => {
      s.aligned = false;
    });
  }

  private async sync(
    key: string,
    agent: CaptureAgent,
    place: Place,
    path: string,
    size: number,
    from: string = path,
  ): Promise<SyncOutcome> {
    let uploaded = 0;
    let retry: Retry = { replace: false, forceWhole: false, recoveries: 0 };
    let rebuilding = false;
    for (;;) {
      const current = readState(this.paths);
      const session = current.sessions[key];
      if (!session || this.off(current, session)) return { uploaded };
      if (!rebuilding && session.rebuild && this.rebuildDue(session.rebuild)) {
        if (this.rebuildsLeft > 0) {
          this.rebuildsLeft--;
          rebuilding = true;
        }
      }
      const prepared = await this.prepare(
        key,
        agent,
        { path, from },
        size,
        session,
        retry,
        rebuilding,
      );
      if ("stop" in prepared) return { uploaded, ...prepared.stop };
      const attempt = prepared.attempt;
      const answer = await this.send(key, agent, place, attempt).then(
        (sent) => ({ sent }),
        (error: unknown) => ({ error }),
      );
      let handled: Handled;
      if ("error" in answer) handled = this.onError(key, answer.error, attempt, retry, size);
      else {
        uploaded++;
        handled = this.onAccepted(attempt, answer.sent, path, retry);
      }
      for (const step of handled.saves) await this.save(key, step);
      if ("stop" in handled.next) return { uploaded, ...handled.next.stop };
      retry = handled.next.again;
    }
  }

  /** `path` is the session's transcript, which names it (`sent_path`); `from` is the file its
   * bytes are read from: the transcript, or the upload composed from it (`compose`). */
  private async prepare(
    key: string,
    agent: CaptureAgent,
    { path, from }: { path: string; from: string },
    size: number,
    session: SessionState,
    retry: Retry,
    rebuilding: boolean,
  ): Promise<{ attempt: Attempt } | { stop: Omit<SyncOutcome, "uploaded"> }> {
    const fileOffset = session.file_offset ?? 0;
    const limit = sendLimit(session, size);
    const replaceAgain = session.stored === true && session.replace_next === true;
    const rebuild = rebuilding ? session.rebuild : undefined;
    const whole =
      retry.forceWhole ||
      replaceAgain ||
      rebuild !== undefined ||
      mustSendWhole(session, path, limit, agent);
    const replacing = retry.replace || replaceAgain;
    if (!whole && fileOffset >= limit) return { stop: {} };
    const notTranscript = whyNotSessionTranscript(agent, path, session);
    if (notTranscript !== undefined) {
      await this.refuse(key, "not_a_transcript", notTranscript, size);
      return { stop: { failed: true } };
    }
    const piece = this.piece(from, whole ? 0 : fileOffset, limit, agent.encoding, whole);
    if (!piece) return { stop: {} };
    let secret = session.secret;
    if (!secret || !session.sent) {
      secret ??= newSecret();
      if (!(await this.keepSecretUnlessTurnedOff(key, secret))) return { stop: {} };
    }
    return { attempt: { session, limit, whole, replacing, rebuild, piece, secret } };
  }

  private async send(
    key: string,
    agent: CaptureAgent,
    place: Place,
    attempt: Attempt,
  ): Promise<Sent> {
    const { session, whole, replacing, rebuild, piece, secret } = attempt;
    const redacted = await this.preRedact.redact({
      agent: agent.format,
      encoding: agent.encoding,
      text: piece.text,
      ...(!whole && session.carried ? { carried: session.carried } : {}),
    });
    const keptLength = bytesOf(redacted.text) === bytesOf(piece.text);
    if (!keptLength) await this.markMisalignedBeforeSend(key, session);
    const upload: Upload = {
      agent: agent.format,
      session_id: uploadId(session),
      transcript: redacted.text,
      format: agent.encoding,
      offset: whole ? 0 : (session.server_offset ?? 0),
      retract_hash: retractHash(secret),
      // A continuation names what it continues: resumed from (`parent_session_id`, which a
      // reader sees on the session) and forked from (`fork_of`, whose history it may share).
      ...(session.fork_of ? { parent_session_id: session.fork_of, fork_of: session.fork_of } : {}),
      ...(await this.details(session, agent, place)),
      ...(rebuild
        ? { rebuild: true, idempotency_key: rebuildIdempotencyKey(rebuild, piece.end) }
        : replacing
          ? { replace: true }
          : {}),
    };
    const result = await (await this.getSink()).ingest(
      upload,
      replacing || rebuild ? { retractSecret: secret } : {},
    );
    return { result, redacted, keptLength };
  }

  private onAccepted(attempt: Attempt, sent: Sent, path: string, retry: Retry): Handled {
    const { whole, replacing, rebuild, piece, limit } = attempt;
    const { result, redacted, keptLength } = sent;
    const stored = result.bytes_total > 0;
    const now = this.now().toISOString();
    return {
      saves: [
        (s) => {
          s.stored = stored;
          s.last_status = result.status;
          s.uploaded_at = now;
          delete s.error;
          delete s.failures;
          delete s.next_attempt_at;
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
            if ((replacing || rebuild) && result.status === "dropped") s.replace_next = true;
            else delete s.replace_next;
          } else {
            s.file_offset = 0;
            s.server_offset = 0;
            s.held_at_size = limit;
            delete s.sent_path;
            delete s.shipped;
            delete s.carried;
            delete s.replace_next;
          }
          if (rebuild) markRebuildAnswered(s, rebuild);
        },
      ],
      next:
        !stored || piece.end >= limit
          ? { stop: {} }
          : { again: { ...retry, replace: false, forceWhole: false } },
    };
  }

  private held(err: SignInNeeded): string {
    this.holdWord = err.word;
    return err.message;
  }

  private onError(
    key: string,
    err: unknown,
    attempt: Attempt,
    retry: Retry,
    size: number,
  ): Handled {
    if (err instanceof SignInNeeded) {
      return { saves: [], next: { stop: { signIn: this.held(err) } } };
    }
    if (err instanceof OffsetMismatch && retry.recoveries < 3) {
      return onOffsetMismatch(err.expected, attempt, retry, size);
    }
    if (
      err instanceof SessionConflict &&
      this.continueOnConflict &&
      attempt.whole &&
      !attempt.replacing &&
      retry.recoveries < 5
    ) {
      this.log(
        `${key}: the stored session is not this log's start; continuing it as a new session`,
      );
      return onConflictContinue(retry);
    }
    if (
      err instanceof SessionConflict &&
      attempt.whole &&
      !attempt.replacing &&
      mayReplaceOwnSession(attempt.session)
    ) {
      return onConflictReplaceOwn(retry);
    }
    if (transient(err)) return this.onTransient(key, err);
    return this.onRefused(key, err, attempt.rebuild, size);
  }

  private onTransient(key: string, err: unknown): Handled {
    this.log(`${key}: will retry: ${message(err)}`);
    return {
      saves: [this.backoffStep("unavailable", message(err))],
      next: { stop: { failed: true, transient: message(err) } },
    };
  }

  private onRefused(
    key: string,
    err: unknown,
    rebuild: Rebuild | undefined,
    size: number,
  ): Handled {
    const code = refusalCode(err);
    this.log(`${key}: ${code}: ${message(err)}`);
    const refused = this.refusedStep(code, message(err), size);
    return {
      saves: rebuild ? [refused, (s) => markRebuildAnswered(s, rebuild)] : [refused],
      next: { stop: { failed: true } },
    };
  }

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
        "retract_also",
      ] as const) {
        delete s[field];
      }
      s.last_status = "retracted";
    };
    if (!session.secret || !session.sent || !agent) {
      await this.save(key, reset);
      return { ok: true };
    }
    try {
      const sink = await this.getSink();
      // Earlier ids first: once the current one is retracted, a retry finds nothing to redo.
      for (const earlier of session.retract_also ?? []) {
        const gone = await sink.retract(agent.format, earlier, session.secret);
        this.log(
          `${key}: ${earlier}: ${gone === "retracted" ? "retracted" : "nothing to retract"}`,
        );
        await this.save(key, (s) => {
          s.retract_also = s.retract_also?.filter((id) => id !== earlier);
          if (s.retract_also?.length === 0) delete s.retract_also;
        });
      }
      const outcome = await sink.retract(agent.format, uploadId(session), session.secret);
      if (outcome === "absent" && session.stored) {
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
      if (err instanceof SignInNeeded) return { signIn: this.held(err) };
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
        const word = this.holdWord !== "sign in" ? { word: this.holdWord } : {};
        problems.sign_in =
          state.problems?.sign_in?.message === summary.signIn
            ? { ...state.problems.sign_in, ...word }
            : { message: summary.signIn, at: now, ...word };
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
