import { describe, expect, it } from "vitest";
import { hexId, nanosString, readExportRequest, readValue } from "./request";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("readExportRequest", () => {
  it("reads the JSON mapping, with the scope carried onto each span", () => {
    const read = readExportRequest({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeSpans: [
            {
              scope: { name: "lib", version: "1.0" },
              spans: [
                {
                  traceId: TRACE.toUpperCase(),
                  spanId: SPAN,
                  parentSpanId: "",
                  name: "chat",
                  kind: "SPAN_KIND_SERVER",
                  startTimeUnixNano: 1793527200000000000,
                  endTimeUnixNano: "1793527201000000000",
                  attributes: [
                    { key: "i", value: { intValue: "7" } },
                    { key: "d", value: { doubleValue: "0.5" } },
                    { key: "empty" },
                  ],
                  status: { code: "STATUS_CODE_ERROR", message: "x" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(read).toEqual({
      groups: [
        {
          resource: [{ key: "service.name", value: { stringValue: "svc" } }],
          spans: [
            {
              traceId: TRACE,
              spanId: SPAN,
              name: "chat",
              kind: 2,
              startTimeUnixNano: "1793527200000000000",
              endTimeUnixNano: "1793527201000000000",
              attributes: [
                { key: "i", value: { intValue: 7 } },
                { key: "d", value: { doubleValue: 0.5 } },
                { key: "empty" },
              ],
              status: { code: 2, message: "x" },
              scope: { name: "lib", version: "1.0" },
            },
          ],
        },
      ],
      rejected: 0,
    });
  });

  it("reads the proto's snake_case names, base64 ids and instrumentationLibrarySpans", () => {
    const read = readExportRequest({
      resource_spans: [
        {
          instrumentation_library_spans: [
            {
              instrumentation_library: { name: "old" },
              spans: [
                {
                  trace_id: Buffer.from(TRACE, "hex").toString("base64"),
                  span_id: Buffer.from(SPAN, "hex").toString("base64"),
                  parent_span_id: Buffer.from("10a1b2c3d4e5f601", "hex").toString("base64"),
                  name: "x",
                  start_time_unix_nano: "5",
                  attributes: [{ key: "k", value: { string_value: "v" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(read.groups[0]?.spans[0]).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      parentSpanId: "10a1b2c3d4e5f601",
      name: "x",
      startTimeUnixNano: "5",
      attributes: [{ key: "k", value: { stringValue: "v" } }],
      scope: { name: "old" },
    });
  });

  it("counts spans with unusable ids or times as rejected, with the first reason", () => {
    const read = readExportRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: "0".repeat(32), spanId: SPAN, startTimeUnixNano: "1" },
                { traceId: TRACE, spanId: "zz", startTimeUnixNano: "1" },
                { traceId: TRACE, spanId: SPAN },
                "not a span",
                { traceId: TRACE, spanId: SPAN, startTimeUnixNano: "1" },
              ],
            },
          ],
        },
      ],
    });
    expect(read.rejected).toBe(4);
    expect(read.reason).toBe("a span has no valid traceId");
    expect(read.groups[0]?.spans).toHaveLength(1);
  });

  it("reads an empty request as no groups and refuses what is not one", () => {
    expect(readExportRequest({})).toEqual({ groups: [], rejected: 0 });
    expect(() => readExportRequest([])).toThrow();
  });
});

describe("helpers", () => {
  it("hexId takes hex or base64 of the right length, never all zero", () => {
    expect(hexId(SPAN, 8)).toBe(SPAN);
    expect(hexId(Buffer.from(SPAN, "hex").toString("base64"), 8)).toBe(SPAN);
    expect(hexId(TRACE, 8)).toBeNull();
    expect(hexId("0000000000000000", 8)).toBeNull();
    expect(hexId(12, 8)).toBeNull();
  });

  it("nanosString keeps big times exact", () => {
    expect(nanosString("18446744073709551615")).toBe("18446744073709551615");
    expect(nanosString(0)).toBeUndefined();
    expect(nanosString("-1")).toBeUndefined();
  });

  it("readValue keeps an int64 that does not fit a double as a string", () => {
    expect(readValue({ intValue: "9007199254740993" })).toEqual({ intValue: "9007199254740993" });
    expect(readValue({ intValue: 3.9 })).toEqual({ intValue: 3 });
    expect(readValue({ nothing: 1 })).toBeUndefined();
  });
});
