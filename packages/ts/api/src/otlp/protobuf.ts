/** OTLP/HTTP protobuf (F4.1), hand-written for the subset the trace receiver needs:
 * `ExportTraceServiceRequest` in, `ExportTraceServiceResponse` and `google.rpc.Status` out.
 * The Claude Console sends protobuf only, and a general protobuf runtime would be a large
 * dependency for six messages, so this reads the wire format directly (`opentelemetry-proto`
 * v1, `collector/trace/v1/trace_service.proto`, `trace/v1/trace.proto`,
 * `common/v1/common.proto`, `resource/v1/resource.proto`).
 *
 * The request decodes into OTLP's JSON mapping (ids as lowercase hex, times as decimal strings
 * of Unix nanoseconds, `int64` as decimal strings, bytes as base64), which
 * `readExportRequest` (`@seshi/formats`) then checks as it checks a JSON body, so both
 * encodings take one path. Unknown fields are skipped, as protobuf requires; a field whose wire
 * type is not the one the schema gives is skipped too. Malformed input (a length past the end,
 * a varint over ten bytes, nesting deeper than `MAX_DEPTH`) throws `ProtobufError`.
 *
 * Only the API (`seshi serve`) loads this module: `seshi hook` never does (X3.3). */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtobufError";
  }
}

/** How deep `AnyValue`s may nest (arrays and key-value lists inside each other). */
export const MAX_DEPTH = 32;

const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

const utf8 = new TextDecoder("utf-8");
const TWO_64 = 1n << 64n;
const TWO_63 = 1n << 63n;

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** A varint as a bigint (up to 64 bits). */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtobufError("truncated varint");
      const byte = this.buf[this.pos++] as number;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result & (TWO_64 - 1n);
      shift += 7n;
    }
    throw new ProtobufError("varint longer than ten bytes");
  }

  /** A varint that must fit a non-negative safe integer (tags, lengths, enums, counts). */
  uint(): number {
    // Fast path: tags and lengths almost always fit four bytes (28 bits).
    let result = 0;
    for (let i = 0, at = this.pos; i < 4 && at < this.end; i++, at++) {
      const byte = this.buf[at] as number;
      result += (byte & 0x7f) * 2 ** (7 * i);
      if ((byte & 0x80) === 0) {
        this.pos = at + 1;
        return result;
      }
    }
    const value = this.varint();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtobufError("varint out of range");
    return Number(value);
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new ProtobufError("truncated fixed64");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new ProtobufError("truncated double");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  /** The bounds of a length-delimited field's body. */
  len(): { start: number; end: number } {
    const length = this.uint();
    const start = this.pos;
    const end = start + length;
    if (end > this.end) throw new ProtobufError("length past the end of the message");
    this.pos = end;
    return { start, end };
  }

  bytes(): Uint8Array {
    const { start, end } = this.len();
    return this.buf.subarray(start, end);
  }

  string(): string {
    return utf8.decode(this.bytes());
  }

  sub(): Reader {
    const { start, end } = this.len();
    return new Reader(this.buf, start, end);
  }

  skip(wire: number): void {
    switch (wire) {
      case VARINT:
        this.varint();
        return;
      case I64:
        if (this.pos + 8 > this.end) throw new ProtobufError("truncated fixed64");
        this.pos += 8;
        return;
      case LEN:
        this.len();
        return;
      case I32:
        if (this.pos + 4 > this.end) throw new ProtobufError("truncated fixed32");
        this.pos += 4;
        return;
      default:
        // Groups (3, 4) are not used by OTLP; anything else is not protobuf.
        throw new ProtobufError(`unsupported wire type ${wire}`);
    }
  }

  /** Each field of the message: `visit(field, wire)` reads it, or returns false to skip it. */
  fields(visit: (field: number, wire: number) => boolean): void {
    while (!this.done) {
      const tag = this.uint();
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (field === 0) throw new ProtobufError("field number 0");
      if (!visit(field, wire)) this.skip(wire);
    }
  }
}

