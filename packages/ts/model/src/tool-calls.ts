/** `redact_tool_calls`'s pieces shared by a laptop's per-agent passes (`@seshi/kit`) and the
 * server's pass over records (`@seshi/redact`), so both write the same marker the same way and the
 * server leaves alone what a laptop already redacted. Imported by hooks: no dependencies. */

export const TOOL_CALL_MARKER = "[redacted:tool-call]";

type Json = Record<string, unknown>;

const NOTHING: ReadonlySet<string> = new Set();

const isJsonObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` with every non-empty string in it replaced by `TOOL_CALL_MARKER`; object keys, numbers,
 * booleans and null stay, and so does the value of any key in `keep`, at any depth. */
export function blankStrings(value: unknown, keep: ReadonlySet<string> = NOTHING): unknown {
  if (typeof value === "string") return value === "" ? value : TOOL_CALL_MARKER;
  if (Array.isArray(value)) return value.map((v) => blankStrings(v, keep));
  if (isJsonObject(value)) {
    const next: Json = {};
    for (const [k, v] of Object.entries(value)) next[k] = keep.has(k) ? v : blankStrings(v, keep);
    return next;
  }
  return value;
}

/** Whether `value` holds a string `blankStrings` would replace (a non-empty one that is not the
 * marker already). */
export function hasToolDetail(value: unknown): boolean {
  if (typeof value === "string") return value !== "" && value !== TOOL_CALL_MARKER;
  if (Array.isArray(value)) return value.some(hasToolDetail);
  if (isJsonObject(value)) return Object.values(value).some(hasToolDetail);
  return false;
}

/** `text` with the body of each `<tag>…</tag>` named in `tags` replaced by the marker; a tag
 * left open (output cut short) loses everything after it. An empty body stays. */
export function redactTagBodies(text: string, tags: readonly string[]): string {
  const names = tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`<(${names})>([\\s\\S]*?)(</\\1>|$)`, "g");
  return text.replace(pattern, (whole, tag: string, body: string, close: string) =>
    body === "" ? whole : `<${tag}>${TOOL_CALL_MARKER}${close}`,
  );
}

/** What a command the person ran printed (Claude Code's `!`, `/` commands). */
const OUTPUT_TAGS = ["bash-stdout", "bash-stderr", "local-command-stdout", "local-command-stderr"];
/** A background task's result, as Claude Code tells the session. */
const NOTIFICATION = /^\s*<task-notification/;
/** A command the person ran in Codex, logged as a user message holding its output. */
const SHELL_COMMAND = /<user_shell_command>[\s\S]*?(?:<\/user_shell_command>|$)/g;

/** Text put in the conversation for the person (a prompt, a queued input), with what tools and
 * the person's own commands returned in it replaced: a background task's result whole, a command's
 * output (the command itself is kept). */
export function redactCommandOutput(text: string): string {
  if (NOTIFICATION.test(text)) return `<task-notification>${TOOL_CALL_MARKER}</task-notification>`;
  return redactTagBodies(text, OUTPUT_TAGS).replace(SHELL_COMMAND, (block) =>
    redactTagBodies(block, ["result"]),
  );
}
