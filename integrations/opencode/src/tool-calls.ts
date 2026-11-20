/** OpenCode's pass for `capture.redact_tool_calls` (see `@seshi/kit`'s tool-calls), over the
 * export seshi uploads: `{info, messages: [{info, parts}]}`, one JSON document.
 *
 * - A `tool` part keeps its `tool` name, `callID` and `state.status` (and times); its input keeps
 *   its keys and numbers and loses every string, and everything else of its state (`output`,
 *   `title`, `metadata`, `error`, `attachments`) is replaced.
 * - `text` and `reasoning` parts are kept, except text OpenCode added itself (`synthetic`: what it
 *   read for an `@` mention), which is a tool's output; a `subtask` the person started is kept.
 * - Any other part (`file`, `patch`, `snapshot`, …) keeps only its type and ids, and a message's
 *   or the session's fields other than those listed here (a message's `summary` with its diffs,
 *   a session's `revert`) are blanked.
 *
 * Loaded with the capture agent, so it imports only `@seshi/kit`. */

import {
  blankStrings,
  blankUnknown,
  byType,
  isJsonObject,
  type RecordShape,
  redactRecords,
  reshape,
} from "@seshi/kit";

const PART_IDS = ["id", "sessionID", "messageID", "type", "time"];

const STATE: RecordShape = { keep: ["status", "time"], walk: { input: blankStrings } };

const PARTS: Readonly<Record<string, RecordShape>> = {
  text: { keep: [...PART_IDS, "text", "synthetic", "ignored", "metadata"] },
  reasoning: { keep: [...PART_IDS, "text", "metadata"] },
  tool: {
    keep: [...PART_IDS, "callID", "tool"],
    walk: { state: (state) => reshape(state, STATE) },
  },
  subtask: { keep: [...PART_IDS, "prompt", "description", "agent", "model"] },
  agent: { keep: [...PART_IDS, "name"] },
  "step-start": { keep: PART_IDS },
  "step-finish": { keep: [...PART_IDS, "reason", "cost", "tokens"] },
  compaction: { keep: [...PART_IDS, "auto"] },
};

const otherPart = byType(PARTS, { keep: PART_IDS });

function part(value: unknown): unknown {
  if (isJsonObject(value) && value.type === "text" && value.synthetic === true) {
    return reshape(value, { keep: [...PART_IDS, "synthetic", "ignored", "metadata"] });
  }
  return otherPart(value);
}

const MESSAGE_INFO: RecordShape = {
  keep: [
    "id",
    "sessionID",
    "role",
    "time",
    "parentID",
    "modelID",
    "providerID",
    "model",
    "mode",
    "agent",
    "path",
    "cost",
    "tokens",
    "finish",
    "system",
    "variant",
  ],
};

const MESSAGE: RecordShape = {
  walk: {
    info: (info) => reshape(info, MESSAGE_INFO),
    parts: (parts) => (Array.isArray(parts) ? parts.map(part) : blankUnknown(parts)),
  },
};

const SESSION_INFO: RecordShape = {
  keep: ["id", "slug", "projectID", "directory", "parentID", "title", "version", "time", "path"],
};

const EXPORT: RecordShape = {
  walk: {
    info: (info) => reshape(info, SESSION_INFO),
    messages: (messages) =>
      Array.isArray(messages) ? messages.map((m) => reshape(m, MESSAGE)) : blankUnknown(messages),
  },
};

export function redactOpencodeToolCalls(text: string): string {
  return redactRecords(text, "json", (document) => reshape(document, EXPORT));
}
