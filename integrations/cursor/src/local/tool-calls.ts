/** Cursor's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls), over the file
 * seshi uploads: the agent transcript's `{role, message: {content}}` lines with the results its
 * hooks kept added after each call (`compose`, results.ts). A `tool_use` keeps its type, id and
 * name; a `tool_result` its type, `tool_use_id` and `is_error`; text is kept; any other block
 * keeps only its type, and any other field of a line is blanked. A line that only marks a turn's
 * end is kept.
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

const BLOCKS: Readonly<Record<string, RecordShape>> = {
  text: { keep: ["type", "text"] },
  thinking: { keep: ["type", "thinking", "text", "signature"] },
  tool_use: { keep: ["type", "id", "name"], walk: { input: blankStrings } },
  tool_result: { keep: ["type", "tool_use_id", "is_error"], walk: { content: blankResult } },
};

function block(value: unknown): unknown {
  const shape = isJsonObject(value) && typeof value.type === "string" && BLOCKS[value.type];
  return reshape(value, shape || { keep: ["type"] });
}

const LINE: RecordShape = {
  keep: ["role", "type"],
  walk: {
    message: (message) =>
      reshape(message, {
        keep: ["role"],
        walk: {
          content: (c) =>
            typeof c === "string" ? c : Array.isArray(c) ? c.map(block) : blankUnknown(c),
        },
      }),
  },
};

/** Lines that only mark the conversation's progress (`turn_ended`): kept whole. */
const KEPT_LINES = new Set(["turn_ended"]);

export function redactCursorToolCalls(text: string): string {
  return redactRecords(text, "jsonl", (row) =>
    isJsonObject(row) && typeof row.type === "string" && KEPT_LINES.has(row.type)
      ? row
      : reshape(row, LINE),
  );
}
