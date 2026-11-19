import type { Decision } from "./rules";
import type { CaptureState, SessionState } from "./state";

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
  decision: Decision;
  spooled: number;
  session?: string;
}

export const MAX_PROBLEMS = 2;

export function statusLine(input: StatusLineInput): StatusLine {
  const { state, decision } = input;
  const problems: StatusProblem[] = [];
  if (!state) {
    return { capturing: false, problems: [{ text: "state unreadable", kind: "error" }] };
  }
  if (decision.level === "config") problems.push({ text: "config error", kind: "error" });
  const held = state.problems?.sign_in;
  if (held) problems.push({ text: held.word ?? "sign in", kind: "warn" });
  if (state.problems?.upload) problems.push({ text: "upload failing", kind: "error" });
  const session = input.session ? state.sessions[input.session] : undefined;
  if (session?.retract === "failed") problems.push({ text: "retraction refused", kind: "error" });
  const queued = (state.uploader?.queued ?? 0) + input.spooled;
  if (queued > 0) problems.push({ text: `${queued} queued`, kind: "progress" });
  return { capturing: decision.capture, problems: problems.slice(0, MAX_PROBLEMS) };
}

export function sessionWord(s: SessionState): string {
  if (s.retract === "pending") return "retracting";
  if (s.retract === "failed") return "retraction refused";
  if (s.toggle === "off") return s.retract === "done" ? "off (retracted)" : "off";
  if (s.frozen) return "stopped by a pause";
  if (s.error?.permanent) return `refused (${s.error.code})`;
  if (s.error) return "retrying";
  if (s.rebuild) return "resending";
  if (s.stored) return "uploaded";
  if (s.last_status === "filtered") return "too small yet";
  if (s.last_status === "dropped") return "dropped by review";
  return "waiting";
}
