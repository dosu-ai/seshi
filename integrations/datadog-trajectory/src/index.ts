import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import { DATADOG_TRAJECTORY, normalizeDatadogTrajectory } from "./daemon/adapter";
import { DATADOG_CONNECTOR } from "./llmobs/connector";
import { DATADOG_LLMOBS_FORMAT } from "./llmobs/format";

export {
  DATADOG_TRAJECTORY,
  type DatadogNormalizeOptions,
  normalizeDatadogTrajectory,
} from "./daemon/adapter";
export {
  apiBase,
  DatadogApiError,
  DatadogShapeError,
  readSearchResponse,
  SEARCH_PATH,
  searchBody,
} from "./llmobs/api";
export type * from "./llmobs/api-types";
export {
  batchKey,
  DATADOG_CONNECTOR,
  DATADOG_SOURCE,
  type DatadogConnectorOptions,
  type DatadogCursor,
  type DatadogSourceConfig,
  datadogConnector,
  nextWindow,
  readDatadogConfig,
  readDatadogCursor,
  serviceEnvelopeIdentity,
  UNREADABLE_SPANS,
} from "./llmobs/connector";
export {
  assembleDatadogParts,
  DATADOG_LLMOBS,
  DATADOG_LLMOBS_FORMAT,
  DATADOG_SPANS,
  datadogClaims,
  datadogPart,
  spansOfDocument,
} from "./llmobs/format";
export { idHex, sessionOf, startNanos, tagValue, toReceivedSpan } from "./llmobs/spans";

export const DATADOG_TRAJECTORY_FORMAT: FormatAdapter = {
  source: DATADOG_TRAJECTORY,
  chunkable: true,
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
  formats: [DATADOG_TRAJECTORY_FORMAT, DATADOG_LLMOBS_FORMAT],
  connectors: [DATADOG_CONNECTOR],
});
