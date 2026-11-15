/** A Datadog LLM Observability span → a span in OTLP's JSON mapping (`ReceivedSpan`), the shape
 * every span set travels in (X4.2). Datadog's own fields ride along as `datadog.*` attributes,
 * which the `datadog-llmobs` span adapter (`format.ts`) reads back; nothing here interprets
 * them. Ids become OTLP hex, times nanosecond strings.
 *
 * Trajectory (datadog-labs/trajectory) publishes each turn of a coding-agent session as its own
 * trace; its spans carry `trajectory.*` tags (docs/LLM-OBS-SPAN-TAGS.md in that repository),
 * and `sessionOf` reads the session they share from them (F5.3). */

import { createHash } from "node:crypto";
import type { ReceivedSpan, SpanAttribute, SpanValue } from "@seshi/model";
import type { DatadogIO, DatadogSpan } from "./api-types";

/** The attributes a converted span carries. */
export const ATTR = {
  spanKind: "datadog.span_kind",
  mlApp: "datadog.ml_app",
  modelName: "datadog.model_name",
  modelProvider: "datadog.model_provider",
  inputValue: "datadog.input.value",
  inputMessages: "datadog.input.messages",
  outputValue: "datadog.output.value",
  outputMessages: "datadog.output.messages",
  metadata: "datadog.metadata",
  metricPrefix: "datadog.metrics.",
  tags: "datadog.tags",
  sessionId: "datadog.session_id",
  /** Datadog's own ids, as it wrote them (decimal span ids), for tracing a span back. */
  spanId: "datadog.span_id",
  traceId: "datadog.trace_id",
} as const;

/** Tags that name a span's session, in the order they are tried (F5.3; see `sessionOf`). */
export const SESSION_TAGS = [
  "trajectory.session_id",
  "trajectory.trace_correlation.session_id",
  "session_id",
] as const;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const DIGITS = /^[0-9]+$/;
const ZERO = /^0+$/;
const MAX = { 8: (1n << 64n) - 1n, 16: (1n << 128n) - 1n } as const;

/** A Datadog id as OTLP hex of `bytes` bytes (8 for a span, 16 for a trace):
 * - all digits: Datadog's decimal form (`14624140233640368324`), when it fits;
 * - hex of exactly the right length: as it is, lower-cased (Datadog's 128-bit trace ids);
 * - anything else: the first bytes of its SHA-256, so the same id always maps the same way.
 * Undefined for an empty or zero id (OTLP's "no id"). */
export function idHex(value: unknown, bytes: 8 | 16): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value.toString(16).padStart(bytes * 2, "0");
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "" || text === "undefined" || text === "null" || ZERO.test(text)) return undefined;
  const exact = bytes === 16 ? HEX32 : HEX16;
  // A 32-character trace id is Datadog's hex form even when it holds only digits.
  if (bytes === 16 && exact.test(text)) return text;
  if (DIGITS.test(text)) {
    const n = BigInt(text);
    if (n > 0n && n <= MAX[bytes]) return n.toString(16).padStart(bytes * 2, "0");
  } else if (exact.test(text)) {
    return text;
  }
  return createHash("sha256")
    .update(`datadog:${text}`)
    .digest("hex")
    .slice(0, bytes * 2);
}

/** A span's start as Unix nanoseconds. The docs say `start_ns` is in nanoseconds, but their
 * example answers milliseconds, so the unit is read from the magnitude: a time after 2001 has
 * 19 digits in nanoseconds, 16 in microseconds, 13 in milliseconds and 10 in seconds. */
export function startNanos(value: unknown): bigint | undefined {
  let n: bigint;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    n = BigInt(Math.trunc(value));
  } else if (typeof value === "string" && DIGITS.test(value.trim())) {
    n = BigInt(value.trim());
  } else {
    return undefined;
  }
  if (n <= 0n) return undefined;
  if (n >= 100_000_000_000_000_000n) return n; // ns
  if (n >= 100_000_000_000_000n) return n * 1_000n; // µs
  if (n >= 100_000_000_000n) return n * 1_000_000n; // ms
  return n * 1_000_000_000n; // s
}

/** A tag's value from Datadog's `key:value` tags: the first with that key. */
export function tagValue(tags: readonly string[] | undefined, key: string): string | undefined {
  const lead = `${key}:`;
  for (const tag of tags ?? []) {
    if (typeof tag === "string" && tag.startsWith(lead)) {
      const value = tag.slice(lead.length).trim();
      if (value !== "") return value;
    }
  }
  return undefined;
}

