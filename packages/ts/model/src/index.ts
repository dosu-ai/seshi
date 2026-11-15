/** `@seshi/model`: the types every layer shares (the trace, the stored objects, the session API,
 * the format adapter contract), the canonical text and hashing rules, and trajectory-v1
 * validation. Layer 0: it imports no other `@seshi` package (X3.2). */

export type {
  ChangesPage,
  Fetch,
  Identity,
  IngestResult,
  ListSessionsOptions,
  NormalizeStoredResult,
  PutRawResult,
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
export { canonicalText, stripNul } from "./canonical";
export { IngestRejected, OffsetMismatch, SessionRejected, StoreError } from "./errors";
export type {
  Chunk,
  DocumentHead,
  FormatAdapter,
  FormatDetection,
  HeadValue,
  JsonObject,
} from "./format-adapter";
export { type ParseOptions, parseTrajectory } from "./parse";
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
  ChangeEntry,
  ChangeKind,
  LayoutMarker,
  NormalizedState,
  RawFormat,
  RawPart,
  SessionMetadata,
  SessionStatus,
  SessionTraceRef,
  TraceFormat,
} from "./schemas/store";
export {
  CHANGE_SCHEMA,
  isTraceFormat,
  LAYOUT_SCHEMA,
  METADATA_SCHEMA,
  TRACE_FORMATS,
} from "./schemas/store";
export type {
  Continuation,
  EventRole,
  Trace,
  TraceEvent,
  TraceMetadata,
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
export { isScopeCoordinate, TrajectoryError, validateRecords } from "./schemas/trajectory";
export { VERSION } from "./version";
