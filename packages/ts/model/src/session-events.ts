import type { Labels } from "./labels";
import type { EventRole } from "./schemas/trace";

/** How `read_session` gives events' text: `condensed` cuts each tool result to its first
 * `CONDENSED_TOOL_CHARS` characters, `full` gives it as stored. */
export type SessionReadMode = "condensed" | "full";

export const SESSION_READ_MODES: readonly SessionReadMode[] = ["condensed", "full"];

/** Every event role, in the order a trace's events are described. */
export const EVENT_ROLES: readonly EventRole[] = [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "observation",
  "reasoning",
];

/** Characters of event text one read gives at most, and by default. */
export const MAX_READ_CHARS = 30_000;
/** The least `max_chars` a read takes. */
export const MIN_READ_CHARS = 1_000;
/** A tool result's characters a condensed read keeps. */
export const CONDENSED_TOOL_CHARS = 200;
/** Events either side of `around`, by default and at most. */
export const DEFAULT_READ_CONTEXT = 5;
export const MAX_READ_CONTEXT = 50;

/** Part of one session's events (`GET /v1/sessions/{format}/{id}/events`, `read_session`). Events
 * are numbered by `seq`: their place in the session's current trace chain (its last whole
 * upload and the continuations after it), counting from 0 across its traces. */
export interface SessionEventsRequest {
  /** The range `[from, to)`; `from` defaults to 0, `to` to the end. */
  from?: number;
  to?: number;
  /** Or: `context` events either side of this one (a search match's `seq`). */
  around?: number;
  context?: number;
  mode?: SessionReadMode;
  /** Only events of these roles (the others are skipped, not counted against `max_chars`). */
  roles?: EventRole[];
  /** Characters of text to give at most: `MIN_READ_CHARS` to `MAX_READ_CHARS`, the default. */
  max_chars?: number;
  /** Read one event's text in pieces, from `offset`: an event `max_chars` cut. */
  event?: number;
  offset?: number;
  /** Count `from`, `to`, `around` and `event` from the start of this trace of the session's
   * current chain instead of from its first event: a content hash, or its first 8 or more
   * characters. With a search match's `content_hash` and `event_index`, `around` reads the
   * events around the match. The answer gives `seq`s. */
  trace?: string;
  /** Refuse (409 `head_changed`) when the session's head is no longer this: a replace numbered
   * its events again. */
  head?: string;
}

export interface SessionEvent {
  seq: number;
  role: EventRole;
  /** The trace the event is in, and its index there (`GET …/trace?hash=` at `events[index]`). */
  content_hash: string;
  event_index: number;
  timestamp?: string;
  tool_name?: string;
  /** Pairs a tool call with its result. */
  tool_call_id?: string;
  /** Tool results that record whether the call succeeded. */
  ok?: boolean;
  text: string;
  /** The text's full length, in characters (UTF-16 code units, as JavaScript counts). */
  chars: number;
  /** Where `text` starts in the event's text: only on a read of one event in pieces. */
  offset?: number;
  /** Characters after `text` left out (condensed, or `max_chars` reached): read them with
   * `event` and `offset`. */
  cut?: number;
}

/** Token counts summed over the session's model calls. */
export interface SessionTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

/** What a session is, as `read_session` heads its answer with. */
export interface SessionHeader {
  owner: string;
  archive_id: string;
  format: string;
  session_id: string;
  origin_agent?: string;
  harness?: string;
  project?: string;
  repo?: string;
  branch?: string;
  labels?: Labels;
  visibility: "org" | "owner";
  /** The earliest and latest event timestamps over the chain's traces. */
  started_at?: string;
  ended_at?: string;
  updated_at: string;
  /** The head the `seq`s are numbered under: pass it as `head` to refuse a changed session. */
  head: string;
  /** Traces in the current chain, and events across them. */
  traces: number;
  events: number;
  /** Models the chain's calls name, in the order first seen. */
  models: string[];
  llm_calls: number;
  tokens: SessionTokens;
}

export interface SessionEvents {
  session: SessionHeader;
  mode: SessionReadMode;
  /** The range read, `[from, to)`. */
  from: number;
  to: number;
  events: SessionEvent[];
  /** The `seq` to read on from (`from=`), when events follow the last one given; absent at the
   * session's end. */
  next?: number;
  /** For a read of one event in pieces: the `offset` to read on from; absent at its end. */
  next_offset?: number;
}
