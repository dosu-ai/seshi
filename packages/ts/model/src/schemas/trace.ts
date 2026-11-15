/** `seshi/trace/1`: the one canonical stored trace (X6.2). The types are generated from
 * `spec/schemas/trace.schema.json`; `parse.ts` derives the events and `content_hash`
 * (`spec/layout.md` is the contract). Renderers in `@seshi/formats` turn it into Letta
 * trajectory-v1, OTLP and ATIF on read. */

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
