/** The one capture state file per machine (F9.5): read by hooks, the sweep, the status line and
 * the uploader, written by the uploader and the `seshi capture` commands. It holds which agents
 * capture is installed for (the sweep's floor, F9.3), a pause, every session seen with its
 * toggle, its upload position and its retraction secret (F9.7), and the problems the status
 * line reports (B1.6).
 *
 * Writers take the lock and write the whole file through a rename, so a reader (the status
 * line, a hook) never sees half of one. The file is readable only by this user: it holds the
 * retraction secrets, which never leave the machine. */

import { randomBytes } from "node:crypto";
import type { ShippedPrefix } from "@seshi/model";
import { readText, withLock, writePrivateFile } from "./files";
import type { CapturePaths } from "./paths";

export const STATE_SCHEMA = "seshi/capture-state/1";

/** A session's own toggle (F9.5, the session level). */
export type Toggle = "on" | "off";

export interface Problem {
  message: string;
  at: string;
}

/** One session this machine has seen, by hook or sweep. */
export interface SessionState {
  agent: string;
  /** The agent's own id for it. */
  session_id: string;
  /** Its transcript, once known. */
  path?: string;
  /** Where the agent ran: what the capture rules are judged against. */
  cwd?: string;
  parent_session_id?: string;
  first_seen: string;
  last_seen?: string;
  /** The agent said the session ended. */
  final?: boolean;

  // Set by `seshi capture off|on --session` -------------------------------------------------
  toggle?: Toggle;
  toggled_at?: string;
  /** A retraction asked for by turning the session off (F9.7): waiting, done, or refused. */
  retract?: "pending" | "done" | "failed";
  retract_error?: string;

  // Set by the uploader --------------------------------------------------------------------
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
  /** `seshi capture pause [duration]`: everything stops until `until`, or until resumed. */
  paused?: { at: string; until?: string };
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
  };
  /** What needs the person's action (B1.6): a sign-in, uploads that keep failing. */
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

/** The key of a session in the state file. */
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

/** Whether everything is paused at `now`. */
export function isPaused(state: CaptureState, now: Date): boolean {
  const paused = state.paused;
  if (!paused) return false;
  return paused.until === undefined || Date.parse(paused.until) > now.getTime();
}
