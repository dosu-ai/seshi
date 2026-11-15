/** Claude Code (X3.11): what seshi knows about Claude Code's own files: its transcript format,
 * normalized by `@letta-ai/trajectory` with the background-task input fixups in
 * `claude-inputs.ts` around it, and how its sessions are captured (`capture.ts`, F9). */

import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import type { JsonObject } from "@seshi/model";
import { CLAUDE_CODE_CAPTURE } from "./capture";
import { markClaudeInputs, markedAsObservations } from "./claude-inputs";

export { CLAUDE_CODE_CAPTURE } from "./capture";
export { markClaudeInputs, markedAsObservations } from "./claude-inputs";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A Claude Code transcript (`~/.claude/projects/<project>/<session>.jsonl`). */
export const CLAUDE_CODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "claude-code",
  // `{ type: "user" | "assistant", uuid, sessionId, message: { role, content } }`.
  detect: {
    record: (row) =>
      (row.type === "user" || row.type === "assistant") &&
      isObject(row.message) &&
      typeof row.uuid === "string",
  },
  prepare: markClaudeInputs,
  finish: (records) => markedAsObservations(records),
});

export const claudeCode = defineIntegration({
  name: "claude-code",
  formats: [CLAUDE_CODE_FORMAT],
  capture: CLAUDE_CODE_CAPTURE,
});
