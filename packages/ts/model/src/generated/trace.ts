/** Generated from spec/schemas/trace.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

import type { Continuation, Normalizer, Provenance, Sha256 } from "./common";

/** The `schema` value of every Trace object. */
export const SCHEMA_ID = "seshi/trace/1" as const;

/** `seshi/trace/1`: the one canonical stored trace (X6.2), the immutable, content-addressed object at `owners/<owner>/sessions/<archive_id>/trace.<content_hash>.json.gz`. Evolved from trajectory-v1: `records` are trajectory-v1 records with optional fields for what raw used to keep (X6.3), `llm_calls` holds model and token usage per LLM call, and `provenance` says where the data came from. `events` and `content_hash` are derived from the records exactly as before (spec/layout.md), so hashes do not change. Letta (trajectory-v1), OTLP and ATIF are rendered from it on read. */
export interface Trace {
  schema: "seshi/trace/1";
  /** sha256 of what was said: `source` (plus `@from_record` for a continuation), then each event's role and text (spec/layout.md). */
  content_hash: Sha256;
  /** The meta record's `source` (`claude-code`, `codex`, an ATIF document's harness, …). */
  source: string;
  /** The format the session was filed under (the archive id derives from it). */
  agent: string;
  project?: string;
  branch?: string;
  session_id: string | null;
  /** The earliest event timestamp, as shipped; null when no event has one that parses. */
  started_at: string | null;
  /** The latest event timestamp, as shipped; null when no event has one that parses. */
  ended_at: string | null;
  /** The records after redaction and NUL stripping, meta record first: what `events` were derived from. */
  records: TraceRecord[];
  events: TraceEvent[];
  metadata: TraceMetadata;
  /** The LLM calls the session made, referenced from records by `llm_call`. Absent when the source records none. */
  llm_calls?: LlmCall[];
  provenance?: Provenance;
}

/** One record: trajectory-v1, plus optional fields trajectory-v1 lacks. */
export type TraceRecord =
  | TraceMetaRecord
  | TraceTextRecord
  | TraceAssistantRecord
  | TraceToolResultRecord;

/** The first record, and only the first: what the session is. */
export interface TraceMetaRecord {
  role: "meta";
  source: string;
  cwd?: string;
  git_branch?: string;
  /** The session's main model, when the source names one. */
  model?: string;
  /** The version of the agent harness that wrote the transcript. */
  agent_version?: string;
}

/** A user prompt, a system message, an observation from the environment, or the model's reasoning. */
export interface TraceTextRecord {
  role: "user" | "system" | "observation" | "reasoning";
  content: string;
  timestamp: string;
  id?: RecordId;
  llm_call?: LlmCallRef;
}

/** What the assistant said, or the tools it called (or both). */
export interface TraceAssistantRecord {
  role: "assistant";
  content: string | null;
  tool_calls?: TraceToolCall[];
  timestamp: string;
  id?: RecordId;
  llm_call?: LlmCallRef;
}

export interface TraceToolCall {
  /** The tool call id the agent assigned. */
  id: string;
  name: string;
  /** The arguments as the agent sent them (usually JSON). */
  args: string;
}

/** A tool call's result. */
export interface TraceToolResultRecord {
  role: "tool";
  tool_call_id: string;
  content: string;
  /** Whether the call succeeded, when the source says. */
  ok?: boolean;
  timestamp: string;
  id?: RecordId;
  /** Set when the result's content was replaced because the call touched a sensitive file or printed a secret (F2). */
  withheld?: "sensitive-file" | "secret-output";
  /** How long the call ran, when the source says. */
  duration_ms?: number;
}

/** The record's id in its source (a message uuid, a span id), for provenance. */
export type RecordId = string;

/** The `id` of the entry in `llm_calls` that produced this record. */
export type LlmCallRef = string;

/** One request to a model: which model, when, what it cost in tokens and how it ended. */
export interface LlmCall {
  /** Unique within the trace. */
  id: string;
  /** The model that answered. */
  model?: string;
  /** `anthropic`, `openai`, `bedrock`, … */
  provider?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  usage?: TokenUsage;
  /** Why generation stopped, in the provider's words. */
  stop_reason?: string;
  /** The provider's request or response id. */
  request_id?: string;
  /** Request parameters the source records (`temperature`, `max_tokens`, …). */
  parameters?: {
    [key: string]: string | number | boolean | null;
  };
  /** The error the call ended with, if it failed. */
  error?: string;
}

/** Token counts as the provider reports them. */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export type EventRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system"
  | "observation"
  | "reasoning";

/** One unit of a trace. `index` is stable for the life of the object; `text` is the canonical string excerpts are validated against. */
export interface TraceEvent {
  index: number;
  role: EventRole;
  text: string;
  /** The record's timestamp as shipped; null when it does not parse. */
  timestamp: string | null;
  tool_name?: string;
  tool_call_id?: string;
  ok?: boolean;
}

/** Lineage and scope attached at ingest, plus the meta record's `cwd`, `git_branch` and `model`. */
export interface TraceMetadata {
  cwd?: string;
  git_branch?: string;
  model?: string;
  /** The session this one was spawned by (a subagent, a fork). */
  parent_session_id?: string;
  continuation?: Continuation;
  normalizer?: Normalizer;
  [key: string]: unknown;
}
