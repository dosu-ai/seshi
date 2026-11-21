import type { OtlpTrace } from "./otlp";
import type { Continuation, Trace, TraceEvent } from "./trace";
import type { NormalizedRecord } from "./trajectory";

/** `seshi` (the stored canonical trace, the default), `letta` (Letta trajectory-v1, schema
 * `sessionstorage/trace/1`), `otlp` (OTLP/HTTP JSON GenAI spans) or `atif` (an ATIF-v1.7
 * document). */
export type RenderFormat = "seshi" | "letta" | "otlp" | "atif";

export const RENDER_FORMATS: readonly RenderFormat[] = ["seshi", "letta", "otlp", "atif"];

export function isRenderFormat(value: unknown): value is RenderFormat {
  return typeof value === "string" && (RENDER_FORMATS as readonly string[]).includes(value);
}

/** The schema id of the Letta rendering. */
export const LETTA_TRACE_SCHEMA = "sessionstorage/trace/1" as const;

/** A trace rendered as Letta trajectory-v1: the canonical trace with plain trajectory-v1
 * records (no seshi fields), without `llm_calls` and `provenance`, and the same events and
 * `content_hash`. */
export interface LettaTrace {
  schema: typeof LETTA_TRACE_SCHEMA;
  content_hash: string;
  source: string;
  agent: string;
  project?: string;
  branch?: string;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  records: NormalizedRecord[];
  events: TraceEvent[];
  metadata: {
    cwd?: string;
    git_branch?: string;
    model?: string;
    parent_session_id?: string;
    continuation?: Continuation;
    normalizer?: { name: string; version: string };
    [key: string]: unknown;
  };
}

/** One ATIF step (Harbor's Agent Trajectory Interchange Format). */
export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  message: string;
  model_name?: string;
  reasoning_content?: string;
  tool_calls?: { tool_call_id: string; function_name: string; arguments: unknown }[];
  observation?: {
    results: { source_call_id?: string; content: string; extra?: Record<string, unknown> }[];
  };
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number };
  extra?: Record<string, unknown>;
}

/** A trace rendered as an ATIF-v1.7 document. */
export interface AtifDocument {
  schema_version: "ATIF-v1.7";
  session_id?: string;
  agent: { name: string; version: string; model_name?: string; extra?: Record<string, unknown> };
  steps: AtifStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps: number;
  };
  extra?: Record<string, unknown>;
}

/** A trace as some format renders it. */
export type RenderedTrace = Trace | LettaTrace | OtlpTrace | AtifDocument;

/** Which rendering each format gives. */
export interface RenderedTraces {
  seshi: Trace;
  letta: LettaTrace;
  otlp: OtlpTrace;
  atif: AtifDocument;
}
