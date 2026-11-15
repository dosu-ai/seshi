/** `@seshi/pipeline`: one ingest pipeline (X4). An envelope in (`Pipeline.submit`); authorize,
 * normalize in memory, regex redaction, the session filter, model review; then the trace, the
 * head and the change entry out, and nothing raw (X6.3). Also the reads over a store and
 * `StoreSessionDB`, the session API over a pipeline (the HTTP routes' and local mode's).
 * Layer 2 (X3.2). */

export {
  Forbidden,
  IngestRejected,
  OffsetMismatch,
  SessionConflict,
  SessionRejected,
} from "@seshi/model";
export {
  canonicalJson,
  copiedPrefix,
  planShipment,
  prefixSha256,
  type ShipPlan,
  type ShippedPrefix,
} from "./continuation";
export {
  checkEnvelope,
  hasCaller,
  isLogEnvelope,
  type LogEnvelope,
  type SpanEnvelope,
  type UploadEnvelopeOptions,
  uploadEnvelope,
  uploadIdempotencyKey,
  writerOf,
} from "./envelope";
export {
  DEFAULT_FILTER,
  type FilterRules,
  type FilterSetting,
  filterRulesFor,
  isFiltered,
} from "./filter";
export {
  APPLIED_KEPT,
  getSession,
  getTrace,
  type IngestInput,
  type IngestMetadata,
  type IngestResult,
  ingest,
  listSessions,
  recordProgress,
  type SetVisibilityInput,
  type StoredTrace,
  setVisibility,
  type TombstoneInput,
  tombstone,
  type WithheldCallIds,
  type WriteContext,
  withApplied,
} from "./ingest";
export { DEFAULT_LIMITS, type Limits } from "./limits";
export { normalizeTranscript } from "./normalize";
export {
  type FailedResult,
  Pipeline,
  type PipelineOptions,
  type SubmitOptions,
  type SubmitResult,
  type VisibilitySetting,
} from "./pipeline";
export {
  type SessionOptions,
  type SessionUpload,
  type StoreSessionResult,
  storeSession,
} from "./session";
export { type StoreClientOptions, StoreSessionDB } from "./session-db";
export {
  type AssembledSession,
  type Authorization,
  type Authorizer,
  type HealthCounters,
  MemoryHealthCounters,
  mayReplace,
  noHealth,
  noReview,
  permissiveAuthorizer,
  type ReviewDecision,
  type Reviewer,
  type ReviewInput,
  type ReviewNote,
  type SpanAssembler,
  type SpanBatch,
  type SpanBatchResult,
  StoreHealthCounters,
} from "./stages";