type Json = Record<string, unknown>;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function anyValue(r: Reader, depth: number): Json {
  if (depth > MAX_DEPTH) throw new ProtobufError("values nested too deep");
  let out: Json = {};
  r.fields((field, wire) => {
    if (field === 1 && wire === LEN) out = { stringValue: r.string() };
    else if (field === 2 && wire === VARINT) out = { boolValue: r.varint() !== 0n };
    else if (field === 3 && wire === VARINT) {
      const raw = r.varint();
      out = { intValue: (raw >= TWO_63 ? raw - TWO_64 : raw).toString() };
    } else if (field === 4 && wire === I64) out = { doubleValue: r.double() };
    else if (field === 5 && wire === LEN) {
      const sub = r.sub();
      const values: Json[] = [];
      sub.fields((f, w) => {
        if (f !== 1 || w !== LEN) return false;
        values.push(anyValue(sub.sub(), depth + 1));
        return true;
      });
      out = { arrayValue: { values } };
    } else if (field === 6 && wire === LEN) {
      const sub = r.sub();
      const values: Json[] = [];
      sub.fields((f, w) => {
        if (f !== 1 || w !== LEN) return false;
        values.push(keyValue(sub.sub(), depth + 1));
        return true;
      });
      out = { kvlistValue: { values } };
    } else if (field === 7 && wire === LEN) {
      out = { bytesValue: Buffer.from(r.bytes()).toString("base64") };
    } else return false;
    return true;
  });
  return out;
}

function keyValue(r: Reader, depth = 0): Json {
  const out: Json = { key: "" };
  r.fields((field, wire) => {
    if (field === 1 && wire === LEN) out.key = r.string();
    else if (field === 2 && wire === LEN) out.value = anyValue(r.sub(), depth);
    else return false;
    return true;
  });
  return out;
}

function attributesInto(list: Json[], r: Reader): void {
  list.push(keyValue(r.sub()));
}

function event(r: Reader): Json {
  const out: Json = { name: "", attributes: [] as Json[] };
  r.fields((field, wire) => {
    if (field === 1 && wire === I64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 2 && wire === LEN) out.name = r.string();
    else if (field === 3 && wire === LEN) attributesInto(out.attributes as Json[], r);
    else return false;
    return true;
  });
  return out;
}

function link(r: Reader): Json {
  const out: Json = { attributes: [] as Json[] };
  r.fields((field, wire) => {
    if (field === 1 && wire === LEN) out.traceId = hex(r.bytes());
    else if (field === 2 && wire === LEN) out.spanId = hex(r.bytes());
    else if (field === 4 && wire === LEN) attributesInto(out.attributes as Json[], r);
    else return false;
    return true;
  });
  return out;
}

function status(r: Reader): Json {
  const out: Json = {};
  r.fields((field, wire) => {
    if (field === 2 && wire === LEN) out.message = r.string();
    else if (field === 3 && wire === VARINT) out.code = r.uint();
    else return false;
    return true;
  });
  return out;
}

function span(r: Reader): Json {
  const out: Json = { attributes: [] as Json[], events: [] as Json[], links: [] as Json[] };
  r.fields((field, wire) => {
    switch (field) {
      case 1:
        if (wire !== LEN) return false;
        out.traceId = hex(r.bytes());
        return true;
      case 2:
        if (wire !== LEN) return false;
        out.spanId = hex(r.bytes());
        return true;
      case 4:
        if (wire !== LEN) return false;
        out.parentSpanId = hex(r.bytes());
        return true;
      case 5:
        if (wire !== LEN) return false;
        out.name = r.string();
        return true;
      case 6:
        if (wire !== VARINT) return false;
        out.kind = r.uint();
        return true;
      case 7:
        if (wire !== I64) return false;
        out.startTimeUnixNano = r.fixed64().toString();
        return true;
      case 8:
        if (wire !== I64) return false;
        out.endTimeUnixNano = r.fixed64().toString();
        return true;
      case 9:
        if (wire !== LEN) return false;
        attributesInto(out.attributes as Json[], r);
        return true;
      case 11:
        if (wire !== LEN) return false;
        (out.events as Json[]).push(event(r.sub()));
        return true;
      case 13:
        if (wire !== LEN) return false;
        (out.links as Json[]).push(link(r.sub()));
        return true;
      case 15:
        if (wire !== LEN) return false;
        out.status = status(r.sub());
        return true;
      default:
        return false;
    }
  });
  return out;
}

