/** What the status indicator says (F9.4, B1.6), from local state only, with no network call:
 * whether this session is being captured, and anything that needs the person's action. The
 * words are rendered by `seshi statusline` as `Session Capture ◉` or `Session Capture ⏸`, with
 * problems after a separator (`Session Capture ◉ · 3 queued`). */

import type { Decision } from "./rules";
import type { CaptureState, SessionState } from "./state";

/** A problem, short enough for a status bar, with how serious it is. */
export interface StatusProblem {
  text: string;
  kind: "warn" | "error" | "progress";
}

export interface StatusLine {
  capturing: boolean;
  problems: StatusProblem[];
}

export interface StatusLineInput {
  /** The state file; undefined when it cannot be read. */
  state: CaptureState | undefined;
  /** The decision for the session the status line is about (or for the current folder). */
  decision: Decision;
  /** Spool entries not yet taken in by the uploader. */
  spooled: number;
  /** The session's own key, when known: a retraction it is waiting for or that was refused. */
  session?: string;
}

/** The most problems a status line shows: it stays one short line (B1.4). */
export const MAX_PROBLEMS = 2;

export function statusLine(input: StatusLineInput): StatusLine {
  const { state, decision } = input;
  const problems: StatusProblem[] = [];
  if (!state) {
    return { capturing: false, problems: [{ text: "state unreadable", kind: "error" }] };
  }
  if (decision.level === "config") problems.push({ text: "config error", kind: "error" });
  if (state.problems?.sign_in) problems.push({ text: "sign in", kind: "warn" });
  if (state.problems?.upload) problems.push({ text: "upload failing", kind: "error" });
  const session = input.session ? state.sessions[input.session] : undefined;
  if (session?.retract === "failed") problems.push({ text: "retraction refused", kind: "error" });
  const queued = (state.uploader?.queued ?? 0) + input.spooled;
  if (queued > 0) problems.push({ text: `${queued} queued`, kind: "progress" });
  return { capturing: decision.capture, problems: problems.slice(0, MAX_PROBLEMS) };
}

/** What a session's state says, in a few words, for `seshi capture status` and `seshi upload`. */
export function sessionWord(s: SessionState): string {
  if (s.toggle === "off") {
    if (s.retract === "pending") return "retracting";
    if (s.retract === "failed") return "retraction refused";
    return s.retract === "done" ? "off (retracted)" : "off";
  }
  if (s.error?.permanent) return `refused (${s.error.code})`;
  if (s.error) return "retrying";
  if (s.stored) return "uploaded";
  if (s.last_status === "filtered") return "too small yet";
  if (s.last_status === "dropped") return "dropped by review";
  return "waiting";
}
