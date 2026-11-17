import type { StatusJson } from "./seshi";

export const LABEL = "Session Capture";
export const CAPTURING = "◉";
export const NOT_CAPTURING = "⏸";

/** What a click does. */
export type Action =
  | { kind: "toggle"; to: "off" | "on"; session: string; pick: boolean }
  | { kind: "explain"; message: string }
  | { kind: "status"; session?: string }
  | { kind: "install" }
  | { kind: "setup"; message: string };

export interface View {
  text: string;
  tooltip: string;
  background?: "warning" | "error";
  action: Action;
}

/** Levels a person cannot override from here: a team's rule, or a config seshi cannot read. */
const FIXED = new Set(["org", "repo", "config", "unknown"]);

function how(by: string, at: string | undefined, title: string | undefined, now: Date): string {
  const ago = at ? ` ${relative(at, now)}` : "";
  switch (by) {
    case "focused":
      return `the chat you have open${title ? `, “${title}”` : ""}`;
    case "selected":
      return "the open chat";
    case "prompt":
      return `the chat you last sent a message in${ago}`;
    default:
      return `the chat seen most recently here${ago}`;
  }
}

function relative(at: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The status bar item for seshi's answer. `title` is the focused chat's title, when known. */
export function viewOf(status: StatusJson, now: Date, title?: string): View {
  if (status.session === undefined) {
    return {
      text: `$(warning) ${LABEL} · update seshi`,
      tooltip: "This seshi is too old to say which chat you are in: install the latest seshi.",
      background: "warning",
      action: { kind: "setup", message: "Install the latest seshi to show Session Capture here." },
    };
  }
  if (status.installed === false) {
    return {
      text: `${LABEL} ${NOT_CAPTURING} · not installed`,
      tooltip: "seshi does not capture Cursor yet. Click to run `seshi capture install cursor`.",
      background: "warning",
      action: { kind: "install" },
    };
  }
  const glyph = status.capturing ? CAPTURING : NOT_CAPTURING;
  const text = [`${LABEL} ${glyph}`, ...status.problems.slice(0, 2)].join(" · ");
  const background =
    status.attention === "error" ? "error" : status.attention === "warn" ? "warning" : undefined;
  const session = status.session;
  if (!session) {
    return {
      text,
      tooltip: `**${LABEL}** ${status.capturing ? "is on" : "is off"} here: ${status.reason}.\n\nNo Cursor chat seen in this folder yet.`,
      ...(background ? { background } : {}),
      action: { kind: "status" },
    };
  }
  const which = `\`${session.session_id.slice(0, 8)}\`, ${how(session.by, session.at, title, now)}`;
  const fixed = !status.capturing && FIXED.has(status.level);
  const to = status.capturing ? "off" : "on";
  const ambiguous =
    session.by !== "focused" &&
    (status.candidates ?? []).some((c) => c.session_id !== session.session_id);
  const tooltip = [
    `**${LABEL}** ${status.capturing ? "on" : "off"} for chat ${which}.`,
    `${status.reason}.`,
    fixed
      ? "A shared rule decides this; it cannot be turned on from here."
      : `Click to turn capture ${to} for this chat${ambiguous ? " (you choose the chat first)" : ""}.`,
  ].join("\n\n");
  return {
    text,
    tooltip,
    ...(background ? { background } : {}),
    action: fixed
      ? { kind: "explain", message: `${LABEL} is off for this chat: ${status.reason}.` }
      : { kind: "toggle", to, session: session.session_id, pick: ambiguous },
  };
}

/** What to say after a toggle, from `seshi capture off|on --json`. */
export function toggled(to: "off" | "on", answer: Record<string, unknown>): string {
  if (to === "off") {
    return answer.retracting
      ? `${LABEL} is off for this chat; what it uploaded is being retracted.`
      : `${LABEL} is off for this chat; nothing of it was uploaded.`;
  }
  const more = [
    ...(answer.fresh ? ["it is uploaded again from its start"] : []),
    ...(answer.unfrozen ? ["a pause had stopped it, so all of it is uploaded now"] : []),
  ];
  return `${LABEL} is on for this chat${more.length > 0 ? `; ${more.join("; ")}` : ""}.`;
}
