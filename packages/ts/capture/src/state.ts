import { randomBytes } from "node:crypto";
import type { ShippedPrefix } from "@seshi/model";
import { readText, withLock, writePrivateFile } from "./files";
import type { CapturePaths } from "./paths";
import type { DecideInput, PauseWindow } from "./rules";

export const STATE_SCHEMA = "seshi/capture-state/1";

export type Toggle = "on" | "off";

export interface Problem {
  message: string;
  at: string;
}

export interface SessionState {
  agent: string;
  session_id: string;
  path?: string;
  cwd?: string;
  folders?: string[];
  parent_session_id?: string;
  first_seen: string;
  last_seen?: string;
  /** The agent said the session ended. */
  final?: boolean;
  /** When the session started, as its transcript says (or its file's birth time). */
  started_at?: string;

  /** A pause stopped the session here: it keeps what it uploaded and nothing past `offset` (a
   * transcript offset) is ever sent, even after the pause ends. Only `seshi capture on
   * --session` takes it away. */
  frozen?: { at: string; offset: number };

  toggle?: Toggle;
  toggled_at?: string;
  retract?: "pending" | "done" | "failed";
  retract_error?: string;

  /** How many times the session was retracted: each later upload is a new session on the
   * server (`<id>~<n>`), since a retracted one is never stored again (F9.7). */
  generation?: number;
  /** The retraction secret: made before the first upload; only its hash is ever sent. */
  secret?: string;
  /** An upload carrying the secret's hash was sent (whatever came back): a retraction must ask
   * the server. */
  sent?: boolean;
  /** The server holds a trace of it: later uploads are chunks (X6.3). */
  stored?: boolean;
  /** Bytes of the transcript sent so far, and where the server's log ends (these differ only
   * when pre-redaction changed a length, F2.4). */
  file_offset?: number;
  server_offset?: number;
  /** The transcript those offsets are positions in. A session whose path changes since (a
   * later hook naming another file) is sent whole again, never chunked from another file. */
  sent_path?: string;
  /** Whether every byte sent kept its length, so a server offset is also a file offset. */
  aligned?: boolean;
  shipped?: ShippedPrefix;
  /** What pre-redaction carries from one chunk to the next (withheld call ids). */
  carried?: Record<string, unknown>;
  /** The transcript size when the server last kept nothing (filtered, or dropped before it had
   * a trace): the whole log is sent again only once it grows (X4.10). */
  held_at_size?: number;
  /** Model review dropped a replace: the server kept the session it had, which this log no
   * longer extends, so the next upload goes whole and replaces again (never a chunk at the
   * server's offset, which would splice this log onto that session). */
  replace_next?: boolean;
  /** Send the whole log again with `rebuild` (X4.9): the server listed the session as stale
   * (`for`: the format version it is stale against), or `seshi capture resend` asked. Cleared
   * once an upload of it is answered; `key` is its idempotency key, kept across retries.
   * `not_before`: a stale rebuild waits until then, a random time the uploader picks within
   * `resendSpreadMs`, so a normalizer bump that makes every session stale at once does not
   * resend them all in the same hour (`seshi capture resend` sets none: it goes now). */
  rebuild?: { at: string; key: string; for?: string; not_before?: string };
  /** The format version the last stale rebuild was for: a stale listing that names it again (a
   * rebuild model review dropped, say) does not send the session again. */
  rebuilt_for?: string;
  uploaded_at?: string;
  /** The last answer's status (`stored`, `filtered`, `unchanged`, …). */
  last_status?: string;
  /** The last refusal. A permanent one waits until the transcript changes. */
  error?: { code: string; message: string; permanent: boolean; at: string; size?: number };
  next_attempt_at?: string;
  failures?: number;
}

export interface CaptureState {
  schema: typeof STATE_SCHEMA;
  /** Agents capture is installed for, and since when: the sweep never reaches back past it
   * (F9.3, no surprise backfill). */
  agents: Record<string, { installed_at: string }>;
  /** `seshi capture pause [duration]`: in force until `until`, or until resumed. Sessions seen
   * while it lasts are stopped where they are (`SessionState.frozen`), for good. */
  paused?: { at: string; until?: string };
  /** Pauses that ended, most recent last (at most `MAX_PAUSES`): a session that started in one
   * stays off when it is first seen after it. */
  pauses?: { at: string; until: string }[];
  sessions: Record<string, SessionState>;
  uploader?: {
    last_run?: string;
    last_sweep?: string;
    /** Sessions with something not yet uploaded, as of the last run. */
    queued?: number;
    /** Where uploads go: a server URL, or the local bucket. */
    target?: string;
    /** Passes in a row in which an upload failed for a reason worth retrying. */
    failures?: number;
    /** When the server was last asked which sessions are stale (X4.9). */
    last_stale_check?: string;
  };
  problems?: { sign_in?: Problem; upload?: Problem };
}