function scope(r: Reader): Json {
  const out: Json = {};
  r.fields((field, wire) => {
    if (field === 1 && wire === LEN) out.name = r.string();
    else if (field === 2 && wire === LEN) out.version = r.string();
    else return false;
    return true;
  });
  return out;
}

function scopeSpans(r: Reader): Json {
  const out: Json = { spans: [] as Json[] };
  r.fields((field, wire) => {
    if (field === 1 && wire === LEN) out.scope = scope(r.sub());
    else if (field === 2 && wire === LEN) (out.spans as Json[]).push(span(r.sub()));
    else return false;
    return true;
  });
  return out;
}

function resource(r: Reader): Json {
  const attributes: Json[] = [];
  r.fields((field, wire) => {
    if (field !== 1 || wire !== LEN) return false;
    attributesInto(attributes, r);
    return true;
  });
  return { attributes };
}

function resourceSpans(r: Reader): Json {
  const out: Json = { scopeSpans: [] as Json[] };
  r.fields((field, wire) => {
    if (wire !== LEN) return false;
    if (field === 1) out.resource = resource(r.sub());
    // 1000: `instrumentation_library_spans`, OTLP before 0.19; the same shape.
    else if (field === 2 || field === 1000) (out.scopeSpans as Json[]).push(scopeSpans(r.sub()));
    else return false;
    return true;
  });
  return out;
}

/** An `ExportTraceServiceRequest` → its JSON mapping (`{ resourceSpans: [...] }`). */
export function decodeExportRequest(bytes: Uint8Array): { resourceSpans: Json[] } {
  const r = new Reader(bytes);
  const resourceSpansList: Json[] = [];
  r.fields((field, wire) => {
    if (field !== 1 || wire !== LEN) return false;
    resourceSpansList.push(resourceSpans(r.sub()));
    return true;
  });
  return { resourceSpans: resourceSpansList };
}

// --- encoding -------------------------------------------------------------------

/** A protobuf writer for the few messages the receiver answers with, and for building requests
 * in tests and tools. */
class Writer {
  private chunks: number[] = [];