const str = (key: string, value: string): SpanAttribute => ({ key, value: { stringValue: value } });

function ioAttributes(io: DatadogIO | undefined, value: string, messages: string): SpanAttribute[] {
  const out: SpanAttribute[] = [];
  if (!io || typeof io !== "object") return out;
  if (typeof io.value === "string" && io.value !== "") out.push(str(value, io.value));
  if (Array.isArray(io.messages) && io.messages.length > 0) {
    out.push(str(messages, JSON.stringify(io.messages)));
  }
  return out;
}

/** One Datadog span in OTLP's JSON mapping. Throws when it has no usable ids or start time. */
export function toReceivedSpan(span: DatadogSpan): ReceivedSpan {
  const traceId = idHex(span.trace_id, 16);
  const spanId = idHex(span.span_id, 8);
  if (!traceId || !spanId) throw new Error("a span without a trace or span id");
  const start = startNanos(span.start_ns);
  if (start === undefined) throw new Error(`span ${span.span_id} has no start time`);
  const attributes: SpanAttribute[] = [
    str(ATTR.spanId, String(span.span_id)),
    str(ATTR.traceId, String(span.trace_id)),
  ];
  const text = (key: string, value: unknown) => {
    if (typeof value === "string" && value !== "") attributes.push(str(key, value));
  };
  text(ATTR.spanKind, span.span_kind);
  text(ATTR.mlApp, span.ml_app);
  text(ATTR.modelName, span.model_name);
  text(ATTR.modelProvider, span.model_provider);
  text(ATTR.sessionId, span.session_id);
  attributes.push(...ioAttributes(span.input, ATTR.inputValue, ATTR.inputMessages));
  attributes.push(...ioAttributes(span.output, ATTR.outputValue, ATTR.outputMessages));
  if (span.metadata && typeof span.metadata === "object" && Object.keys(span.metadata).length) {
    attributes.push(str(ATTR.metadata, JSON.stringify(span.metadata)));
  }
  for (const [key, value] of Object.entries(span.metrics ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      attributes.push({ key: `${ATTR.metricPrefix}${key}`, value: { doubleValue: value } });
    }
  }
  const tags = (span.tags ?? []).filter((t): t is string => typeof t === "string");
  if (tags.length > 0) {
    attributes.push({
      key: ATTR.tags,
      value: { arrayValue: { values: tags.map((t): SpanValue => ({ stringValue: t })) } },
    });
  }
  const out: ReceivedSpan = {
    traceId,
    spanId,
    name:
      typeof span.name === "string" && span.name !== "" ? span.name : (span.span_kind ?? "span"),
    // Datadog has no span kinds of OTLP's sort; every span is internal.
    kind: 1,
    startTimeUnixNano: start.toString(),
    attributes,
  };
  const parent = idHex(span.parent_id ?? undefined, 8);
  if (parent && parent !== spanId) out.parentSpanId = parent;
  if (typeof span.duration === "number" && Number.isFinite(span.duration) && span.duration >= 0) {
    out.endTimeUnixNano = (start + BigInt(Math.round(span.duration))).toString();
  }
  if (span.status === "error") out.status = { code: 2 };
  else if (span.status === "ok") out.status = { code: 1 };
  return out;
}

/** The tags of a converted span. */
export function tagsOf(span: ReceivedSpan): string[] {
  const attr = span.attributes?.find((a) => a.key === ATTR.tags)?.value;
  if (!attr || !("arrayValue" in attr)) return [];
  return attr.arrayValue.values.flatMap((v) => ("stringValue" in v ? [v.stringValue] : []));
}

/** The session a converted span belongs to (F5.3), or undefined when it names none:
 * `trajectory.session_id` (on every span of a Trajectory turn), then
 * `trajectory.trace_correlation.session_id` (compaction and correlation spans), then a
 * `session_id` tag or field (LLM Observability's own sessions). Trajectory's automated
 * oversight traces (`trajectory.trace_type:oversight`) summarize other traces and belong to no
 * session. */
export function sessionOf(span: ReceivedSpan): string | undefined {
  const tags = tagsOf(span);
  if (tagValue(tags, "trajectory.trace_type") === "oversight") return undefined;
  for (const key of SESSION_TAGS) {
    const value = tagValue(tags, key);
    if (value) return value;
  }
  const own = span.attributes?.find((a) => a.key === ATTR.sessionId)?.value;
  return own && "stringValue" in own && own.stringValue !== "" ? own.stringValue : undefined;
}
