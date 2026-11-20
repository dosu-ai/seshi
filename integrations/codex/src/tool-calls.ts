/** Codex's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls). A rollout line is
 * `{timestamp, type, payload}`.
 *
 * - `response_item`: a `function_call` keeps its name and `call_id` (its JSON-encoded
 *   `arguments` keep their keys and numbers, every string replaced); a `custom_tool_call` (an
 *   `apply_patch`) loses its `input`; their `*_output` items keep the `call_id` and lose their
 *   output whole (but for Codex's own `{output, metadata}` wrapper, whose exit code stays), as
 *   do `local_shell_call` and `web_search_call`'s actions. Messages and reasoning are kept, but
 *   for what a command the person ran printed (`<user_shell_command>`'s `<result>`).
 * - `event_msg`: what the person and the agent said (`user_message`, `agent_message`,
 *   `agent_reasoning`) and the turn's bookkeeping (`token_count`, `task_*`) are kept; every other
 *   event (`exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`, `item_completed`, …) keeps
 *   only its type and ids.
 * - `compacted`: the summary, which quotes what tools read and printed, is blanked; its
 *   `replacement_history` is redacted as `response_item`s.
 * - `session_meta` and `turn_context` are kept; any other line keeps only its type and time.
 *
 * Loaded with the capture agent, so it imports only `@seshi/kit`. */

import {
  blankEncoded,
  blankResult,
  blankStrings,
  blankUnknown,
  byType,
  isJsonObject,
  type RecordShape,
  redactCommandOutput,
  redactRecords,
  reshape,
} from "@seshi/kit";

const keysWithin = (value: unknown, allowed: readonly string[]) =>
  isJsonObject(value) && Object.keys(value).every((k) => allowed.includes(k));

/** A tool's output, replaced whole: its keys and numbers are the tool's too (a JSON file read).
 * Only Codex's own shapes keep their structure: the `{output, metadata}` wrapper a shell call's
 * output is encoded in (its exit code and duration stay), and an MCP call's `{content, success}`. */
function output(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (keysWithin(parsed, ["output", "metadata"])) {
        return JSON.stringify(
          reshape(parsed, { walk: { output: blankUnknown, metadata: blankStrings } }),
        );
      }
    } catch {}
    return blankUnknown(value);
  }
  if (keysWithin(value, ["content", "success"])) {
    return reshape(value, { keep: ["success"], walk: { content: blankResult } });
  }
  return blankUnknown(value);
}

/** What was said, with what a command the person ran (`!cmd`, logged as a user message holding
 * its output) printed replaced (as the server's pass does too). */
function said(text: unknown): unknown {
  return typeof text === "string" ? redactCommandOutput(text) : blankUnknown(text);
}

/** A message's content: its text items with what a command the person ran printed replaced. */
function messageContent(content: unknown): unknown {
  if (typeof content === "string") return said(content);
  if (!Array.isArray(content)) return blankUnknown(content);
  return content.map((item) =>
    isJsonObject(item) && typeof item.text === "string" ? { ...item, text: said(item.text) } : item,
  );
}

const ITEMS: Readonly<Record<string, RecordShape>> = {
  message: {
    keep: ["type", "id", "role", "phase", "status", "end_turn"],
    walk: { content: messageContent },
  },
  reasoning: { keep: ["type", "id", "summary", "content", "encrypted_content"] },
  function_call: {
    keep: ["type", "id", "call_id", "name", "namespace", "status"],
    walk: { arguments: blankEncoded },
  },
  custom_tool_call: {
    keep: ["type", "id", "call_id", "name", "status"],
    walk: { input: blankEncoded },
  },
  function_call_output: { keep: ["type", "id", "call_id"], walk: { output } },
  custom_tool_call_output: { keep: ["type", "id", "call_id"], walk: { output } },
};

const OTHER_ITEM: RecordShape = { keep: ["type", "id", "call_id", "name", "status"] };

const responseItem = byType(ITEMS, OTHER_ITEM);

/** Events that carry what was said, or the turn's bookkeeping: kept whole. */
const KEPT_EVENTS = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "agent_reasoning_section_break",
  "token_count",
  "task_started",
  "task_complete",
  "turn_aborted",
  "context_compacted",
]);

const OTHER_EVENT: RecordShape = { keep: ["type", "call_id", "turn_id", "id", "status"] };

function eventMsg(event: unknown): unknown {
  if (isJsonObject(event) && typeof event.type === "string" && KEPT_EVENTS.has(event.type)) {
    return "message" in event && event.type === "user_message"
      ? { ...event, message: said(event.message) }
      : event;
  }
  return reshape(event, OTHER_EVENT);
}

/** The summary (`message`) quotes what tools read and printed: it goes with the rest. */
const COMPACTED: RecordShape = {
  walk: {
    replacement_history: (history) =>
      Array.isArray(history) ? history.map(responseItem) : blankUnknown(history),
  },
};

const KEPT_LINES = new Set(["session_meta", "turn_context"]);

function line(row: unknown): unknown {
  if (!isJsonObject(row)) return blankUnknown(row);
  const type = typeof row.type === "string" ? row.type : "";
  const payload = (walk: (value: unknown) => unknown): RecordShape => ({
    keep: ["timestamp", "type"],
    walk: { payload: walk },
  });
  if (KEPT_LINES.has(type)) return row;
  if (type === "response_item") return reshape(row, payload(responseItem));
  if (type === "event_msg") return reshape(row, payload(eventMsg));
  if (type === "compacted")
    return reshape(
      row,
      payload((p) => reshape(p, COMPACTED)),
    );
  return reshape(row, { keep: ["timestamp", "type"] });
}

export function redactCodexToolCalls(text: string): string {
  return redactRecords(text, "jsonl", line);
}
