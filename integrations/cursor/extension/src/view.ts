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

/** How the chat was chosen, when it was not the one in view: a short hint after its id. */
function hint(by: string, at: string | undefined, now: Date): string {
  const ago = at ? ` ${relative(at, now)}` : "";
  if (by === "prompt") return ` (last messaged${ago})`;
  if (by === "recent") return ` (last seen${ago})`;
  return "";
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
  const state = status.capturing ? "on" : "off";
  if (!session) {
    return {
      text,
      tooltip: `\`${LABEL}\` ${state} in this folder: no Cursor chat yet.\n\nClick for the status.`,
      ...(background ? { background } : {}),
      action: { kind: "status" },
    };
  }
  const fixed = !status.capturing && FIXED.has(status.level);
  const to = status.capturing ? "off" : "on";
  const ambiguous =
    session.by !== "focused" &&
    (status.candidates ?? []).some((c) => c.session_id !== session.session_id);
  const name = title ? ` "${title}"` : "";
  const tooltip = [
    `\`${LABEL}\` ${state} for the chat \`${session.session_id.slice(0, 8)}\`${name}${hint(session.by, session.at, now)}`,
    ...(fixed ? [`Off because ${status.reason}: a team rule, not a toggle.`] : []),
    fixed ? "" : ambiguous ? "Click to choose the chat and toggle" : "Click to toggle",
  ]
    .filter(Boolean)
    .join("\n\n");
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
