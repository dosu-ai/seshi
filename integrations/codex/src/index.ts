import { firstJsonlField, lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import type { JsonObject } from "@seshi/model";
import { CODEX_CAPTURE } from "./capture";
import { codexCalls } from "./codex-calls";
import { subagentReportsAsObservations, withoutInheritedHistoryInHead } from "./codex-rollout";

export { CODEX_CAPTURE } from "./capture";
export { codexCalls } from "./codex-calls";
export { subagentReportsAsObservations, withoutInheritedHistoryInHead } from "./codex-rollout";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const CODEX_FORMAT: FormatAdapter = lettaAdapter({
  source: "codex",
  // 2: the meta record names the Codex CLI's version (`agent_version`).
  revision: 2,
  // `{ timestamp, type: "session_meta" | "response_item" | …, payload: {…} }`.
  detect: {
    record: (row) =>
      typeof row.type === "string" &&
      ["session_meta", "response_item", "event_msg", "turn_context"].includes(row.type) &&
      isObject(row.payload),
  },
  prepare: withoutInheritedHistoryInHead,
  finish: (records) => subagentReportsAsObservations(records),
  calls: codexCalls,
  // `{ type: "session_meta", payload: { cli_version: "0.169.0", … } }`: the rollout's own (first)
  // `session_meta` says which Codex wrote it.
  agentVersion: (transcript) =>
    firstJsonlField(transcript, (row) =>
      row.type === "session_meta" && isObject(row.payload) ? row.payload.cli_version : undefined,
    ),
});

export const codex = defineIntegration({
  name: "codex",
  formats: [CODEX_FORMAT],
  capture: CODEX_CAPTURE,
});
