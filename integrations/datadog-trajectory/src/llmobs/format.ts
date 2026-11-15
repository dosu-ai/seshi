/** The `datadog-llmobs` format (F5.3): Datadog LLM Observability spans, as the poller converts
 * them (`spans.ts`), read into span parts and assembled into a session.
 *
 * A Trajectory turn is its own trace (datadog-labs/trajectory, docs/LLM-OBS-SPAN-TAGS.md): a
 * turn root (`trajectory.semantic_type:turn`) whose input is the user's prompt, agent-message
 * spans (`agent_message`, one per model step) with the assistant's text, tool spans with the
 * call's input and result, and LLM spans: real calls Trajectory captured
 * (`trajectory.llm_call:true`) or, when there were none, one synthetic span carrying the turn's
 * token totals (`trajectory.placeholder_llm_span:true`). Several of these repeat each other: the
 * turn's output is its last message, an LLM span's input is the whole conversation so far, the
 * synthetic span repeats the turn. So a turn is written from one source each: the prompt from
 * the root, the assistant's words from the agent messages (the root's output only when there
 * are none), tool calls from the tool spans, and the token counts from one tier of LLM spans,
 * named by the assistant records in order. Each turn is its own thread, so a prompt that repeats
 * the previous turn's is still kept.
 *
 * Spans of any other LLM Observability app (no Trajectory tags) are read by their span kind:
 * LLM spans' messages, matched against the session's history as the OTLP assembler does, else
 * the trace root's input and output, plus tool spans whose call no message already holds. */

import {
  Attributes,
  argsOf,
  assembleSpanParts,
  isoFromNanos,
  jsonAttribute,
  messagesRecords,
  textOf,
} from "@seshi/formats";
import type {
  AssembledSpans,
  Claims,
  FormatAdapter,
  LlmCall,
  NormalizedRecord,
  NormalizedTranscript,
  ReceivedSpan,
  SpanAdapter,
  SpanPart,
  SpanResource,
  SpanTool,
  TokenUsage,
} from "@seshi/model";
import type { DatadogMessage, DatadogSpanResource } from "./api-types";
import { ATTR, sessionOf, tagsOf, tagValue, toReceivedSpan } from "./spans";

/** The format Datadog sessions are filed under; archive ids derive from it. */
export const DATADOG_LLMOBS = "datadog-llmobs";

/** What a part stands for (`SpanPart.operation`): Trajectory's semantic types, else Datadog's
 * span kind (`agent`, `workflow`, `task`, `embedding`, `retrieval`, and `llm` and `tool`). */
export const OPERATION = {
  turn: "turn",
  agentMessage: "agent_message",
  tool: "tool",
  llm: "llm",
  placeholder: "llm_placeholder",
  compaction: "compaction",
  permissionWait: "permission_wait",
} as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A span's Datadog fields, read back from its `datadog.*` attributes. */
interface DatadogView {
  span: ReceivedSpan;
  attrs: Attributes;
  tags: string[];
  kind?: string;
  operation: string;
  metadata: Json;
}

function viewOf(span: ReceivedSpan): DatadogView {
  const attrs = new Attributes(span.attributes);
  const tags = tagsOf(span);
  const kind = attrs.string(ATTR.spanKind)?.toLowerCase();
  const parsed = jsonAttribute(attrs.get(ATTR.metadata));
  return {
    span,
    attrs,
    tags,
    ...(kind ? { kind } : {}),
    operation: operationOf(tags, kind),
    metadata: isObject(parsed) ? parsed : {},
  };
}

