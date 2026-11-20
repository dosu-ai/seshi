import { createHash } from "node:crypto";
import {
  type LlmCall,
  OTLP_TRACE_SCHEMA,
  type OtlpKeyValue,
  type OtlpSpan,
  type OtlpTrace,
  type Provenance,
  parseTrace,
  type Trace,
  type TraceMetadata,
  type TraceMetaRecord,
  type TraceRecord,
  TrajectoryError,
  VERSION,
} from "@seshi/model";

type Scalar = string | number | boolean | null | undefined;

function attributes(pairs: [string, Scalar][]): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") out.push({ key, value: { stringValue: value } });
    else if (typeof value === "boolean") out.push({ key, value: { boolValue: value } });
    else if (Number.isInteger(value)) out.push({ key, value: { intValue: String(value) } });
    else out.push({ key, value: { doubleValue: value } });
  }
  return out;
}

function idFrom(seed: string, hexChars: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, hexChars);
}

function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString();
}

function epochOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function argumentsOf(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

type Part =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; response: string };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  parts: Part[];
  finish_reason?: "stop" | "tool_call";
}

function usageAttributes(call: LlmCall | undefined): [string, Scalar][] {
  const usage = call?.usage;
  if (!usage) return [];
  return [
    ["gen_ai.usage.input_tokens", usage.input_tokens],
    ["gen_ai.usage.output_tokens", usage.output_tokens],
    ["gen_ai.usage.cache_read.input_tokens", usage.cache_read_input_tokens],
    ["gen_ai.usage.cache_creation.input_tokens", usage.cache_creation_input_tokens],
    ["gen_ai.usage.reasoning_tokens", usage.reasoning_tokens],
  ];
}

