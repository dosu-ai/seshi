/** pi's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls). A session line is an
 * entry (`{type, id, parentId, timestamp, …}`).
 *
 * - `message` entries, by the message's role: an assistant's `toolCall` blocks keep their type,
 *   id and name and lose every string of their `arguments`; a `toolResult` keeps `toolCallId`,
 *   `toolName` and `isError` and loses every string of its `content`, `details` and nested
 *   calls; a command the person ran (`bashExecution`) keeps its exit code and loses its command
 *   and output. What the person, the agent and the system prompt said is kept.
 * - `session`, `model_change`, `thinking_level_change`, `label` and `session_info` entries are
 *   kept; a `compaction` or `branch_summary` keeps its summary.
 * - Text an extension added (`custom_message`) is blanked like a tool's output, as is any other
 *   entry, role or block this pass does not know, which keeps only its type, ids and time.
 *
 * Loaded with the capture agent, so it imports only `@seshi/kit`. */

import {
  blankResult,
  blankStrings,
  blankUnknown,
  isJsonObject,
  type RecordShape,
  redactRecords,
  reshape,
} from "@seshi/kit";

const ENTRY_IDS = ["type", "id", "parentId", "timestamp"];

const BLOCKS: Readonly<Record<string, RecordShape>> = {
  text: { keep: ["type", "text", "textSignature"] },
  thinking: { keep: ["type", "thinking", "thinkingSignature", "redacted"] },
  image: { keep: ["type", "data", "mimeType"] },
  toolCall: { keep: ["type", "id", "name"], walk: { arguments: blankStrings } },
};

function block(value: unknown): unknown {
  const shape = isJsonObject(value) && typeof value.type === "string" && BLOCKS[value.type];
  return reshape(value, shape || { keep: ["type"] });
}

const said = (c: unknown) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map(block) : blankUnknown(c);

const ROLES: Readonly<Record<string, RecordShape>> = {
  user: { keep: ["role", "timestamp"], walk: { content: said } },
  assistant: {
    keep: [
      "role",
      "timestamp",
      "api",
      "provider",
      "model",
      "responseId",
      "usage",
      "stopReason",
      "rawStopReason",
      "thinkingLevel",
      "errorMessage",
    ],
    walk: { content: said },
  },
  system: { keep: ["role", "timestamp", "content", "sections", "toolsAdded"] },
  toolResult: {
    keep: ["role", "timestamp", "toolCallId", "toolName", "isError"],
    walk: { content: blankResult },
  },
  bashExecution: { keep: ["role", "timestamp", "exitCode", "cancelled", "truncated"] },
  compactionSummary: { keep: ["role", "timestamp", "summary", "tokensBefore"] },
  branchSummary: { keep: ["role", "timestamp", "summary", "fromId"] },
};

function message(value: unknown): unknown {
  const shape = isJsonObject(value) && typeof value.role === "string" && ROLES[value.role];
  return reshape(value, shape || { keep: ["role", "timestamp"] });
}

const KEPT_ENTRIES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "label",
  "session_info",
]);

const ENTRIES: Readonly<Record<string, RecordShape>> = {
  message: { keep: ENTRY_IDS, walk: { message } },
  compaction: { keep: [...ENTRY_IDS, "summary", "firstKeptEntryId", "tokensBefore", "fromHook"] },
  branch_summary: { keep: [...ENTRY_IDS, "summary", "fromId", "fromHook"] },
  // `details` keeps its flags (an integrator's `session_capture.omit`), not its text.
  custom_message: {
    keep: [...ENTRY_IDS, "customType", "display"],
    walk: { details: blankStrings },
  },
};

function entry(value: unknown): unknown {
  if (!isJsonObject(value)) return blankUnknown(value);
  const type = typeof value.type === "string" ? value.type : "";
  if (KEPT_ENTRIES.has(type)) return value;
  return reshape(value, ENTRIES[type] ?? { keep: ENTRY_IDS });
}

export function redactPiToolCalls(text: string): string {
  return redactRecords(text, "jsonl", entry);
}
