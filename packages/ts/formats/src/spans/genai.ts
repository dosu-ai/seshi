/** One OTLP span → its part of a session, by the OpenTelemetry GenAI semantic conventions
 * (`gen_ai.*`, F4.6). Which conversation thread it belongs to, what went in and came out (as
 * records), the tool call an `execute_tool` span ran, and the model request a `chat` span stands
 * for (model, token usage, stop reason, request parameters, error).
 *
 * A vendor's own attributes (`anthropic.*`) refine this through a `SpanAttributeMapper`: the
 * Claude Platform integration supplies one. */

import type {
  Claims,
  LlmCall,
  NormalizedRecord,
  ReceivedSpan,
  SpanPart,
  SpanResource,
  SpanTool,
  TokenUsage,
} from "@seshi/model";
import { Attributes, durationMs, isoFromNanos } from "./attributes";
import {
  argsOf,
  flattenedMessages,
  jsonAttribute,
  messagesRecords,
  systemRecords,
  textOf,
} from "./messages";

/** A span as a mapper sees it: the span, its attributes, its resource's. */
export interface SpanView {
  span: ReceivedSpan;
  attributes: Attributes;
  resource: Attributes;
}

/** A vendor's refinements of the GenAI reading. Every hook is optional. */
export interface SpanAttributeMapper {
  /** The vendor (`anthropic`), for error messages. */
  readonly name: string;
  /** The session key, ahead of `gen_ai.conversation.id` and the trace id (F4.3). */
  sessionKey?(view: SpanView): string | undefined;
  /** Whether the span carries content in attributes the conventions do not name. */
  hasContent?(view: SpanView): boolean;
  claims?(view: SpanView): Claims | undefined;
  /** The part the conventions made, refined: a tool result in a vendor attribute, a stop
   * reason, a final span. Returns the part to keep. */
  refine?(part: SpanPart, view: SpanView): SpanPart;
}

/** The content attributes of the conventions (F4.5): a span with none of them, in its
 * attributes or its events, has no prompt or response. */
const CONTENT_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.prompt",
  "gen_ai.completion",
] as const;

const FLATTENED_PREFIXES = ["gen_ai.prompt.", "gen_ai.completion."] as const;

/** Operations that are one request to a model. */
const MODEL_OPERATIONS = new Set(["chat", "text_completion", "generate_content", "completion"]);

/** Request parameters a call records (`LlmCall.parameters`), by attribute. */
const PARAMETERS: readonly [string, string][] = [
  ["gen_ai.request.max_tokens", "max_tokens"],
  ["gen_ai.request.temperature", "temperature"],
  ["gen_ai.request.top_p", "top_p"],
  ["gen_ai.request.top_k", "top_k"],
  ["gen_ai.request.frequency_penalty", "frequency_penalty"],
  ["gen_ai.request.presence_penalty", "presence_penalty"],
  ["gen_ai.request.seed", "seed"],
  ["gen_ai.request.choice.count", "choice_count"],
  ["gen_ai.request.stream", "stream"],
  ["gen_ai.request.reasoning.level", "reasoning_level"],
  ["gen_ai.output.type", "output_type"],
];

function attributesWith(view: SpanView, key: string): boolean {
  if (view.attributes.has(key)) return true;
  return (view.span.events ?? []).some((event) => new Attributes(event.attributes).has(key));
}

/** A content attribute's value: on the span, else on one of its events (the conventions' event
 * form, `gen_ai.client.inference.operation.details`). */
function contentValue(view: SpanView, key: string) {
  if (view.attributes.has(key)) return view.attributes.get(key);
  for (const event of view.span.events ?? []) {
    const attrs = new Attributes(event.attributes);
    if (attrs.has(key)) return attrs.get(key);
  }
  return undefined;
}

/** Whether a span carries prompt or response content by the conventions (F4.5). */
export function genAiHasContent(view: SpanView): boolean {
  if (CONTENT_KEYS.some((key) => attributesWith(view, key))) return true;
  return FLATTENED_PREFIXES.some((prefix) =>
    view.attributes.keysWith(prefix).some((key) => key.endsWith(".content")),
  );
}

/** The span's operation: `gen_ai.operation.name`, else the first word of its name when the
 * conventions name spans `<operation> <target>`. */
function operationOf(view: SpanView): string | undefined {
  const named = view.attributes.string("gen_ai.operation.name");
  if (named) return named;
  const word = view.span.name.split(" ")[0];
  return word &&
    ["chat", "execute_tool", "invoke_agent", "create_agent", "embeddings"].includes(word)
    ? word
    : undefined;
}

