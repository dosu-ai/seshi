import { firstJsonlField, lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import type { JsonObject } from "@seshi/model";
import { CLAUDE_CODE_CAPTURE } from "./capture";
import { claudeCodeCalls } from "./claude-calls";
import { markClaudeInputs, markedAsObservations } from "./claude-inputs";

export { CLAUDE_CODE_CAPTURE } from "./capture";
export { claudeCodeCalls } from "./claude-calls";
export { markClaudeInputs, markedAsObservations } from "./claude-inputs";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const CLAUDE_CODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "claude-code",
  // 2: the meta record names Claude Code's version (`agent_version`).
  revision: 2,
  // `{ type: "user" | "assistant", uuid, sessionId, message: { role, content } }`.
  detect: {
    record: (row) =>
      (row.type === "user" || row.type === "assistant") &&
      isObject(row.message) &&
      typeof row.uuid === "string",
  },
  prepare: markClaudeInputs,
  finish: (records) => markedAsObservations(records),
  calls: (transcript) => claudeCodeCalls(transcript),
  // Each line Claude Code writes carries the version that wrote it (`"version": "2.1.326"`).
  agentVersion: (transcript) => firstJsonlField(transcript, (row) => row.version),
});

export const claudeCode = defineIntegration({
  name: "claude-code",
  formats: [CLAUDE_CODE_FORMAT],
  capture: CLAUDE_CODE_CAPTURE,
});