  varint(value: bigint | number): this {
    let v = BigInt(value);
    if (v < 0n) v += TWO_64;
    while (v >= 0x80n) {
      this.chunks.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.chunks.push(Number(v));
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, LEN).varint(value.length);
    for (const b of value) this.chunks.push(b);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  message(field: number, body: Writer): this {
    return this.bytes(field, body.finish());
  }

  fixed64(field: number, value: bigint): this {
    this.tag(field, I64);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
    for (const b of buf) this.chunks.push(b);
    return this;
  }

  double(field: number, value: number): this {
    this.tag(field, I64);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, value, true);
    for (const b of buf) this.chunks.push(b);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** `ExportTraceServiceResponse`: empty on full success; `partial_success` (rejected span count
 * and a message) when some spans were not accepted (F4.1, F4.5). */
export function encodeExportResponse(partial?: {
  rejected_spans: number;
  error_message?: string;
}): Uint8Array {
  const w = new Writer();
  if (partial && (partial.rejected_spans > 0 || partial.error_message)) {
    const p = new Writer();
    if (partial.rejected_spans > 0) p.tag(1, VARINT).varint(partial.rejected_spans);
    if (partial.error_message) p.string(2, partial.error_message);
    w.message(1, p);
  }
  return w.finish();
}

/** `google.rpc.Status`: what OTLP/HTTP answers a failed request with. */
export function encodeStatus(code: number, message: string): Uint8Array {
  const w = new Writer();
  if (code !== 0) w.tag(1, VARINT).varint(code);
  if (message) w.string(2, message);
  return w.finish();
}

type JsonValue = Record<string, unknown>;

function encodeAnyValue(value: JsonValue): Writer {
  const w = new Writer();
  if (typeof value.stringValue === "string") w.string(1, value.stringValue);
  else if (typeof value.boolValue === "boolean") w.tag(2, VARINT).varint(value.boolValue ? 1 : 0);
  else if (value.intValue !== undefined) w.tag(3, VARINT).varint(BigInt(value.intValue as string));
  else if (typeof value.doubleValue === "number") w.double(4, value.doubleValue);
  else if (value.arrayValue) {
    const a = new Writer();
    for (const v of ((value.arrayValue as JsonValue).values as JsonValue[]) ?? []) {
      a.message(1, encodeAnyValue(v));
    }
    w.message(5, a);
  } else if (value.kvlistValue) {
    const l = new Writer();
    for (const kv of ((value.kvlistValue as JsonValue).values as JsonValue[]) ?? []) {
      l.message(1, encodeKeyValue(kv));
    }
    w.message(6, l);
  } else if (typeof value.bytesValue === "string") {
    w.bytes(7, Buffer.from(value.bytesValue, "base64"));
  }
  return w;
}

function encodeKeyValue(kv: JsonValue): Writer {
  const w = new Writer().string(1, kv.key as string);
  if (kv.value) w.message(2, encodeAnyValue(kv.value as JsonValue));
  return w;
}

const idBytes = (value: unknown) => Buffer.from(String(value ?? ""), "hex");

/** An `ExportTraceServiceRequest` in OTLP's JSON mapping → protobuf. For tests and tools: the
 * receiver only decodes. */
export function encodeExportRequest(request: { resourceSpans: JsonValue[] }): Uint8Array {
  const w = new Writer();
  for (const rs of request.resourceSpans) {
    const rw = new Writer();
    const res = rs.resource as JsonValue | undefined;
    if (res) {
      const resw = new Writer();
      for (const kv of (res.attributes as JsonValue[]) ?? []) resw.message(1, encodeKeyValue(kv));
      rw.message(1, resw);
    }
    for (const ss of (rs.scopeSpans as JsonValue[]) ?? []) {
      const sw = new Writer();
      const sc = ss.scope as JsonValue | undefined;
      if (sc) {
        const scw = new Writer();
        if (sc.name) scw.string(1, sc.name as string);
        if (sc.version) scw.string(2, sc.version as string);
        sw.message(1, scw);
      }
      for (const sp of (ss.spans as JsonValue[]) ?? []) {
        const pw = new Writer();
        pw.bytes(1, idBytes(sp.traceId));
        pw.bytes(2, idBytes(sp.spanId));
        if (sp.parentSpanId) pw.bytes(4, idBytes(sp.parentSpanId));
        pw.string(5, (sp.name as string) ?? "");
        if (sp.kind !== undefined) pw.tag(6, VARINT).varint(sp.kind as number);
        pw.fixed64(7, BigInt(sp.startTimeUnixNano as string));
        if (sp.endTimeUnixNano) pw.fixed64(8, BigInt(sp.endTimeUnixNano as string));
        for (const kv of (sp.attributes as JsonValue[]) ?? []) pw.message(9, encodeKeyValue(kv));
        for (const ev of (sp.events as JsonValue[]) ?? []) {
          const ew = new Writer();
          if (ev.timeUnixNano) ew.fixed64(1, BigInt(ev.timeUnixNano as string));
          ew.string(2, (ev.name as string) ?? "");
          for (const kv of (ev.attributes as JsonValue[]) ?? []) ew.message(3, encodeKeyValue(kv));
          pw.message(11, ew);
        }
        const st = sp.status as JsonValue | undefined;
        if (st) {
          const stw = new Writer();
          if (st.message) stw.string(2, st.message as string);
          if (st.code) stw.tag(3, VARINT).varint(st.code as number);
          pw.message(15, stw);
        }
        sw.message(2, pw);
      }
      rw.message(2, sw);
    }
    w.message(1, rw);
  }
  return w.finish();
}
