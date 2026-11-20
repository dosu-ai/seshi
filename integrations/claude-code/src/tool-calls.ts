/** Claude Code's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls): every
 * string in a tool call's input and result goes, wherever Claude Code keeps it.
 *
 * - `user` and `assistant` rows: in `message.content`, a `tool_use` (and `server_tool_use`,
 *   `mcp_tool_use`) keeps its type, id and name, and a `*tool_result` block its type,
 *   `tool_use_id` and `is_error`. The row's own copies of a result (`toolUseResult`, `mcpMeta`)
 *   and of an input (`wireToolInputs`) are blanked, as is any field not listed here.
 * - A user message a tool wrote (`sourceToolUseID`: a skill's text) is blanked; so is a
 *   background task's result (`<task-notification>`), the output of a command the person ran
 *   (`<bash-stdout>`, `<local-command-stdout>`, closed or cut short), whose command is kept, and
 *   a compaction's summary (`isCompactSummary`), which quotes what tools read and printed.
 * - A queued prompt (`attachment.queued_command`, `last-prompt`) is the person's, and kept the
 *   same way.
 * - Rows that only name the session (`summary`, `custom-title`, …) are kept; every other row
 *   (`progress`, `system`, `file-history-snapshot`, other attachments, …) keeps only its type, ids
 *   and time.
 *
 * Loaded alone by `seshi hook claude-code <event>` with the rest of the capture agent, so it
 * imports only `@seshi/kit`. */

import {
  blankResult,
  blankStrings,
  blankUnknown,
  isJsonObject,
  type RecordShape,
  redactRecords,
  redactTagBodies,
  reshape,
  TOOL_CALL_MARKER,
} from "@seshi/kit";

/** A row's identity and place: kept on every row. */
const ROW_IDS = [
  "type",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "sessionId",
  "timestamp",
  "isSidechain",
  "agentId",
  "userType",
  "cwd",
  "gitBranch",
  "version",
  "entrypoint",
  "slug",
];

const MESSAGE_ROW_KEEP = [
  ...ROW_IDS,
  "requestId",
  "isMeta",
  "isApiErrorMessage",
  "isCompactSummary",
  "isVisibleInTranscriptOnly",
  "promptId",
  "permissionMode",
  "origin",
  "sourceToolAssistantUUID",
  "sourceToolUseID",
  "requestedModel",
  "effort",
  "apiBlockIndex",
];

/** Rows that only say what the session is called or where it was left: kept whole. */
const KEPT_ROWS = new Set(["summary", "custom-title", "agent-name", "mode", "tag"]);

const OTHER_ROW: RecordShape = { keep: [...ROW_IDS, "subtype", "level", "isMeta", "toolUseID"] };

const CALL: RecordShape = {
  keep: ["type", "id", "name", "server_name", "caller", "cache_control"],
  walk: { input: blankStrings },
};

const RESULT: RecordShape = {
  keep: ["type", "tool_use_id", "is_error", "cache_control"],
  walk: { content: blankResult },
};

const CALL_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

/** What a command the person ran printed. */
const OUTPUT_TAGS = ["bash-stdout", "bash-stderr", "local-command-stdout", "local-command-stderr"];
const NOTIFICATION = /^\s*<task-notification/;

/** Text the person (or Claude Code for them) put in the conversation, with what tools and
 * commands returned in it replaced. */
function personText(text: unknown): unknown {
  if (typeof text !== "string") return blankUnknown(text);
  if (NOTIFICATION.test(text)) return `<task-notification>${TOOL_CALL_MARKER}</task-notification>`;
  return redactTagBodies(text, OUTPUT_TAGS);
}

function block(value: unknown, fromPerson: boolean): unknown {
  if (!isJsonObject(value)) return blankUnknown(value);
  const type = typeof value.type === "string" ? value.type : "";
  if (CALL_TYPES.has(type)) return reshape(value, CALL);
  if (type.endsWith("tool_result")) return reshape(value, RESULT);
  switch (type) {
    case "text":
      return reshape(value, {
        keep: ["type", "cache_control"],
        walk: { text: (t) => (fromPerson ? personText(t) : t) },
      });
    case "thinking":
      return reshape(value, { keep: ["type", "thinking", "signature"] });
    case "redacted_thinking":
      return reshape(value, { keep: ["type", "data"] });
    case "image":
    case "document":
      // Something the person attached; one a tool returned is inside its result.
      return fromPerson ? value : reshape(value, { keep: ["type"] });
    default:
      return reshape(value, { keep: ["type"] });
  }
}

function content(value: unknown, fromPerson: boolean, byTool: boolean): unknown {
  if (byTool) return blankResult(value);
  if (typeof value === "string") return fromPerson ? personText(value) : value;
  if (Array.isArray(value)) return value.map((b) => block(b, fromPerson));
  return blankUnknown(value);
}

function messageRow(row: Record<string, unknown>): unknown {
  const fromPerson = row.type === "user";
  // A tool's text, or a compaction's summary of what tools read and printed.
  const byTool =
    fromPerson && (typeof row.sourceToolUseID === "string" || row.isCompactSummary === true);
  return reshape(row, {
    keep: MESSAGE_ROW_KEEP,
    walk: {
      message: (message) =>
        reshape(message, {
          keep: [
            "role",
            "id",
            "type",
            "model",
            "stop_reason",
            "stop_sequence",
            "usage",
            "container",
          ],
          walk: { content: (c) => content(c, fromPerson, byTool) },
        }),
    },
  });
}

/** A queued prompt is text, or blocks as a user message's content is. */
const queuedPrompt = (prompt: unknown) => content(prompt, true, false);

const QUEUED: RecordShape = {
  keep: ["type", "commandMode", "isMeta", "origin"],
  walk: { prompt: queuedPrompt },
};

function attachmentRow(row: Record<string, unknown>): unknown {
  return reshape(row, {
    keep: ROW_IDS,
    walk: {
      attachment: (a) =>
        isJsonObject(a) && a.type === "queued_command"
          ? reshape(a, QUEUED)
          : reshape(a, { keep: ["type"] }),
    },
  });
}

function row(value: unknown): unknown {
  if (!isJsonObject(value)) return blankUnknown(value);
  if (value.type === "user" || value.type === "assistant") return messageRow(value);
  if (value.type === "attachment") return attachmentRow(value);
  if (value.type === "queue-operation") {
    return reshape(value, { keep: [...ROW_IDS, "operation"], walk: { content: queuedPrompt } });
  }
  if (value.type === "last-prompt") {
    return reshape(value, { keep: [...ROW_IDS, "leafUuid"], walk: { lastPrompt: queuedPrompt } });
  }
  if (typeof value.type === "string" && KEPT_ROWS.has(value.type)) return value;
  return reshape(value, OTHER_ROW);
}

export function redactClaudeToolCalls(text: string): string {
  return redactRecords(text, "jsonl", row);
}