export function toOtlp(trace: Trace): OtlpTrace {
  const traceId = idFrom(`seshi\n${trace.content_hash}`, 32);
  const spanId = (key: string) => idFrom(`seshi\n${trace.content_hash}\n${key}`, 16);
  const rootId = spanId("root");
  const model = typeof trace.metadata.model === "string" ? trace.metadata.model : undefined;
  const conversation = trace.session_id ?? undefined;
  const calls = new Map((trace.llm_calls ?? []).map((call) => [call.id, call]));
  const counted = new Set<string>();

  const records = trace.records;
  const meta = records[0]?.role === "meta" ? (records[0] as TraceMetaRecord) : undefined;
  const firstKnown = records
    .map((r) => (r.role === "meta" ? null : epochOf(r.timestamp)))
    .find((ms): ms is number => ms !== null);
  const startMs = epochOf(trace.started_at) ?? firstKnown ?? 0;
  let clock = startMs;

  const spans: OtlpSpan[] = [];
  const tools = new Map<string, { span: OtlpSpan; startMs: number }>();
  let pending: Message[] = [];
  let reasoning: Part[] = [];
  let chunkStart = meta ? 1 : 0;

  records.forEach((record: TraceRecord, index) => {
    if (record.role === "meta") return;
    const at = epochOf(record.timestamp) ?? clock;
    switch (record.role) {
      case "user":
      case "observation":
        pending.push({ role: "user", parts: [{ type: "text", content: record.content }] });
        break;
      case "system":
        pending.push({ role: "system", parts: [{ type: "text", content: record.content }] });
        break;
      case "reasoning":
        reasoning.push({ type: "reasoning", content: record.content });
        break;
      case "tool": {
        pending.push({
          role: "tool",
          parts: [
            { type: "tool_call_response", id: record.tool_call_id, response: record.content },
          ],
        });
        const tool = tools.get(record.tool_call_id);
        if (tool) {
          tool.span.endTimeUnixNano = nanos(Math.max(tool.startMs, at));
          tool.span.attributes.push(...attributes([["gen_ai.tool.call.result", record.content]]));
          if (record.ok === false) tool.span.status = { code: 2, message: "tool call failed" };
          tools.delete(record.tool_call_id);
        }
        break;
      }
      case "assistant": {
        const toolCalls = record.tool_calls ?? [];
        const parts: Part[] = [...reasoning];
        if (record.content) parts.push({ type: "text", content: record.content });
        for (const call of toolCalls) {
          parts.push({
            type: "tool_call",
            id: call.id,
            name: call.name,
            arguments: argumentsOf(call.args),
          });
        }
        const output: Message = {
          role: "assistant",
          parts,
          finish_reason: toolCalls.length > 0 ? "tool_call" : "stop",
        };
        const callId = record.llm_call;
        const call = callId === undefined ? undefined : calls.get(callId);
        const first = callId !== undefined && !counted.has(callId);
        if (callId !== undefined) counted.add(callId);
        const callModel = call?.model ?? model;
        const callStart = epochOf(call?.started_at);
        const callEnd = epochOf(call?.ended_at);
        spans.push({
          traceId,
          spanId: spanId(`chat:${index}`),
          parentSpanId: rootId,
          name: callModel ? `chat ${callModel}` : "chat",
          kind: 3,
          startTimeUnixNano: nanos(callStart ?? Math.min(clock, at)),
          endTimeUnixNano: nanos(Math.max(callEnd ?? at, callStart ?? 0)),
          attributes: attributes([
            ["gen_ai.operation.name", "chat"],
            ["gen_ai.conversation.id", conversation],
            ["gen_ai.request.model", callModel],
            ["gen_ai.response.model", call?.model],
            ["gen_ai.provider.name", call?.provider],
            ["gen_ai.response.id", call?.request_id],
            ...(first ? usageAttributes(call) : []),
            ["gen_ai.input.messages", JSON.stringify(pending)],
            ["gen_ai.output.messages", JSON.stringify([output])],
            ["seshi.llm_call", callId],
            ["seshi.record_start", chunkStart],
            ["seshi.records", JSON.stringify(records.slice(chunkStart, index + 1))],
          ]),
          status: call?.error ? { code: 2, message: call.error } : { code: 0 },
        });
        toolCalls.forEach((call, at_) => {
          const span: OtlpSpan = {
            traceId,
            spanId: spanId(`tool:${index}:${at_}`),
            parentSpanId: rootId,
            name: `execute_tool ${call.name}`,
            kind: 1,
            startTimeUnixNano: nanos(at),
            endTimeUnixNano: nanos(at),
            attributes: attributes([
              ["gen_ai.operation.name", "execute_tool"],
              ["gen_ai.conversation.id", conversation],
              ["gen_ai.tool.type", "function"],
              ["gen_ai.tool.name", call.name],
              ["gen_ai.tool.call.id", call.id],
              ["gen_ai.tool.call.arguments", call.args],
            ]),
            status: { code: 0 },
          };
          spans.push(span);
          tools.set(call.id, { span, startMs: at });
        });
        pending = [];
        reasoning = [];
        chunkStart = index + 1;
        break;
      }
    }
    clock = Math.max(clock, at);
  });

  const left =
    reasoning.length > 0 ? [...pending, { role: "assistant", parts: reasoning }] : pending;
  const endMs = Math.max(epochOf(trace.ended_at) ?? clock, startMs);
  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: `invoke_agent ${trace.source}`,
    kind: 1,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    attributes: attributes([
      ["gen_ai.operation.name", "invoke_agent"],
      ["gen_ai.agent.name", trace.source],
      ["gen_ai.conversation.id", conversation],
      ["gen_ai.request.model", model],
      ["seshi.unanswered_messages", left.length > 0 ? JSON.stringify(left) : undefined],
      ["seshi.record_start", chunkStart < records.length ? chunkStart : undefined],
      [
        "seshi.records",
        chunkStart < records.length ? JSON.stringify(records.slice(chunkStart)) : undefined,
      ],
    ]),
    status: { code: 0 },
  };

  const { continuation, normalizer, parent_session_id } = trace.metadata;
  const resource = attributes([
    ["service.name", "seshi"],
    ["seshi.schema", OTLP_TRACE_SCHEMA],
    ["seshi.content_hash", trace.content_hash],
    ["seshi.format", trace.format],
    ["seshi.source", trace.source],
    ["seshi.session_id", trace.session_id],
    ["seshi.project", trace.project],
    ["seshi.branch", trace.branch],
    ["seshi.started_at", trace.started_at],
    ["seshi.ended_at", trace.ended_at],
    ["seshi.cwd", typeof trace.metadata.cwd === "string" ? trace.metadata.cwd : undefined],
    ["seshi.git_branch", trace.metadata.git_branch],
    ["seshi.model", model],
    ["seshi.parent_session_id", parent_session_id],
    ["seshi.continuation.from_record", continuation?.from_record],
    ["seshi.continuation.prefix_sha256", continuation?.prefix_sha256],
    ["seshi.normalizer.name", normalizer?.name],
    ["seshi.normalizer.version", normalizer?.version],
    ["seshi.records", records.length],
    ["seshi.events", trace.events.length],
    ["seshi.meta", meta ? JSON.stringify(meta) : undefined],
    ["seshi.metadata", JSON.stringify(trace.metadata)],
    ["seshi.llm_calls", trace.llm_calls ? JSON.stringify(trace.llm_calls) : undefined],
    ["seshi.provenance", trace.provenance ? JSON.stringify(trace.provenance) : undefined],
  ]);

  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [{ scope: { name: "seshi", version: VERSION }, spans: [root, ...spans] }],
      },
    ],
  };
}

