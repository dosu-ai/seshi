/** Codex's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls). A rollout line is
 * `{timestamp, type, payload}`.
 *
 * - `response_item`: a `function_call` keeps its name and `call_id` (its JSON-encoded
 *   `arguments` keep their keys and numbers, every string replaced); a `custom_tool_call` (an
 *   `apply_patch`) loses its `input`; their `*_output` items keep the `call_id` and lose every
 *   string of the output, as do `local_shell_call` and `web_search_call`'s actions. Messages and
 *   reasoning are kept.
 * - `event_msg`: what the person and the agent said (`user_message`, `agent_message`,
 *   `agent_reasoning`) and the turn's bookkeeping (`token_count`, `task_*`) are kept; every other
 *   event (`exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`, `item_completed`, …) keeps
 *   only its type and ids.
 * - `compacted`: the summary is kept; its `replacement_history` is redacted as `response_item`s.
 * - `session_meta` and `turn_context` are kept; any other line keeps only its type and time.
 *
 * Loaded with the capture agent, so it imports only `@seshi/kit`. */

import {
  blankEncoded,
  blankResult,
  blankUnknown,
  isJsonObject,
  type RecordShape,
  redactRecords,
  reshape,
} from "@seshi/kit";

const output = (value: unknown) =>
  typeof value === "string" ? blankEncoded(value) : blankResult(value);

const ITEMS: Readonly<Record<string, RecordShape>> = {
  message: { keep: ["type", "id", "role", "content", "phase", "status", "end_turn"] },
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

function responseItem(item: unknown): unknown {
  if (!isJsonObject(item)) return blankUnknown(item);
  const shape = typeof item.type === "string" ? ITEMS[item.type] : undefined;
  return reshape(item, shape ?? OTHER_ITEM);
}

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
    return event;
  }
  return reshape(event, OTHER_EVENT);
}

const COMPACTED: RecordShape = {
  keep: ["message"],
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
