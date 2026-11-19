import { lettaAdapter } from "@seshi/formats";
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
});

export const codex = defineIntegration({
  name: "codex",
  formats: [CODEX_FORMAT],
  capture: CODEX_CAPTURE,
});
