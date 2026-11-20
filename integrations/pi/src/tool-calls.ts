/** pi's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls). A session line is an
 * entry (`{type, id, parentId, timestamp, …}`).
 *
 * - `message` entries, by the message's role: an assistant's `toolCall` blocks keep their type,
 *   id and name and lose every string of their `arguments`; a `toolResult` keeps `toolCallId`,
 *   `toolName` and `isError` and loses every string of its `content`, `details` and nested
 *   calls; a command the person ran (`bashExecution`) keeps its exit code and loses its command
 *   and output. What the person, the agent and the system prompt said is kept.
 * - `session`, `model_change`, `thinking_level_change`, `label` and `session_info` entries are
 *   kept; a `compaction` or `branch_summary` loses its summary, which quotes what tools read and
 *   printed.
 * - Text an extension added (`custom_message`) is blanked like a tool's output, as is any other
 *   entry, role or block this pass does not know, which keeps only its type, ids and time.
 *
 * Loaded with the capture agent, so it imports only `@seshi/kit`. */

import {
  blankResult,
  blankStrings,
  blankUnknown,
  byType,
  isJsonObject,
  type RecordShape,
  redactRecords,
} from "@seshi/kit";

const ENTRY_IDS = ["type", "id", "parentId", "timestamp"];

const BLOCKS: Readonly<Record<string, RecordShape>> = {
  text: { keep: ["type", "text", "textSignature"] },
  thinking: { keep: ["type", "thinking", "thinkingSignature", "redacted"] },
  image: { keep: ["type", "data", "mimeType"] },
  toolCall: { keep: ["type", "id", "name"], walk: { arguments: blankStrings } },
};

const block = byType(BLOCKS, { keep: ["type"] });

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
  compactionSummary: { keep: ["role", "timestamp", "tokensBefore"] },
  branchSummary: { keep: ["role", "timestamp", "fromId"] },
};

const message = byType(ROLES, { keep: ["role", "timestamp"] }, "role");

const KEPT_ENTRIES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "label",
  "session_info",
]);

const ENTRIES: Readonly<Record<string, RecordShape>> = {
  message: { keep: ENTRY_IDS, walk: { message } },
  // A summary quotes what tools read and printed: it goes with the rest.
  compaction: { keep: [...ENTRY_IDS, "firstKeptEntryId", "tokensBefore", "fromHook"] },
  branch_summary: { keep: [...ENTRY_IDS, "fromId", "fromHook"] },
  // `details` keeps its flags (an integrator's `session_capture.omit`), not its text.
  custom_message: {
    keep: [...ENTRY_IDS, "customType", "display"],
    walk: { details: blankStrings },
  },
};

const otherEntry = byType(ENTRIES, { keep: ENTRY_IDS });

function entry(value: unknown): unknown {
  if (!isJsonObject(value)) return blankUnknown(value);
  return typeof value.type === "string" && KEPT_ENTRIES.has(value.type) ? value : otherEntry(value);
}

export function redactPiToolCalls(text: string): string {
  return redactRecords(text, "jsonl", entry);
}
