import { SCHEMA_ID } from "../generated/trace";

export type { Continuation } from "../generated/common";
export type {
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
} from "../generated/trace";

export const TRACE_SCHEMA = SCHEMA_ID;
