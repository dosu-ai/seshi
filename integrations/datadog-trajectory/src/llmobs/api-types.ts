/** The Datadog LLM Observability Export API's shapes (F5.1), as Datadog documents them
 * ("Export API" in the LLM Observability docs, and "Search LLM Observability spans" in the API
 * reference). The endpoints are marked preview, so these types are pinned to the tested shape
 * and `readSearchResponse` fails loudly when a response stops matching it. */

/** One message of a span's input or output (`SearchedIO.messages`). */
export interface DatadogMessage {
  content?: string;
  role?: string;
  tool_calls?: readonly DatadogToolCall[];
  tool_results?: readonly DatadogToolResult[];
}

export interface DatadogToolCall {
  name?: string;
  arguments?: unknown;
  tool_id?: string;
  type?: string;
}

export interface DatadogToolResult {
  name?: string;
  result?: unknown;
  tool_id?: string;
  type?: string;
}

/** A span's input or output (`SearchedIO`). */
export interface DatadogIO {
  value?: string;
  messages?: readonly DatadogMessage[];
}

/** One span's attributes (`SearchedSpan`). Fields the docs list and seshi does not read
 * (`evaluation`, `tool_definitions`, `intent`) are allowed and ignored. */
export interface DatadogSpan {
  span_id: string;
  trace_id: string;
  /** The parent's id; Datadog answers the string `undefined` for a root span. */
  parent_id?: string | null;
  tags?: readonly string[];
  name?: string;
  /** `ok` or `error`. */
  status?: string;
  /** Documented as nanoseconds since the epoch. */
  start_ns: number | string;
  /** Documented as nanoseconds. */
  duration?: number;
  ml_app?: string;
  metadata?: Record<string, unknown>;
  /** `agent`, `workflow`, `llm`, `tool`, `task`, `embedding` or `retrieval`. */
  span_kind?: string;
  model_name?: string;
  model_provider?: string;
  input?: DatadogIO;
  output?: DatadogIO;
  metrics?: Record<string, number>;
  /** Not in the documented model, but some answers carry the span's session. */
  session_id?: string;
}

/** One item of `data` (`SearchedSpanResource`). */
export interface DatadogSpanResource {
  id?: string;
  type?: string;
  attributes: DatadogSpan;
}

/** The answer to a search (both endpoints answer the same shape). */
export interface DatadogSearchResponse {
  data: DatadogSpanResource[];
  meta?: {
    elapsed?: number;
    request_id?: string;
    /** `done`, or `timeout` when Datadog cut the query short. */
    status?: string;
    page?: { after?: string | null } | null;
  };
  links?: { next?: string | null };
}

/** `POST /api/v2/llm-obs/v1/spans/events/search`'s body. */
export interface DatadogSearchRequest {
  data: {
    type: "spans";
    attributes: {
      filter: {
        from: string;
        to: string;
        ml_app?: string;
        tags?: Record<string, string>;
      };
      page: { limit: number; cursor?: string };
      sort: "timestamp" | "-timestamp";
      options: { include_attachments: boolean };
    };
  };
}