export function isOtlpTrace(value: unknown): value is OtlpTrace {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { resourceSpans?: unknown }).resourceSpans)
  );
}

export function otlpResource(trace: OtlpTrace, key: string): string | number | boolean | undefined {
  const kv = trace.resourceSpans[0]?.resource.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  const v = kv.value;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("boolValue" in v) return v.boolValue;
  return v.doubleValue;
}

export function otlpMeta(trace: OtlpTrace): TraceMetaRecord | undefined {
  const raw = otlpResource(trace, "seshi.meta");
  if (typeof raw !== "string") return undefined;
  const meta = JSON.parse(raw) as TraceMetaRecord;
  return meta.role === "meta" ? meta : undefined;
}

function spanAttribute(span: OtlpSpan, key: string): string | number | undefined {
  const kv = span.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  if ("stringValue" in kv.value) return kv.value.stringValue;
  if ("intValue" in kv.value) return Number(kv.value.intValue);
  return undefined;
}

export function fromOtlp(otlp: OtlpTrace): Trace {
  const hash = otlpResource(otlp, "seshi.content_hash");
  if (typeof hash !== "string") throw new TrajectoryError("not a seshi OTLP rendering");
  const chunks: { start: number; records: TraceRecord[] }[] = [];
  for (const span of otlp.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))) {
    const start = spanAttribute(span, "seshi.record_start");
    const raw = spanAttribute(span, "seshi.records");
    if (typeof start === "number" && typeof raw === "string") {
      chunks.push({ start, records: JSON.parse(raw) as TraceRecord[] });
    }
  }
  chunks.sort((a, b) => a.start - b.start);
  const meta = otlpMeta(otlp);
  const records: TraceRecord[] = meta ? [meta] : [];
  for (const chunk of chunks) {
    if (chunk.start !== records.length) {
      throw new TrajectoryError(`records ${records.length}..${chunk.start} are on no span`);
    }
    records.push(...chunk.records);
  }
  const str = (key: string) => {
    const v = otlpResource(otlp, key);
    return typeof v === "string" ? v : undefined;
  };
  const json = <T>(key: string): T | undefined => {
    const text = str(key);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  };
  const trace = parseTrace(records, {
    format: str("seshi.format") ?? str("seshi.agent"),
    session_id: str("seshi.session_id"),
    project: str("seshi.project"),
    branch: str("seshi.branch"),
    metadata: json<TraceMetadata>("seshi.metadata"),
    llm_calls: json<LlmCall[]>("seshi.llm_calls"),
    provenance: json<Provenance>("seshi.provenance"),
  });
  if (trace.content_hash !== hash) {
    throw new TrajectoryError(
      `records hash to ${trace.content_hash.slice(0, 12)}, object ${hash.slice(0, 12)}`,
    );
  }
  return trace;
}
