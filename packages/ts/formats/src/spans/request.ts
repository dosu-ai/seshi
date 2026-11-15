/** An OTLP `ExportTraceServiceRequest` in its JSON mapping → spans grouped by resource, checked.
 * The JSON mapping writes field names in lowerCamelCase and ids as hex; field names in
 * snake_case (the proto's own) and base64 ids, which some exporters send, are read too. A span
 * whose ids or start time are unusable is counted as rejected, not stored. The protobuf
 * decoder (`@seshi/api`) produces the same groups. */

import type {
  ReceivedSpan,
  SpanAttribute,
  SpanEvent,
  SpanLink,
  SpanStatus,
  SpanValue,
} from "@seshi/model";

/** The spans of one `ResourceSpans`, with the resource's attributes. */
export interface SpanGroup {
  resource: SpanAttribute[];
  spans: ReceivedSpan[];
}

export interface ReadSpans {
  groups: SpanGroup[];
  /** Spans that could not be read (bad ids, no start time). */
  rejected: number;
  /** Why, for the first one: never content. */
  reason?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value[camel] ?? value[snake]`. */
function field(value: Json, camel: string): unknown {
  if (camel in value) return value[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return value[snake];
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** An id as lowercase hex of `bytes` bytes: hex as the JSON mapping writes it, or base64. Null
 * when it is neither, or all zero (OTLP's invalid id). */
export function hexId(value: unknown, bytes: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  let hex: string | null = null;
  if (value.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(value)) {
    hex = value.toLowerCase();
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === bytes) hex = decoded.toString("hex");
  }
  if (hex === null || /^0+$/.test(hex)) return null;
  return hex;
}

/** A Unix-nanosecond time as a decimal string, or undefined. */
export function nanosString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return BigInt(Math.trunc(value)).toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value) && !/^0+$/.test(value)) {
    return BigInt(value).toString();
  }
  return undefined;
}

/** An `AnyValue` in its JSON mapping (either spelling), normalized; undefined when empty. */
export function readValue(raw: unknown, depth = 0): SpanValue | undefined {
  if (!isObject(raw) || depth > 16) return undefined;
  const s = field(raw, "stringValue");
  if (typeof s === "string") return { stringValue: s };
  const b = field(raw, "boolValue");
  if (typeof b === "boolean") return { boolValue: b };
  const i = field(raw, "intValue");
  if (typeof i === "number" && Number.isFinite(i)) return { intValue: Math.trunc(i) };
  if (typeof i === "string" && /^-?\d+$/.test(i)) {
    const n = Number(i);
    return { intValue: Number.isSafeInteger(n) ? n : i };
  }
  const d = field(raw, "doubleValue");
  if (typeof d === "number") return { doubleValue: d };
  if (typeof d === "string" && d.trim() !== "" && Number.isFinite(Number(d))) {
    return { doubleValue: Number(d) };
  }
  const bytes = field(raw, "bytesValue");
  if (typeof bytes === "string") return { bytesValue: bytes };
  const array = field(raw, "arrayValue");
  if (isObject(array)) {
    return {
      arrayValue: {
        values: list(array.values)
          .map((v) => readValue(v, depth + 1))
          .filter((v): v is SpanValue => v !== undefined),
      },
    };
  }
  const kv = field(raw, "kvlistValue");
  if (isObject(kv)) return { kvlistValue: { values: readAttributes(kv.values, depth + 1) } };
  return undefined;
}

export function readAttributes(raw: unknown, depth = 0): SpanAttribute[] {
  const out: SpanAttribute[] = [];
  for (const item of list(raw)) {
    if (!isObject(item) || typeof item.key !== "string") continue;
    const value = readValue(item.value, depth);
    out.push(value === undefined ? { key: item.key } : { key: item.key, value });
  }
  return out;
}

function readEvents(raw: unknown): SpanEvent[] {
  return list(raw)
    .filter(isObject)
    .map((event) => {
      const out: SpanEvent = { name: typeof event.name === "string" ? event.name : "" };
      const time = nanosString(field(event, "timeUnixNano"));
      if (time) out.timeUnixNano = time;
      const attributes = readAttributes(event.attributes);
      if (attributes.length > 0) out.attributes = attributes;
      return out;
    });
}

function readLinks(raw: unknown): SpanLink[] {
  const out: SpanLink[] = [];
  for (const link of list(raw).filter(isObject)) {
    const traceId = hexId(field(link, "traceId"), 16);
    const spanId = hexId(field(link, "spanId"), 8);
    if (!traceId || !spanId) continue;
    const attributes = readAttributes(link.attributes);
    out.push({ traceId, spanId, ...(attributes.length > 0 ? { attributes } : {}) });
  }
  return out;
}

const KINDS: Readonly<Record<string, number>> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};
const CODES: Readonly<Record<string, number>> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function enumValue(value: unknown, names: Readonly<Record<string, number>>): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") return names[value];
  return undefined;
}

/** One span, checked; a string saying why when its ids or start time are unusable. */
export function readSpan(
  raw: unknown,
  scope?: { name?: string; version?: string },
): ReceivedSpan | string {
  if (!isObject(raw)) return "a span is not an object";
  const traceId = hexId(field(raw, "traceId"), 16);
  if (!traceId) return "a span has no valid traceId";
  const spanId = hexId(field(raw, "spanId"), 8);
  if (!spanId) return "a span has no valid spanId";
  const start = nanosString(field(raw, "startTimeUnixNano"));
  if (!start) return "a span has no startTimeUnixNano";
  const span: ReceivedSpan = {
    traceId,
    spanId,
    name: typeof raw.name === "string" ? raw.name : "",
    startTimeUnixNano: start,
  };
  const parentRaw = field(raw, "parentSpanId");
  if (parentRaw !== undefined && parentRaw !== null && parentRaw !== "") {
    const parent = hexId(parentRaw, 8);
    if (parent) span.parentSpanId = parent;
  }
  const kind = enumValue(raw.kind, KINDS);
  if (kind !== undefined) span.kind = kind;
  const end = nanosString(field(raw, "endTimeUnixNano"));
  if (end) span.endTimeUnixNano = end;
  const attributes = readAttributes(raw.attributes);
  if (attributes.length > 0) span.attributes = attributes;
  const events = readEvents(raw.events);
  if (events.length > 0) span.events = events;
  const links = readLinks(raw.links);
  if (links.length > 0) span.links = links;
  if (isObject(raw.status)) {
    const status: SpanStatus = {};
    const code = enumValue(raw.status.code, CODES);
    if (code !== undefined) status.code = code;
    if (typeof raw.status.message === "string" && raw.status.message !== "") {
      status.message = raw.status.message;
    }
    if (Object.keys(status).length > 0) span.status = status;
  }
  if (scope && (scope.name || scope.version)) span.scope = scope;
  return span;
}

/** A whole `ExportTraceServiceRequest` (parsed JSON) → its spans by resource. Throws when the
 * value is not a request at all. */
export function readExportRequest(value: unknown): ReadSpans {
  if (!isObject(value)) throw new Error("an ExportTraceServiceRequest is a JSON object");
  const groups: SpanGroup[] = [];
  let rejected = 0;
  let reason: string | undefined;
  for (const rs of list(field(value, "resourceSpans")).filter(isObject)) {
    const resource = isObject(rs.resource) ? readAttributes(rs.resource.attributes) : [];
    const spans: ReceivedSpan[] = [];
    const scopes = [
      ...list(field(rs, "scopeSpans")),
      // OTLP before 0.19 named them instrumentationLibrarySpans.
      ...list(field(rs, "instrumentationLibrarySpans")),
    ].filter(isObject);
    for (const ss of scopes) {
      const rawScope = isObject(ss.scope)
        ? ss.scope
        : isObject(field(ss, "instrumentationLibrary"))
          ? (field(ss, "instrumentationLibrary") as Json)
          : undefined;
      const scope = rawScope
        ? {
            ...(typeof rawScope.name === "string" && rawScope.name !== ""
              ? { name: rawScope.name }
              : {}),
            ...(typeof rawScope.version === "string" && rawScope.version !== ""
              ? { version: rawScope.version }
              : {}),
          }
        : undefined;
      for (const raw of list(ss.spans)) {
        const span = readSpan(raw, scope);
        if (typeof span === "string") {
          rejected++;
          reason ??= span;
        } else {
          spans.push(span);
        }
      }
    }
    if (spans.length > 0) groups.push({ resource, spans });
  }
  return { groups, rejected, ...(reason ? { reason } : {}) };
}
