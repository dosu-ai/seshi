import { createHash } from "node:crypto";
import { canonicalText, stripNul } from "./canonical";
import type { Provenance } from "./schemas/store";
import {
  type Continuation,
  type LlmCall,
  TRACE_SCHEMA,
  type Trace,
  type TraceEvent,
  type TraceMetadata,
  type TraceMetaRecord,
  type TraceRecord,
} from "./schemas/trace";
import { TrajectoryError, validateTraceRecords } from "./schemas/trajectory";

function contentHash(
  source: string,
  events: readonly TraceEvent[],
  continuation?: Continuation,
): string {
  const body = events.map((e) => `${e.role}\x1f${e.text}`).join("\x1e");
  const head = continuation ? `${source}@${continuation.from_record}` : source;
  return createHash("sha256").update(`${head}\n${body}`, "utf8").digest("hex");
}

function epochOf(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export interface ParseOptions {
  /** The format the session is filed under; defaults to the meta record's `source`. */
  format?: string;
  session_id?: string;
  /** Merged over the meta record's `cwd` / `git_branch` / `model` / `agent_version`. */
  metadata?: TraceMetadata;
  /** What the uploader knows of the harness's version and the model, for a log that names
   * neither: used only where the meta record has none. */
  hints?: { agent_version?: string; model?: string };
  project?: string;
  branch?: string;
  /** The LLM calls the records' `llm_call` fields name. */
  llm_calls?: readonly LlmCall[];
  /** Where the data came from. */
  provenance?: Provenance;
}

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_tokens",
  "total_tokens",
] as const;

const CALL_STRINGS = [
  "model",
  "provider",
  "started_at",
  "ended_at",
  "stop_reason",
  "request_id",
  "error",
] as const;

