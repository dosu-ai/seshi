/** `@seshi/model`: the types every layer shares (the canonical trace, the stored objects, the
 * envelope, the session API, the format adapter contract), the canonical text and hashing
 * rules, and trace validation. The types of what other languages read are generated from
 * `spec/schemas/` into `src/generated/` (`bun run types`, X3.10). Layer 0: it imports no other
 * `@seshi` package (X3.2). */

export type {
  ChangesPage,
  Fetch,
  Identity,
  IngestResult,
  ListSessionsOptions,
  ReadChangesOptions,
  SessionDB,
  SessionsPage,
  SessionUpload,
  ShippedPrefix,
  ShippedState,
  StorageView,
  StoredTrace,
  StoreSessionResult,
  Upload,
} from "./api";
export { EMPTY_PREFIX_SHA256 } from "./api";
export { canonicalText, stripNul } from "./canonical";
export {
  Forbidden,
  IngestRejected,
  OffsetMismatch,
  SessionConflict,
  SessionRejected,
  StoreError,
} from "./errors";
export type {
  Chunk,
  DocumentHead,
  FormatAdapter,
  FormatDetection,
  HeadValue,
  JsonObject,
} from "./format-adapter";
export type {
  Caller,
  Envelope,
  LogPayload,
  Payload,
  SpanPayload,
} from "./generated/envelope";
export { SCHEMA_ID as ENVELOPE_SCHEMA } from "./generated/envelope";
export { type ParseOptions, parseTrace } from "./parse";
export { canonicalJson, PrefixHash, prefixSha256, ResumableSha256 } from "./prefix-hash";
export type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpSpan,
  OtlpSpanKind,
  OtlpStatus,
  OtlpTrace,
} from "./schemas/otlp";
export { OTLP_TRACE_SCHEMA } from "./schemas/otlp";
export type {
  AtifDocument,
  AtifStep,
  LettaTrace,
  RenderedTrace,
  RenderedTraces,
  RenderFormat,
} from "./schemas/renders";
export { isRenderFormat, LETTA_TRACE_SCHEMA, RENDER_FORMATS } from "./schemas/renders";
export type {
  AppliedEnvelope,
  CallerKind,
  ChangeEntry,
  ChangeKind,
  Claims,
  LayoutMarker,
  LogEncoding,
  NormalizedState,
  Normalizer,
  OwnerBasis,
  Provenance,
  RawFormat,
  RedactionSummary,
  SessionMetadata,
  SessionStatus,
  SessionTraceRef,
  Sha256,
  SourceId,
  SourceKind,
  SourceLocation,
  Timestamp,
  TombstoneReason,
  Visibility,
  Writer,
} from "./schemas/store";
export {
  CHANGE_SCHEMA,
  LAYOUT_SCHEMA,
  LEGACY_LAYOUT_SCHEMA,
  localWriter,
  METADATA_SCHEMA,
  UPLOAD_SOURCE,
} from "./schemas/store";
export type {
  Continuation,
  EventRole,
  LlmCall,
  TokenUsage,
  Trace,
  TraceAssistantRecord,
  TraceEvent,
  TraceMetadata,
  TraceMetaRecord,
  TraceRecord,
  TraceTextRecord,
  TraceToolCall,
  TraceToolResultRecord,
} from "./schemas/trace";
export { TRACE_SCHEMA } from "./schemas/trace";
export type {
  AssistantMessageRecord,
  AssistantToolCallRecord,
  MetaRecord,
  NormalizedRecord,
  ObservationRecord,
  ReasoningRecord,
  SystemRecord,
  ToolCall,
  ToolResultRecord,
  UserRecord,
} from "./schemas/trajectory";
export {
  isScopeCoordinate,
  TrajectoryError,
  validateRecords,
  validateTraceRecords,
} from "./schemas/trajectory";
export { VERSION } from "./version";
