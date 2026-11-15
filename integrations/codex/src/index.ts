/** Codex (X3.11): the rollout format, normalized by `@letta-ai/trajectory` with the forked
 * history and subagent report fixups in `codex-rollout.ts` around it. A forked rollout's
 * inherited history is cut by what its `session_meta` says; a chunk past the rollout's head
 * never holds any of it, since a session has a head only once the subagent's own records,
 * which come after, were stored. */

import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import type { JsonObject } from "@seshi/model";
import { subagentReportsAsObservations, withoutInheritedHistory } from "./codex-rollout";

export { subagentReportsAsObservations, withoutInheritedHistory } from "./codex-rollout";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A Codex rollout (`~/.codex/sessions/<date>/rollout-<id>.jsonl`). */
export const CODEX_FORMAT: FormatAdapter = lettaAdapter({
  source: "codex",
  // `{ timestamp, type: "session_meta" | "response_item" | …, payload: {…} }`.
  detect: {
    record: (row) =>
      typeof row.type === "string" &&
      ["session_meta", "response_item", "event_msg", "turn_context"].includes(row.type) &&
      isObject(row.payload),
  },
  prepare: withoutInheritedHistory,
  finish: (records) => subagentReportsAsObservations(records),
});

export const codex = defineIntegration({
  name: "codex",
  formats: [CODEX_FORMAT],
});