function operationOf(tags: readonly string[], kind: string | undefined): string {
  if (tagValue(tags, "trajectory.placeholder_llm_span") === "true") return OPERATION.placeholder;
  const semantic = tagValue(tags, "trajectory.semantic_type");
  if (semantic === "turn") return OPERATION.turn;
  if (semantic === "agent_message") return OPERATION.agentMessage;
  if (semantic === "compaction") return OPERATION.compaction;
  if (semantic === "permission_wait") return OPERATION.permissionWait;
  if (tagValue(tags, "trajectory.llm_call") === "true") return OPERATION.llm;
  return kind ?? "span";
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

function messagesOf(view: DatadogView, key: string): DatadogMessage[] | undefined {
  const parsed = jsonAttribute(view.attrs.get(key));
  return Array.isArray(parsed) && parsed.length > 0 ? (parsed as DatadogMessage[]) : undefined;
}

/** Datadog messages in the shape the GenAI message reader takes: text and tool results as
 * content parts, tool calls as `tool_calls`, thinking as reasoning. */
function genAiMessages(messages: readonly DatadogMessage[], defaultRole: string): Json[] {
  return messages.filter(isObject).map((message) => {
    const role = (text(message.role) ?? defaultRole).toLowerCase();
    if (role === "reasoning" || role === "thinking") {
      return { role: "assistant", content: [{ type: "reasoning", text: message.content ?? "" }] };
    }
    const content: Json[] = [];
    if (text(message.content)) content.push({ type: "text", text: message.content });
    for (const result of Array.isArray(message.tool_results) ? message.tool_results : []) {
      if (!isObject(result)) continue;
      content.push({
        type: "tool_result",
        ...(text(result.tool_id) ? { tool_use_id: result.tool_id } : {}),
        content: typeof result.result === "string" ? result.result : textOf(result.result),
      });
    }
    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .filter((call) => isObject(call) && text(call.name))
      .map((call) => ({
        ...(text(call.tool_id) ? { id: call.tool_id } : {}),
        name: call.name,
        arguments: call.arguments ?? {},
      }));
    return { role, content, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  });
}

function ioRecords(
  view: DatadogView,
  side: "input" | "output",
  timestamp: string,
): NormalizedRecord[] {
  const isInput = side === "input";
  const messages = messagesOf(view, isInput ? ATTR.inputMessages : ATTR.outputMessages);
  const ctx = { timestamp, idPrefix: `${view.span.spanId}:${isInput ? "in" : "out"}` };
  if (messages)
    return messagesRecords(genAiMessages(messages, isInput ? "user" : "assistant"), ctx);
  const value = view.attrs.string(isInput ? ATTR.inputValue : ATTR.outputValue);
  if (!value || value.trim() === "") return [];
  return [{ role: isInput ? "user" : "assistant", content: value, timestamp }];
}

/** Whether the span carried any prompt, response or tool content. */
function hasContent(view: DatadogView): boolean {
  return [ATTR.inputValue, ATTR.inputMessages, ATTR.outputValue, ATTR.outputMessages].some((key) =>
    view.attrs.has(key),
  );
}

const metric = (view: DatadogView, name: string) => {
  const value = view.attrs.get(`${ATTR.metricPrefix}${name}`);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
};

/** Token counts from Datadog's metrics (`input_tokens`, `cache_write_input_tokens`, …). */
function usageOf(view: DatadogView): TokenUsage | undefined {
  const usage: TokenUsage = {};
  const set = (key: keyof TokenUsage, ...names: string[]) => {
    for (const name of names) {
      const value = metric(view, name);
      if (value !== undefined) {
        usage[key] = value;
        return;
      }
    }
  };
  set("input_tokens", "input_tokens", "prompt_tokens");
  set("output_tokens", "output_tokens", "completion_tokens");
  set("cache_read_input_tokens", "cache_read_input_tokens");
  set("cache_creation_input_tokens", "cache_write_input_tokens", "cache_creation_input_tokens");
  set("reasoning_tokens", "reasoning_output_tokens", "reasoning_tokens");
  set("total_tokens", "total_tokens");
  return Object.keys(usage).length > 0 ? usage : undefined;
}

const PARAMETERS = ["temperature", "max_tokens", "top_p", "top_k", "reasoning_effort"] as const;

/** The error a failed span names: `error.type` and `error.message` in its metadata (flat or
 * nested), else just `error`. */
function errorOf(view: DatadogView): string | undefined {
  if (view.span.status?.code !== 2) return undefined;
  const nested = isObject(view.metadata.error) ? view.metadata.error : {};
  const type = text(view.metadata["error.type"]) ?? text(nested.type);
  const message =
    text(view.metadata["error.message"]) ?? text(nested.message) ?? text(view.metadata.error);
  if (type && message) return `${type}: ${message}`;
  return type ?? message ?? "error";
}

function llmCallOf(view: DatadogView, started: string, ended: string | undefined) {
  const usage = usageOf(view);
  const llmish =
    view.kind === "llm" ||
    view.operation === OPERATION.llm ||
    view.operation === OPERATION.placeholder;
  if (!usage && !llmish) return undefined;
  const call: LlmCall = { id: view.span.spanId, started_at: started };
  const model = view.attrs.string(ATTR.modelName);
  if (model) call.model = model;
  const provider = view.attrs.string(ATTR.modelProvider);
  if (provider) call.provider = provider;
  if (ended) {
    call.ended_at = ended;
    call.duration_ms = Math.max(0, Date.parse(ended) - Date.parse(started));
  }
  if (usage) call.usage = usage;
  const stop = text(view.metadata.finish_reason) ?? text(view.metadata.stop_reason);
  if (stop) call.stop_reason = stop;
  const request = text(view.metadata.request_id) ?? text(view.metadata.response_id);
  if (request) call.request_id = request;
  const parameters: NonNullable<LlmCall["parameters"]> = {};
  for (const key of PARAMETERS) {
    const value = view.metadata[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parameters[key] = value;
    }
  }
  if (Object.keys(parameters).length > 0) call.parameters = parameters;
  const error = errorOf(view);
  if (error) call.error = error;
  return call;
}

const TOOL_ID_KEYS = ["tool_call_id", "tool_use_id", "tool_id", "call_id"] as const;

function toolOf(view: DatadogView): SpanTool {
  const name = text(view.metadata.tool_name) ?? view.span.name;
  const tool: SpanTool = { name };
  for (const key of TOOL_ID_KEYS) {
    const id = text(view.metadata[key]);
    if (id) {
      tool.call_id = id;
      break;
    }
  }
  const input =
    view.attrs.string(ATTR.inputValue) ??
    messagesOf(view, ATTR.inputMessages)
      ?.map((m) => m.content ?? "")
      .join("\n");
  if (input !== undefined && input !== "") tool.args = argsOf(jsonAttribute(input));
  const output =
    view.attrs.string(ATTR.outputValue) ??
    messagesOf(view, ATTR.outputMessages)
      ?.map((m) => m.content ?? "")
      .join("\n");
  if (output !== undefined && output !== "") tool.result = output;
  if (view.span.status?.code === 2) tool.ok = false;
  return tool;
}

/** An absolute path, POSIX, home-relative or Windows: what a working folder looks like (a
 * Trajectory `project_dir` tag holds only the last segment, which is not one). */
const ABSOLUTE = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/;

function metaOf(view: DatadogView): SpanPart["meta"] {
  const meta: NonNullable<SpanPart["meta"]> = {};
  const model = view.attrs.string(ATTR.modelName) ?? tagValue(view.tags, "gen_ai.request.model");
  if (model) meta.model = model;
  const version = tagValue(view.tags, "trajectory.client_version");
  if (version) meta.agent_version = version;
  const cwd = text(view.metadata.cwd) ?? text(view.metadata.project_dir);
  if (cwd && ABSOLUTE.test(cwd)) meta.cwd = cwd;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** One converted Datadog span → its part of the session. Throws for a span without a start. */
export function datadogPart(span: ReceivedSpan): SpanPart {
  const view = viewOf(span);
  const started = isoFromNanos(span.startTimeUnixNano);
  if (!started) throw new Error(`span ${span.spanId} has no start time`);
  const ended = isoFromNanos(span.endTimeUnixNano);
  const part: SpanPart = {
    trace_id: span.traceId,
    span_id: span.spanId,
    name: span.name,
    started_at: started,
    start_unix_nano: String(span.startTimeUnixNano),
    status: span.status?.code === 2 ? "error" : span.status?.code === 1 ? "ok" : "unset",
    operation: view.operation,
    content: hasContent(view),
  };
  if (span.parentSpanId) part.parent_span_id = span.parentSpanId;
  if (span.kind !== undefined) part.kind = span.kind;
  if (ended) {
    part.ended_at = ended;
    part.end_unix_nano = String(span.endTimeUnixNano);
  }
  if (view.operation === OPERATION.tool) {
    part.tool = toolOf(view);
  } else if (view.operation === OPERATION.compaction) {
    const said = ioRecords(view, "output", ended ?? started)
      .map((r) => ("content" in r && typeof r.content === "string" ? r.content : ""))
      .filter((t) => t !== "")
      .join("\n");
    if (said !== "")
      part.output = [{ role: "observation", content: said, timestamp: ended ?? started }];
  } else if (view.operation !== OPERATION.permissionWait) {
    const input = ioRecords(view, "input", started);
    if (input.length > 0) part.input = input;
    const output = ioRecords(view, "output", ended ?? started);
    if (output.length > 0) part.output = output;
  }
  const call = llmCallOf(view, started, ended);
  if (call) part.llm_call = call;
  const meta = metaOf(view);
  if (meta) part.meta = meta;
  return part;
}

// --- assembly -------------------------------------------------------------------------------

const startNs = (p: SpanPart) => BigInt(p.start_unix_nano ?? Date.parse(p.started_at) * 1e6);
const byStart = (a: SpanPart, b: SpanPart) => {
  const d = startNs(a) - startNs(b);
  return d < 0n ? -1 : d > 0n ? 1 : a.span_id < b.span_id ? -1 : a.span_id > b.span_id ? 1 : 0;
};

/** The part with only what the turn writes from it. */
function keep(part: SpanPart, what: Partial<Pick<SpanPart, "input" | "output" | "tool">>) {
  const { input: _i, output: _o, tool: _t, llm_call: _c, thread: _th, ...rest } = part;
  const out: SpanPart = { ...rest };
  if (what.input && what.input.length > 0) out.input = what.input;
  if (what.output && what.output.length > 0) out.output = what.output;
  if (what.tool) out.tool = what.tool;
  return out;
}

const spoke = (records: readonly NormalizedRecord[] | undefined) =>
  (records ?? []).some((r) => r.role === "assistant" || r.role === "reasoning");

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a && !b) return undefined;
  const out: TokenUsage = { ...a };
  for (const [key, value] of Object.entries(b ?? {}) as [keyof TokenUsage, number][]) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

/** Several model requests counted as one: the first's id and model, summed usage, the earliest
 * start and the latest end. */
export function mergeCalls(calls: readonly LlmCall[]): LlmCall {
  const [first, ...rest] = calls as [LlmCall, ...LlmCall[]];
  let merged: LlmCall = { ...first };
  for (const call of rest) {
    const usage = addUsage(merged.usage, call.usage);
    merged = {
      ...merged,
      ...(usage ? { usage } : {}),
      ...(!merged.model && call.model ? { model: call.model } : {}),
      ...(!merged.provider && call.provider ? { provider: call.provider } : {}),
      ...(call.started_at && (!merged.started_at || call.started_at < merged.started_at)
        ? { started_at: call.started_at }
        : {}),
      ...(call.ended_at && (!merged.ended_at || call.ended_at > merged.ended_at)
        ? { ended_at: call.ended_at }
        : {}),
      ...(call.stop_reason ? { stop_reason: call.stop_reason } : {}),
      ...(!merged.error && call.error ? { error: call.error } : {}),
    };
  }
  if (rest.length > 0 && merged.started_at && merged.ended_at) {
    merged.duration_ms = Math.max(0, Date.parse(merged.ended_at) - Date.parse(merged.started_at));
  }
  return merged;
}

/** The parts of one Trajectory turn trace, each with only what the turn writes from it, and
 * the turn's model requests named by its assistant records. */
function turnParts(trace: readonly SpanPart[]): SpanPart[] {
  const parts = [...trace].sort(byStart);
  const thread = parts[0]?.trace_id ?? "";
  const tools = parts.some((p) => p.operation === OPERATION.tool && p.tool);
  // With tool spans present they are where calls and results come from; a message's own copy of
  // them would repeat them.
  const messageOutput = (p: SpanPart): NormalizedRecord[] =>
    (p.output ?? []).flatMap((r): NormalizedRecord[] => {
      if (!tools) return [r];
      if (r.role === "tool") return [];
      if (r.role === "assistant" && "tool_calls" in r && r.tool_calls) {
        const call = r as { content?: unknown; timestamp?: string };
        return typeof call.content === "string" && call.content !== ""
          ? [
              {
                role: "assistant",
                content: call.content,
                timestamp: call.timestamp,
              } as NormalizedRecord,
            ]
          : [];
      }
      return [r];
    });
  const messages = parts.filter(
    (p) => p.operation === OPERATION.agentMessage && spoke(messageOutput(p)),
  );

  const kept = new Map<SpanPart, SpanPart>();
  for (const p of parts) {
    let out: SpanPart;
    switch (p.operation) {
      case OPERATION.turn:
        out = keep(p, { input: p.input, ...(messages.length === 0 ? { output: p.output } : {}) });
        break;
      case OPERATION.agentMessage:
        out = keep(p, { output: messageOutput(p) });
        break;
      case OPERATION.tool:
        out = keep(p, p.tool ? { tool: p.tool } : {});
        break;
      case OPERATION.compaction:
        out = keep(p, { output: p.output });
        break;
      default:
        out = keep(p, {});
    }
    out.thread = thread;
    kept.set(p, out);
  }

  // No prompt on the root: the user's words that end the first captured request's input.
  const prompted = [...kept.values()].some((p) => (p.input ?? []).some((r) => r.role === "user"));
  if (!prompted) {
    const first = parts.find(
      (p) =>
        (p.operation === OPERATION.llm || p.operation === OPERATION.placeholder) &&
        (p.input ?? []).length > 0,
    );
    if (first?.input) {
      const input = first.input;
      let from = input.length;
      while (from > 0 && input[from - 1]?.role === "user") from--;
      const prompt = input.slice(from);
      const target = kept.get(first);
      if (target && prompt.length > 0) target.input = prompt;
    }
  }

  // The turn's model requests, from one tier only, so no tokens are counted twice: the real
  // calls Trajectory captured, else the agent messages' own counts, else the synthetic carrier
  // of the turn's totals, else the root's, else any other.
  const tiers: ((p: SpanPart) => boolean)[] = [
    (p) => p.operation === OPERATION.llm,
    (p) => p.operation === OPERATION.agentMessage,
    (p) => p.operation === OPERATION.placeholder,
    (p) => p.operation === OPERATION.turn,
    () => true,
  ];
  // A tier that counts tokens wins over one that only names a model.
  let calls: { part: SpanPart; call: LlmCall }[] = [];
  let totals = false;
  for (const counted of [true, false]) {
    for (const [i, tier] of tiers.entries()) {
      const found = parts
        .filter((p) => p.llm_call && tier(p) && (!counted || p.llm_call.usage))
        .map((p) => ({ part: p, call: p.llm_call as LlmCall }));
      if (found.length > 0) {
        calls = found;
        // The synthetic carrier and the root hold the whole turn's totals.
        totals = i === 2 || i === 3;
        break;
      }
    }
    if (calls.length > 0) break;
  }
  // Named by the records that speak: the agent messages, else the root's output.
  const carriers = [...kept.entries()]
    .filter(([, k]) => spoke(k.output))
    .map(([original]) => original);
  if (carriers.length > 0 && calls.length > 0 && totals) {
    // The turn's totals are named by its last words.
    const target = kept.get(carriers[carriers.length - 1] as SpanPart);
    if (target) target.llm_call = mergeCalls(calls.map((c) => c.call));
  } else if (carriers.length > 0 && calls.length > 0) {
    const byId = new Map(parts.map((p) => [p.span_id, p]));
    /** The carrier a call sits under (an agent message that made the request), if any. */
    const above = (part: SpanPart): SpanPart | undefined => {
      const seen = new Set<string>();
      for (let id = part.parent_span_id; id && !seen.has(id); ) {
        seen.add(id);
        const parent = byId.get(id);
        if (!parent) return undefined;
        if (carriers.includes(parent)) return parent;
        id = parent.parent_span_id;
      }
      return undefined;
    };
    const assigned = new Map<SpanPart, LlmCall[]>();
    const rest: LlmCall[] = [];
    for (const { part, call } of calls) {
      const home = carriers.includes(part) ? part : above(part);
      if (home) assigned.set(home, [...(assigned.get(home) ?? []), call]);
      else rest.push(call);
    }
    const free = carriers.filter((c) => !assigned.has(c));
    rest.forEach((call, i) => {
      const carrier = free[i] ?? (carriers[carriers.length - 1] as SpanPart);
      assigned.set(carrier, [...(assigned.get(carrier) ?? []), call]);
    });
    for (const [carrier, list] of assigned) {
      const target = kept.get(carrier);
      if (target) target.llm_call = mergeCalls(list);
    }
  }
  return [...kept.values()];
}

/** The parts of a trace from any other LLM Observability app (see the module comment). */
function genericParts(trace: readonly SpanPart[]): SpanPart[] {
  const parts = [...trace].sort(byStart);
  const llm = (p: SpanPart) =>
    p.operation === OPERATION.llm || p.operation === OPERATION.placeholder;
  const talking = parts.filter((p) => llm(p) && (p.input || p.output));
  if (talking.length > 0) {
    const held = new Set<string>();
    for (const p of talking) {
      for (const r of [...(p.input ?? []), ...(p.output ?? [])]) {
        if (r.role === "assistant" && "tool_calls" in r) {
          for (const call of r.tool_calls ?? []) held.add(call.id);
        }
      }
    }
    return parts.map((p) => {
      if (llm(p)) {
        const out = keep(p, { input: p.input, output: p.output });
        if (p.llm_call) out.llm_call = p.llm_call;
        return out;
      }
      // A tool span adds its call only when no message names any call (its duration still
      // reaches a matching result).
      if (p.tool && (held.size === 0 || (p.tool.call_id && held.has(p.tool.call_id)))) {
        return keep(p, { tool: p.tool });
      }
      return keep(p, {});
    });
  }
  const ids = new Set(parts.map((p) => p.span_id));
  const root = parts.find((p) => !p.parent_span_id || !ids.has(p.parent_span_id));
  const calls = parts.some((p) => llm(p) && p.llm_call);
  return parts.map((p) => {
    const out =
      p === root
        ? keep(p, { input: p.input, output: p.output })
        : keep(p, p.tool ? { tool: p.tool } : {});
    if (p.llm_call && (llm(p) || (p === root && !calls))) out.llm_call = p.llm_call;
    return out;
  });
}

/** A session's parts → its records and LLM calls: each trace read as a Trajectory turn when it
 * has a turn root or agent messages, else by span kind; then the OTLP assembler orders and
 * joins them. */
export function assembleDatadogParts(
  input: readonly SpanPart[],
  session: { source: string },
): AssembledSpans {
  const bySpan = new Map<string, SpanPart>();
  for (const part of input) bySpan.set(`${part.trace_id}-${part.span_id}`, part);
  const traces = new Map<string, SpanPart[]>();
  for (const part of bySpan.values()) {
    const list = traces.get(part.trace_id) ?? [];
    list.push(part);
    traces.set(part.trace_id, list);
  }
  const parts: SpanPart[] = [];
  for (const trace of traces.values()) {
    const turn = trace.some(
      (p) => p.operation === OPERATION.turn || p.operation === OPERATION.agentMessage,
    );
    parts.push(...(turn ? turnParts(trace) : genericParts(trace)));
  }
  return assembleSpanParts(parts, session);
}

const MAX_CLAIM = 320;
const bounded = (v: string | undefined) =>
  v !== undefined && v.trim() !== "" && v.length <= MAX_CLAIM ? v.trim() : undefined;

/** Identity a span's tags assert (X5.5), recorded and never trusted (F5.4): Trajectory's
 * resolved user and email, the git email, the GitHub username. */
export function datadogClaims(span: ReceivedSpan): Claims | undefined {
  const tags = tagsOf(span);
  const claims: Claims = {};
  const email = bounded(tagValue(tags, "trajectory.user_email"));
  if (email) claims.email = email;
  const git = bounded(tagValue(tags, "git.email"));
  if (git) claims.git_email = git;
  const user = bounded(tagValue(tags, "trajectory.user"));
  if (user) claims.username = user;
  const github = tagValue(tags, "github.username");
  if (github && github.length <= 256) claims.account_ids = { github };
  return Object.keys(claims).length > 0 ? claims : undefined;
}

/** The span adapter of `datadog-llmobs`. */
export const DATADOG_SPANS: SpanAdapter = {
  sessionKey: (span: ReceivedSpan, _resource: SpanResource) => sessionOf(span) ?? span.traceId,
  hasContent: (span) => hasContent(viewOf(span)),
  claims: (span) => datadogClaims(span),
  normalize: (span) => datadogPart(span),
  assemble: (parts, session) => assembleDatadogParts(parts, session),
};

/** Spans of a saved Export API answer (`{ data: [...] }`, or the list itself). */
export function spansOfDocument(value: unknown): ReceivedSpan[] {
  const list = Array.isArray(value) ? value : isObject(value) ? value.data : undefined;
  if (!Array.isArray(list)) {
    throw Object.assign(new Error("a Datadog LLM Observability export has a data list"), {
      code: "invalid_input",
    });
  }
  const spans: ReceivedSpan[] = [];
  for (const item of list as DatadogSpanResource[]) {
    if (!isObject(item) || !isObject(item.attributes)) continue;
    try {
      spans.push(toReceivedSpan(item.attributes));
    } catch {
      // A span without ids or a start cannot be placed; the rest still reads.
    }
  }
  return spans;
}

/** The `datadog-llmobs` format adapter: span sets from the poller, and a saved Export API answer
 * read whole as one session (`seshi normalize`). */
export const DATADOG_LLMOBS_FORMAT: FormatAdapter = {
  source: DATADOG_LLMOBS,
  chunkable: false,
  // `{ "data": [...], "meta": {...} }`, an Export API answer.
  detect: {
    document: (head) => head.get("data")?.kind === "array" && head.get("meta")?.kind === "object",
  },
  spans: DATADOG_SPANS,
  normalize(transcript: string): NormalizedTranscript {
    let value: unknown;
    try {
      value = JSON.parse(transcript);
    } catch {
      throw Object.assign(
        new Error("a Datadog LLM Observability export must be one JSON document"),
        {
          code: "invalid_json",
        },
      );
    }
    // A log is one session: the spans of the one session the export names (spans that name
    // none, such as oversight traces, are left out), or every span when none names one.
    const spans = spansOfDocument(value);
    const sessions = new Set(spans.map(sessionOf).filter((s) => s !== undefined));
    if (sessions.size > 1) {
      throw Object.assign(
        new Error(
          `the export holds ${sessions.size} sessions; a log must hold one (filter the export by session)`,
        ),
        { code: "invalid_input" },
      );
    }
    const parts: SpanPart[] = [];
    for (const span of sessions.size === 1 ? spans.filter((s) => sessionOf(s)) : spans) {
      try {
        parts.push(datadogPart(span));
      } catch {
        // As above.
      }
    }
    // The LLM calls the span path keeps, kept here too.
    const { records, llm_calls } = assembleDatadogParts(parts, { source: DATADOG_LLMOBS });
    return llm_calls.length > 0 ? { records, llm_calls } : { records };
  },
};
