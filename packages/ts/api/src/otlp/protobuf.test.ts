import { readExportRequest } from "@seshi/formats";
import { describe, expect, it } from "vitest";
import {
  decodeExportRequest,
  encodeExportRequest,
  encodeExportResponse,
  encodeStatus,
  MAX_DEPTH,
  ProtobufError,
} from "./protobuf";

const bytes = (...parts: (number | number[])[]) => Uint8Array.from(parts.flat());
const TRACE = Array.from({ length: 16 }, (_, i) => i + 1);
const SPAN = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8];

/** A request encoded by hand from `trace.proto`, with an unknown field in the span. */
function handEncoded(): Uint8Array {
  // AnyValue { int_value (3) = -1 }: ten-byte varint of 2^64 - 1.
  const anyValue = [0x18, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
  // KeyValue { key (1) = "k", value (2) = anyValue }.
  const keyValue = [0x0a, 0x01, 0x6b, 0x12, anyValue.length, ...anyValue];
  const span = [
    [0x0a, 16, ...TRACE], // trace_id (1)
    [0x12, 8, ...SPAN], // span_id (2)
    [0x2a, 1, 0x78], // name (5) = "x"
    [0x30, 2], // kind (6) = SERVER
    [0x39, 1, 0, 0, 0, 0, 0, 0, 0], // start_time_unix_nano (7, fixed64) = 1
    [0x98, 0x06, 0x01], // field 99 (unknown), varint 1: skipped
    [0x4a, keyValue.length, ...keyValue], // attributes (9)
  ].flat();
  const scopeSpans = [0x12, span.length, ...span]; // spans (2)
  const resourceSpans = [0x12, scopeSpans.length, ...scopeSpans]; // scope_spans (2)
  return bytes(0x0a, resourceSpans.length, resourceSpans); // resource_spans (1)
}

describe("decodeExportRequest", () => {
  it("reads a hand-encoded request into OTLP's JSON mapping", () => {
    const decoded = decodeExportRequest(handEncoded());
    const read = readExportRequest(decoded);
    expect(read.rejected).toBe(0);
    expect(read.groups).toHaveLength(1);
    expect(read.groups[0]?.spans).toEqual([
      {
        traceId: "0102030405060708090a0b0c0d0e0f10",
        spanId: "a1a2a3a4a5a6a7a8",
        name: "x",
        kind: 2,
        startTimeUnixNano: "1",
        attributes: [{ key: "k", value: { intValue: -1 } }],
      },
    ]);
  });

  it("decodes what encodeExportRequest wrote to what the JSON reads as", () => {
    const request = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeSpans: [
            {
              scope: { name: "com.anthropic.claude-platform", version: "1" },
              spans: [
                {
                  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                  spanId: "00f067aa0ba902b7",
                  parentSpanId: "10a1b2c3d4e5f601",
                  name: "anthropic.messages.create",
                  kind: 2,
                  startTimeUnixNano: "1793527200000000000",
                  endTimeUnixNano: "18446744073709551615",
                  attributes: [
                    { key: "s", value: { stringValue: "héllo ✓" } },
                    { key: "b", value: { boolValue: true } },
                    { key: "i", value: { intValue: "9007199254740993" } },
                    { key: "d", value: { doubleValue: 0.25 } },
                    { key: "y", value: { bytesValue: "AQID" } },
                    {
                      key: "a",
                      value: { arrayValue: { values: [{ stringValue: "x" }, { intValue: "2" }] } },
                    },
                    {
                      key: "m",
                      value: {
                        kvlistValue: { values: [{ key: "n", value: { boolValue: false } }] },
                      },
                    },
                  ],
                  events: [
                    {
                      timeUnixNano: "1793527200000000001",
                      name: "e",
                      attributes: [{ key: "x", value: { stringValue: "y" } }],
                    },
                  ],
                  status: { code: 2, message: "boom" },
                },
              ],
            },
          ],
        },
      ],
    };
    const decoded = decodeExportRequest(encodeExportRequest(request));
    expect(readExportRequest(decoded)).toEqual(readExportRequest(request));
    const span = readExportRequest(decoded).groups[0]?.spans[0];
    expect(span?.scope).toEqual({ name: "com.anthropic.claude-platform", version: "1" });
    expect(span?.endTimeUnixNano).toBe("18446744073709551615");
  });

  it("reads the deprecated instrumentation_library_spans (field 1000)", () => {
    const span = [
      [0x0a, 16, ...TRACE],
      [0x12, 8, ...SPAN],
      [0x39, 5, 0, 0, 0, 0, 0, 0, 0],
    ].flat();
    const scopeSpans = [0x12, span.length, ...span];
    // Tag of field 1000, wire type 2: (1000 << 3) | 2 = 8002 = varint 0xc2 0x3e.
    const resourceSpans = [0xc2, 0x3e, scopeSpans.length, ...scopeSpans];
    const read = readExportRequest(
      decodeExportRequest(bytes(0x0a, resourceSpans.length, resourceSpans)),
    );
    expect(read.groups[0]?.spans[0]?.startTimeUnixNano).toBe("5");
  });

  it("refuses what is not protobuf", () => {
    expect(() => decodeExportRequest(bytes(0x0a, 0x05, 0x01))).toThrow(ProtobufError);
    expect(() => decodeExportRequest(bytes(0x0f))).toThrow(/wire type 7/);
    expect(() => decodeExportRequest(bytes(0x08, ...new Array(11).fill(0xff)))).toThrow(/varint/);
    expect(() => decodeExportRequest(bytes(0x00, 0x00))).toThrow(/field number 0/);
    expect(() => decodeExportRequest(bytes(0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f))).toThrow(
      /past the end/,
    );
  });

  it("refuses values nested deeper than MAX_DEPTH", () => {
    let value: Record<string, unknown> = { stringValue: "leaf" };
    for (let i = 0; i <= MAX_DEPTH + 1; i++) value = { arrayValue: { values: [value] } };
    const request = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "ab".repeat(16),
                  spanId: "cd".repeat(8),
                  startTimeUnixNano: "1",
                  attributes: [{ key: "deep", value }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => decodeExportRequest(encodeExportRequest(request))).toThrow(/nested too deep/);
  });

  it("reads an empty request as no spans", () => {
    expect(decodeExportRequest(new Uint8Array())).toEqual({ resourceSpans: [] });
  });
});

describe("encoding answers", () => {
  it("writes an empty ExportTraceServiceResponse on full success", () => {
    expect(encodeExportResponse()).toEqual(new Uint8Array());
    expect(encodeExportResponse({ rejected_spans: 0 })).toEqual(new Uint8Array());
  });

  it("writes partial_success with the rejected count and the message", () => {
    // partial_success (1) { rejected_spans (1) = 3, error_message (2) = "m" }.
    expect(encodeExportResponse({ rejected_spans: 3, error_message: "m" })).toEqual(
      bytes(0x0a, 0x05, 0x08, 0x03, 0x12, 0x01, 0x6d),
    );
  });

  it("writes a google.rpc.Status", () => {
    expect(encodeStatus(3, "bad")).toEqual(bytes(0x08, 0x03, 0x12, 0x03, 0x62, 0x61, 0x64));
  });
});