function statusOf(span: ReceivedSpan): SpanPart["status"] {
  const code = span.status?.code;
  return code === 1 ? "ok" : code === 2 ? "error" : "unset";
}

/** The error a failed span reports: `error.type`, and the status message. */
export function errorOf(view: SpanView): string | undefined {
  const type = view.attributes.string("error.type");
  const message = view.span.status?.code === 2 ? view.span.status.message : undefined;
  if (type && message) return `${type}: ${message}`;
  return type ?? (message || (view.span.status?.code === 2 ? "error" : undefined));
}

function usageOf(attrs: Attributes): TokenUsage | undefined {
  const usage: TokenUsage = {};
  const set = (key: keyof TokenUsage, value: number | undefined) => {
    if (value !== undefined) usage[key] = value;
  };
  set("input_tokens", attrs.count("gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"));
  set("output_tokens", attrs.count("gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"));
  set(
    "cache_read_input_tokens",
    attrs.count("gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens"),
  );
  set(
    "cache_creation_input_tokens",
    attrs.count(
      "gen_ai.usage.cache_write.input_tokens",
      "gen_ai.usage.cache_creation.input_tokens",
      "gen_ai.usage.cache_creation_input_tokens",
    ),
  );
  set("reasoning_tokens", attrs.count("gen_ai.usage.reasoning.output_tokens"));
  set("total_tokens", attrs.count("gen_ai.usage.total_tokens", "llm.usage.total_tokens"));
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parametersOf(attrs: Attributes): LlmCall["parameters"] {
  const out: NonNullable<LlmCall["parameters"]> = {};
  for (const [key, name] of PARAMETERS) {
    const value = attrs.get(key);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[name] = value;
    }
  }
  const stops = attrs.get("gen_ai.request.stop_sequences");
  if (Array.isArray(stops) && stops.length > 0) out.stop_sequences = JSON.stringify(stops);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The model request a span stands for, when it is one: a model operation, or any span that
 * reports token usage. */
function llmCallOf(view: SpanView, operation: string | undefined): LlmCall | undefined {
  const { attributes: attrs, span } = view;
  const usage = usageOf(attrs);
  if (!usage && !(operation && MODEL_OPERATIONS.has(operation))) return undefined;
  const call: LlmCall = { id: span.spanId };
  const model = attrs.first("gen_ai.response.model", "gen_ai.request.model");
  if (model) call.model = model;
  const provider = attrs.first("gen_ai.provider.name", "gen_ai.system");
  if (provider) call.provider = provider;
  const started = isoFromNanos(span.startTimeUnixNano);
  const ended = isoFromNanos(span.endTimeUnixNano);
  if (started) call.started_at = started;
  if (ended) call.ended_at = ended;
  const ms = durationMs(span.startTimeUnixNano, span.endTimeUnixNano);
  if (ms !== undefined) call.duration_ms = ms;
  if (usage) call.usage = usage;
  const finish = attrs.strings("gen_ai.response.finish_reasons")[0];
  if (finish) call.stop_reason = finish;
  const request = attrs.first("gen_ai.response.id");
  if (request) call.request_id = request;
  const parameters = parametersOf(attrs);
  if (parameters) call.parameters = parameters;
  const error = errorOf(view);
  if (error) call.error = error;
  return call;
}

/** The tool call an `execute_tool` span ran. */
function toolOf(view: SpanView, operation: string | undefined): SpanTool | undefined {
  const { attributes: attrs, span } = view;
  if (operation !== "execute_tool") return undefined;
  const name = attrs.string("gen_ai.tool.name") ?? span.name.replace(/^execute_tool\s*/, "");
  if (!name) return undefined;
  const tool: SpanTool = { name };
  const id = attrs.string("gen_ai.tool.call.id");
  if (id) tool.call_id = id;
  const args = contentValue(view, "gen_ai.tool.call.arguments");
  if (args !== undefined && args !== null) tool.args = argsOf(jsonAttribute(args));
  const result = contentValue(view, "gen_ai.tool.call.result");
  if (result !== undefined && result !== null) tool.result = textOf(jsonAttribute(result));
  if (span.status?.code === 2 || attrs.has("error.type")) tool.ok = false;
  return tool;
}

/** The records of the span's input: system instructions, then input messages (or the
 * flattened `gen_ai.prompt.<i>.*`). */
function inputOf(view: SpanView, timestamp: string): NormalizedRecord[] {
  const idPrefix = view.span.spanId;
  const records: NormalizedRecord[] = [];
  const system = contentValue(view, "gen_ai.system_instructions");
  if (system !== undefined) records.push(...systemRecords(system, timestamp));
  const messages =
    contentValue(view, "gen_ai.input.messages") ?? contentValue(view, "gen_ai.prompt");
  if (messages !== undefined) {
    records.push(...messagesRecords(messages, { timestamp, idPrefix: `${idPrefix}:in` }));
  } else {
    const flat = flattenedMessages(view.attributes, "gen_ai.prompt");
    if (flat.length > 0) {
      records.push(...messagesRecords(flat, { timestamp, idPrefix: `${idPrefix}:in` }));
    }
  }
  return records;
}

function outputOf(view: SpanView, timestamp: string): NormalizedRecord[] {
  const idPrefix = `${view.span.spanId}:out`;
  const messages =
    contentValue(view, "gen_ai.output.messages") ?? contentValue(view, "gen_ai.completion");
  if (messages !== undefined) {
    const parsed = jsonAttribute(messages);
    // A completion given as a bare string is the assistant's.
    if (typeof parsed === "string") {
      return parsed.trim() === "" ? [] : [{ role: "assistant", content: parsed, timestamp }];
    }
    return messagesRecords(
      (Array.isArray(parsed) ? parsed : [parsed]).map((m) =>
        typeof m === "object" && m !== null && !("role" in m) ? { role: "assistant", ...m } : m,
      ),
      { timestamp, idPrefix },
    );
  }
  const flat = flattenedMessages(view.attributes, "gen_ai.completion").map((m) => ({
    role: "assistant",
    ...m,
  }));
  return flat.length > 0 ? messagesRecords(flat, { timestamp, idPrefix }) : [];
}

/** One span → its part, by the conventions and then each mapper's `refine`. */
export function genAiPart(
  span: ReceivedSpan,
  resource: SpanResource = [],
  mappers: readonly SpanAttributeMapper[] = [],
): SpanPart {
  const view: SpanView = {
    span,
    attributes: new Attributes(span.attributes),
    resource: new Attributes(resource),
  };
  const started = isoFromNanos(span.startTimeUnixNano);
  if (!started) throw new Error(`span ${span.spanId} has no start time`);
  const ended = isoFromNanos(span.endTimeUnixNano);
  const operation = operationOf(view);
  const part: SpanPart = {
    trace_id: span.traceId,
    span_id: span.spanId,
    name: span.name,
    started_at: started,
    start_unix_nano: String(span.startTimeUnixNano),
    content: genAiHasContent(view) || mappers.some((m) => m.hasContent?.(view) === true),
  };
  if (span.parentSpanId) part.parent_span_id = span.parentSpanId;
  if (span.kind !== undefined) part.kind = span.kind;
  if (ended) {
    part.ended_at = ended;
    part.end_unix_nano = String(span.endTimeUnixNano);
  }
  part.status = statusOf(span);
  if (operation) part.operation = operation;
  const thread = view.attributes.string("gen_ai.conversation.id");
  if (thread) part.thread = thread;
  const input = inputOf(view, started);
  if (input.length > 0) part.input = input;
  const output = outputOf(view, ended ?? started);
  if (output.length > 0) part.output = output;
  const tool = toolOf(view, operation);
  if (tool) part.tool = tool;
  const call = llmCallOf(view, operation);
  if (call) part.llm_call = call;
  const response = view.attributes.string("gen_ai.response.id");
  if (response) part.response_id = response;
  const model = view.attributes.first("gen_ai.response.model", "gen_ai.request.model");
  if (model && (input.length > 0 || output.length > 0 || call)) part.meta = { model };
  let refined = part;
  for (const mapper of mappers) if (mapper.refine) refined = mapper.refine(refined, view);
  return refined;
}

/** The session a span belongs to (F4.3): each mapper's key, else `gen_ai.conversation.id`,
 * else the trace id. */
export function genAiSessionKey(
  span: ReceivedSpan,
  resource: SpanResource = [],
  mappers: readonly SpanAttributeMapper[] = [],
): string {
  const view: SpanView = {
    span,
    attributes: new Attributes(span.attributes),
    resource: new Attributes(resource),
  };
  for (const mapper of mappers) {
    const key = mapper.sessionKey?.(view);
    if (key) return key;
  }
  return view.attributes.string("gen_ai.conversation.id") ?? span.traceId;
}

export function viewOf(span: ReceivedSpan, resource: SpanResource): SpanView {
  return { span, attributes: new Attributes(span.attributes), resource: new Attributes(resource) };
}