/** The state file cannot be read; nothing is captured until it is moved aside. */
export class StateUnreadable extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path} cannot be read (${reason}); move it aside to start capture state over`);
    this.name = "StateUnreadable";
  }
}

export function emptyState(): CaptureState {
  return { schema: STATE_SCHEMA, agents: {}, sessions: {} };
}

export function sessionKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

/** The session id an upload uses: the agent's own, or `<id>~<n>` after `n` retractions. */
export function uploadId(session: Pick<SessionState, "session_id" | "generation">): string {
  return session.generation ? `${session.session_id}~${session.generation}` : session.session_id;
}

/** A new retraction secret (F9.7): 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The state as it is on disk; empty when there is none. Throws `StateUnreadable`. */
export function readState(paths: CapturePaths): CaptureState {
  const text = readText(paths.state);
  if (text === undefined) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new StateUnreadable(paths.state, (err as Error).message);
  }
  const state = parsed as Partial<CaptureState>;
  if (state?.schema !== STATE_SCHEMA || typeof state.sessions !== "object") {
    throw new StateUnreadable(paths.state, `not a ${STATE_SCHEMA} file`);
  }
  return { ...state, agents: state.agents ?? {}, sessions: state.sessions } as CaptureState;
}

/** Change the state under its lock: `step` gets the current state and changes it in place, or
 * returns false to write nothing. Returns the state as written. */
export async function updateState(
  paths: CapturePaths,
  step: (state: CaptureState) => unknown,
): Promise<CaptureState> {
  return withLock(paths.state, () => {
    const state = readState(paths);
    if (step(state) === false) return state;
    writePrivateFile(paths.state, `${JSON.stringify(state, null, 1)}\n`);
    return state;
  });
}

export function isPaused(state: CaptureState, now: Date): boolean {
  const paused = state.paused;
  if (!paused) return false;
  return paused.until === undefined || Date.parse(paused.until) > now.getTime();
}

export const MAX_PAUSES = 20;

/** Every pause recorded, the one in the state now (in force or run out) last. */
export function pauseWindows(state: CaptureState): PauseWindow[] {
  return [...(state.pauses ?? []), ...(state.paused ? [state.paused] : [])];
}

/** End the pause in the state, if any, keeping it as an ended pause: it ended at `now`, or at
 * its own `until` when that came first. */
export function endPause(state: CaptureState, now: Date): void {
  const paused = state.paused;
  if (!paused) return;
  const until =
    paused.until !== undefined && Date.parse(paused.until) < now.getTime()
      ? paused.until
      : now.toISOString();
  state.pauses = [...(state.pauses ?? []), { at: paused.at, until }].slice(-MAX_PAUSES);
  delete state.paused;
}

/** The transcript offset the server holds from this machine: where a pause stops the session. */
export function uploadedOffset(session: SessionState | undefined): number {
  return session?.stored ? (session.file_offset ?? 0) : 0;
}

/** Stop a session where it is (a pause, F9.5); one already stopped keeps its offset. */
export function freeze(session: SessionState, at: string, offset: number): void {
  session.frozen ??= { at, offset };
}

/** The transcript size a session may be sent up to: all of it, or as far as a pause stopped it. */
export function sendLimit(session: Pick<SessionState, "frozen">, size: number): number {
  return session.frozen ? Math.min(size, session.frozen.offset) : size;
}

/** What the decision function needs to know about a session from the state file: its toggle
 * (its own or a parent's) and when it was set, the pause in force, every pause recorded, and
 * where a pause stopped it or would stop it. Every caller of `decide` builds its input from
 * here, so hooks, the sweep, the uploader and the status line judge a session alike (F9.3). */
export function stateFacts(
  state: CaptureState,
  agent: string,
  session: SessionState | undefined,
  now: Date,
  parentId?: string,
): Pick<
  DecideInput,
  "toggle" | "toggledAt" | "paused" | "pausedAt" | "frozen" | "uploaded" | "started" | "pauses"
> {
  const holder = toggleHolder(state, agent, session, parentId);
  const paused = isPaused(state, now);
  const pauses = pauseWindows(state);
  const frozen = session?.frozen ?? inheritedFreeze(state, agent, session, parentId);
  return {
    ...(holder?.toggle ? { toggle: holder.toggle } : {}),
    ...(holder?.toggled_at ? { toggledAt: holder.toggled_at } : {}),
    paused,
    ...(paused && state.paused ? { pausedAt: state.paused.at } : {}),
    ...(frozen ? { frozen: frozen.offset } : {}),
    uploaded: uploadedOffset(session),
    ...(session?.started_at ? { started: session.started_at } : {}),
    ...(pauses.length > 0 ? { pauses } : {}),
  };
}

/** The folders a session is judged by besides `cwd` (the one being judged, F9.5): every folder
 * it was seen in, and every folder of each session above it in the state file (its parent, the
 * parent's parent, …). A subagent's transcript carries what its parent gave it, so a parent that
 * worked in an excluded repo keeps its subagents off too, wherever they run. `parentId` names
 * the parent of a session not in the state yet (a hook's capture, a sweep's find). Every caller
 * of `decide` builds `seen` from here, so hooks, the sweep, the uploader and the status line
 * agree (F9.3). */
export function otherFolders(
  state: CaptureState | undefined,
  agent: string,
  session: Pick<SessionState, "cwd" | "folders" | "parent_session_id"> | undefined,
  cwd: string | undefined,
  parentId?: string,
): string[] {
  const foldersOf = (s: Pick<SessionState, "cwd" | "folders"> | undefined) => [
    ...(s?.folders ?? []),
    ...(s?.cwd ? [s.cwd] : []),
  ];
  const all = new Set(foldersOf(session));
  const visited = new Set<string>();
  let parent = session?.parent_session_id ?? parentId;
  while (state && parent !== undefined && !visited.has(parent)) {
    visited.add(parent);
    const above = state.sessions[sessionKey(agent, parent)];
    for (const folder of foldersOf(above)) all.add(folder);
    parent = above?.parent_session_id;
  }
  if (cwd !== undefined) all.delete(cwd);
  return [...all];
}

/** Add `cwd` to the folders `session` was seen in, and make it the current one. */
export function seenIn(session: SessionState, cwd: string): void {
  const folders = session.folders ?? (session.cwd ? [session.cwd] : []);
  if (!folders.includes(cwd)) folders.push(cwd);
  session.folders = folders;
  session.cwd = cwd;
}

/** The toggle that applies to a session: its own, else its parent's, and so on up (F9.5). A
 * subagent's transcript is part of the session that started it (the parent's task prompt, its
 * tool output), so turning the parent off covers it; its own toggle, when it has one, wins.
 * `parentId` names the parent of a session not in the state yet (a hook's capture). */
export function sessionToggle(
  state: CaptureState,
  agent: string,
  session: Pick<SessionState, "toggle" | "parent_session_id"> | undefined,
  parentId?: string,
): Toggle | undefined {
  return toggleHolder(state, agent, session, parentId)?.toggle;
}

function inheritedFreeze(
  state: CaptureState,
  agent: string,
  session: SessionState | undefined,
  parentId?: string,
): { offset: number } | undefined {
  if (session?.toggle || !frozenParent(state, agent, session, parentId)) return undefined;
  return { offset: uploadedOffset(session) };
}

function frozenParent(
  state: CaptureState,
  agent: string,
  session: Pick<SessionState, "parent_session_id"> | undefined,
  parentId?: string,
): boolean {
  const seen = new Set<string>();
  let parent = session?.parent_session_id ?? parentId;
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    const above = state.sessions[sessionKey(agent, parent)];
    if (above?.frozen) return true;
    if (above?.toggle) return false;
    parent = above?.parent_session_id;
  }
  return false;
}

function toggleHolder(
  state: CaptureState,
  agent: string,
  session: Pick<SessionState, "toggle" | "toggled_at" | "parent_session_id"> | undefined,
  parentId?: string,
): Pick<SessionState, "toggle" | "toggled_at"> | undefined {
  if (session?.toggle) return session;
  const seen = new Set<string>();
  let parent = session?.parent_session_id ?? parentId;
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    const above = state.sessions[sessionKey(agent, parent)];
    if (above?.toggle) return above;
    parent = above?.parent_session_id;
  }
  return undefined;
}

/** The keys of the sessions `id` started (its subagents), and theirs in turn, that have no
 * toggle of their own: the ones a toggle of `id` covers. */
export function subsessionKeys(state: CaptureState, agent: string, id: string): string[] {
  const keys: string[] = [];
  const parents = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [key, session] of Object.entries(state.sessions)) {
      if (session.agent !== agent || session.toggle || parents.has(session.session_id)) continue;
      if (session.parent_session_id !== undefined && parents.has(session.parent_session_id)) {
        parents.add(session.session_id);
        keys.push(key);
        grew = true;
      }
    }
  }
  return keys;
}