function checkLlmCall(value: unknown, index: number): LlmCall {
  const bad = (what: string): never => {
    throw new TrajectoryError(`llm call ${index}: ${what}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("must be an object");
  const call = value as Record<string, unknown>;
  if (typeof call.id !== "string" || call.id === "") bad("needs an id");
  const out: LlmCall = { id: call.id as string };
  for (const key of CALL_STRINGS) {
    const field = call[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== "string") bad(`${key} must be a string`);
    out[key] = field as string;
  }
  if (call.duration_ms !== undefined && call.duration_ms !== null) {
    const ms = call.duration_ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      bad("duration_ms must be a number ≥ 0");
    }
    out.duration_ms = ms as number;
  }
  if (call.usage !== undefined && call.usage !== null) {
    if (typeof call.usage !== "object" || Array.isArray(call.usage)) bad("usage must be an object");
    const usage = call.usage as Record<string, unknown>;
    for (const key of Object.keys(usage)) {
      if (!(USAGE_KEYS as readonly string[]).includes(key))
        bad(`usage.${key} is not a token count`);
    }
    const counts: NonNullable<LlmCall["usage"]> = {};
    for (const key of USAGE_KEYS) {
      const n = usage[key];
      if (n === undefined || n === null) continue;
      if (!Number.isInteger(n) || (n as number) < 0) {
        bad(`usage.${key} must be a whole number ≥ 0`);
      }
      counts[key] = n as number;
    }
    out.usage = counts;
  }
  if (call.parameters !== undefined && call.parameters !== null) {
    const params = call.parameters;
    if (typeof params !== "object" || Array.isArray(params)) bad("parameters must be an object");
    const kept: NonNullable<LlmCall["parameters"]> = {};
    for (const [key, v] of Object.entries(params as Record<string, unknown>)) {
      if (v !== null && !["string", "number", "boolean"].includes(typeof v)) {
        bad(`parameters.${key} must be a string, number, boolean or null`);
      }
      kept[key] = v as string | number | boolean | null;
    }
    out.parameters = kept;
  }
  return out;
}

function checkLlmCalls(input: readonly unknown[], records: readonly TraceRecord[]): LlmCall[] {
  const calls = input.map(checkLlmCall);
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new TrajectoryError(`llm call ${call.id} appears twice`);
    ids.add(call.id);
  }
  records.forEach((record, index) => {
    const ref = "llm_call" in record ? record.llm_call : undefined;
    if (ref !== undefined && !ids.has(ref)) {
      throw new TrajectoryError(`record ${index}: llm_call ${ref} is not in llm_calls`);
    }
  });
  return calls;
}

function eventsOf(records: readonly TraceRecord[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  const toolNames = new Map<string, string>();
  for (const record of records.slice(1)) {
    if (record.role === "meta") {
      throw new TrajectoryError("only the first record may be a meta record");
    }
    const timestamp = epochOf(record.timestamp) === null ? null : record.timestamp;
    const index = events.length;
    switch (record.role) {
      case "user":
      case "system":
      case "observation":
      case "reasoning":
        events.push({ index, role: record.role, text: canonicalText(record.content), timestamp });
        break;
      case "assistant": {
        const calls = "tool_calls" in record ? record.tool_calls : undefined;
        if (calls && calls.length > 0) {
          for (const call of calls) {
            toolNames.set(call.id, call.name);
            events.push({
              index: events.length,
              role: "tool_call",
              text: canonicalText(`${call.name} ${call.args}`),
              timestamp,
              tool_name: call.name,
              tool_call_id: call.id,
            });
          }
        } else if (record.content) {
          events.push({ index, role: "assistant", text: canonicalText(record.content), timestamp });
        }
        break;
      }
      case "tool": {
        const event: TraceEvent = {
          index,
          role: "tool_result",
          text: canonicalText(record.content),
          timestamp,
          tool_call_id: record.tool_call_id,
        };
        const name = toolNames.get(record.tool_call_id);
        if (name !== undefined) event.tool_name = name;
        if (record.ok !== undefined) event.ok = record.ok;
        events.push(event);
        break;
      }
    }
  }
  return events;
}

function conversationError(source: string, events: readonly TraceEvent[]): string | null {
  const roles = new Set(events.map((e) => e.role));
  if (!roles.has("user")) return "trajectory has no user records";
  if (!source.startsWith("chat:") && !roles.has("assistant") && !roles.has("tool_call")) {
    return "trajectory has no assistant records";
  }
  return null;
}

/** Validate, strip NUL, derive events, hash. Throws `TrajectoryError` for anything that is not
 * a trace. */
export function parseTrace(input: unknown, options: ParseOptions = {}): Trace {
  const records = validateTraceRecords(stripNul(input));
  const first = records[0];
  if (first?.role !== "meta") {
    throw new TrajectoryError("first record must be the meta record");
  }
  const meta: TraceMetaRecord = first;
  const given = options.llm_calls === undefined ? [] : stripNul(options.llm_calls);
  if (!Array.isArray(given)) throw new TrajectoryError("llm_calls must be an array");
  const llmCalls = checkLlmCalls(given, records);
  const events = eventsOf(records);
  const continuation = options.metadata?.continuation;
  const problem = continuation ? null : conversationError(meta.source, events);
  if (problem) throw new TrajectoryError(problem);

  const stamps = events
    .map((e) => (e.timestamp === null ? null : epochOf(e.timestamp)))
    .filter((ms): ms is number => ms !== null);
  const at = (ms: number) =>
    events.find((e) => e.timestamp !== null && epochOf(e.timestamp) === ms);
  const started = stamps.length ? at(Math.min(...stamps)) : undefined;
  const ended = stamps.length ? at(Math.max(...stamps)) : undefined;

  const metadata: TraceMetadata = {};
  if (meta.cwd !== undefined) metadata.cwd = meta.cwd;
  if (meta.git_branch !== undefined) metadata.git_branch = meta.git_branch;
  if (meta.model !== undefined) metadata.model = meta.model;
  if (meta.agent_version !== undefined) metadata.agent_version = meta.agent_version;
  const hints = options.hints ?? {};
  if (metadata.model === undefined && hints.model) metadata.model = hints.model;
  if (metadata.agent_version === undefined && hints.agent_version) {
    metadata.agent_version = hints.agent_version;
  }
  Object.assign(metadata, options.metadata ?? {});

  const trace: Trace = {
    schema: TRACE_SCHEMA,
    content_hash: contentHash(meta.source, events, continuation),
    source: meta.source,
    format: options.format ?? meta.source,
    session_id: options.session_id ?? null,
    started_at: started?.timestamp ?? null,
    ended_at: ended?.timestamp ?? null,
    records,
    events,
    metadata,
  };
  if (options.project !== undefined) trace.project = options.project;
  if (options.branch !== undefined) trace.branch = options.branch;
  if (llmCalls.length > 0) trace.llm_calls = llmCalls;
  if (options.provenance !== undefined) trace.provenance = options.provenance;
  return trace;
}
