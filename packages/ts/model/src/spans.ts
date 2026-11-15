/** Span sets (X4.2): what OTLP pushes (F4) and pollers such as Datadog (F5) submit for the span
 * assembler, and the contract a span format implements. Spans arrive out of order and repeat,
 * so they are not a log: each span is normalized and regex-redacted on arrival into a
 * `SpanPart`, kept under its session's `spans/`, and the assembler later orders a session's
 * parts into the canonical trace's records (F4.4).
 *
 * Spans travel in OTLP's JSON mapping (`opentelemetry-proto`), whatever they arrived as: the
 * OTLP receiver decodes protobuf into it, and a poller builds it from its vendor's API. Ids are
 * lowercase hex, times are decimal strings of Unix nanoseconds, enums are integers.
 *
 * The types live in the lowest layer because the formats that read spans (`@seshi/formats`,
 * integrations through `@seshi/kit`) and the pipeline that stores them sit on different
 * layers. */

import type { Claims } from "./generated/common";
import type { LlmCall } from "./schemas/trace";
import type { NormalizedRecord } from "./schemas/trajectory";

/** An OTLP `AnyValue` in its JSON mapping. `intValue` is a string when it does not fit a
 * double exactly (int64); `bytesValue` is base64. */
export type SpanValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string | number }
  | { doubleValue: number }
  | { bytesValue: string }
  | { arrayValue: { values: SpanValue[] } }
  | { kvlistValue: { values: SpanAttribute[] } };

/** An OTLP `KeyValue`. A value the sender left empty has no `value`. */
export interface SpanAttribute {
  key: string;
  value?: SpanValue;
}

export interface SpanEvent {
  timeUnixNano?: string;
  name: string;
  attributes?: SpanAttribute[];
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: SpanAttribute[];
}

/** `STATUS_CODE_UNSET` = 0, `STATUS_CODE_OK` = 1, `STATUS_CODE_ERROR` = 2. */
export interface SpanStatus {
  code?: number;
  message?: string;
}

/** One span as received (OTLP's JSON mapping). `kind`: 0 unspecified, 1 internal, 2 server,
 * 3 client, 4 producer, 5 consumer. */
export interface ReceivedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes?: SpanAttribute[];
  events?: SpanEvent[];
  links?: SpanLink[];
  status?: SpanStatus;
  /** The instrumentation scope that emitted it (`com.anthropic.claude-platform`), carried from
   * its `ScopeSpans` so a format can tell an SDK span from an API span. */
  scope?: { name?: string; version?: string };
}

/** A tool call a span ran (an `execute_tool` span). */
export interface SpanTool {
  /** The tool call id the model assigned (`gen_ai.tool.call.id`), when the span names it. */
  call_id?: string;
  name: string;
  /** The arguments as sent (usually JSON). */
  args?: string;
  /** What went back to the model. */
  result?: string;
  /** False when the tool failed. */
  ok?: boolean;
}

/** One span, normalized: its part of the session, in trajectory-v1 records and an LLM call,
 * plus what the assembler orders and joins it by. This is what the span store keeps (regex
 * redaction has run on every text field), never the span as received. */
export interface SpanPart {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  /** The OTLP span kind (2 server, 3 client, …). */
  kind?: number;
  /** ISO 8601. */
  started_at: string;
  ended_at?: string;
  /** The exact times, in Unix nanoseconds, so parts that start in one millisecond still
   * order. */
  start_unix_nano?: string;
  end_unix_nano?: string;
  status?: "ok" | "error" | "unset";
  /** `gen_ai.operation.name` (`chat`, `invoke_agent`, `execute_tool`, …). */
  operation?: string;
  /** The conversation thread it belongs to (`gen_ai.conversation.id`): inputs repeat history
   * per thread, so history is matched within one. */
  thread?: string;
  /** What the span says went in: system instructions and input messages, as records. A chat
   * request repeats the conversation so far; the assembler keeps only what is new. */
  input?: NormalizedRecord[];
  /** What came out: the response's messages, as records. */
  output?: NormalizedRecord[];
  /** The tool call an `execute_tool` span ran; written out only when no message already
   * holds that call. */
  tool?: SpanTool;
  /** The model request the span stands for, when it reports one (model, usage, stop reason,
   * error). Its id is unique within the session. */
  llm_call?: LlmCall;
  /** The response id (`gen_ai.response.id`): the same response reported by two spans (an
   * SDK's client span and the API's server span) is kept once. */
  response_id?: string;
  /** Whether the span carried prompt or response content (F4.5). */
  content: boolean;
  /** The span ends the session (a final span, F4.4): the assembler need not wait the whole
   * quiet period. */
  final?: boolean;
  /** What the session is, when the span says: the model, the agent's version, the working
   * folder. The first part that names one wins. */
  meta?: { model?: string; agent_version?: string; cwd?: string };
}

/** What the assembler makes of a session's parts: its records (meta first) and the LLM calls
 * they name. */
export interface AssembledSpans {
  records: NormalizedRecord[];
  llm_calls: LlmCall[];
}

/** The resource a batch of spans came with (`service.name`, …), as attributes. */
export type SpanResource = readonly SpanAttribute[];

/** How one span format reads spans (X4.2): a format adapter that takes span sets has one
 * (`FormatAdapter.spans`). The OTLP receiver and pollers group spans into sessions with
 * `sessionKey`, the pipeline normalizes each with `normalize` on arrival, and the assembler
 * joins a session's parts with `assemble`. All three are pure. */
export interface SpanAdapter {
  /** The session a span belongs to (F4.3), in the source's own naming: for OTLP
   * `anthropic.session.id`, else `gen_ai.conversation.id`, else the trace id. */
  sessionKey(span: ReceivedSpan, resource: SpanResource): string;
  /** Whether the span carries prompt or response content: a batch where none does is from a
   * metadata-only destination (F4.5). */
  hasContent(span: ReceivedSpan, resource: SpanResource): boolean;
  /** Identity the span asserts (X5.5): account ids, a user id. Recorded, never trusted. */
  claims?(span: ReceivedSpan, resource: SpanResource): Claims | undefined;
  /** One span → its part of the session, before redaction. Throws for a span it cannot
   * read. */
  normalize(span: ReceivedSpan, resource: SpanResource): SpanPart;
  /** A session's parts, in any order and possibly repeated → its records and calls. */
  assemble(parts: readonly SpanPart[], session: { source: string }): AssembledSpans;
}
