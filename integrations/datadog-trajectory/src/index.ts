/** Datadog Trajectory (X3.11): the daemon's session files (`daemon/`). The LLM Observability
 * poller (`llmobs/`, F5) comes later. `@letta-ai/trajectory` has no adapter for this format,
 * so the adapter is seshi's own. */

import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import { DATADOG_TRAJECTORY, normalizeDatadogTrajectory } from "./daemon/adapter";

export {
  DATADOG_TRAJECTORY,
  type DatadogNormalizeOptions,
  normalizeDatadogTrajectory,
} from "./daemon/adapter";

/** A Datadog Trajectory session stream
 * (`~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl`). */
export const DATADOG_TRAJECTORY_FORMAT: FormatAdapter = {
  source: DATADOG_TRAJECTORY,
  chunkable: true,
  // `{ session_id, event_type, sequence_number, … }`.
  detect: {
    record: (row) =>
      typeof row.session_id === "string" &&
      typeof row.event_type === "string" &&
      typeof row.sequence_number === "number",
  },
  normalize: (transcript, chunk) =>
    normalizeDatadogTrajectory(transcript, { partial: chunk !== undefined }),
};

export const datadogTrajectory = defineIntegration({
  name: "datadog-trajectory",
  formats: [DATADOG_TRAJECTORY_FORMAT],
});
