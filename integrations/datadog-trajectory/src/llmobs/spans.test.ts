import { Attributes } from "@seshi/formats";
import { describe, expect, it } from "vitest";
import type { DatadogSpan } from "./api-types";
import { ATTR, idHex, sessionOf, startNanos, tagValue, toReceivedSpan } from "./spans";

const span = (extra: Partial<DatadogSpan> = {}): DatadogSpan => ({
  span_id: "14624140233640368324",
  trace_id: "6903738200000000af2d3775dfc70530",
  parent_id: "undefined",
  start_ns: 1_794_650_400_000_000_000,
  duration: 83_000_000,
  ...extra,
});

describe("idHex", () => {
  it("reads Datadog's decimal span ids as 16 hex digits", () => {
    expect(idHex("14624140233640368324", 8)).toBe("caf3620f7ba1d8c4");
    expect(idHex("1", 8)).toBe("0000000000000001");
    expect(idHex(255, 8)).toBe("00000000000000ff");
  });

  it("keeps hex ids of the right length, lower-cased", () => {
    expect(idHex("6903738200000000AF2D3775DFC70530", 16)).toBe("6903738200000000af2d3775dfc70530");
    expect(idHex("00000000000000000000000000000123", 16)).toBe("00000000000000000000000000000123");
    expect(idHex("abcdef0123456789", 8)).toBe("abcdef0123456789");
  });

  it("reads a short decimal trace id as a number", () => {
    expect(idHex("123456789", 16)).toBe("000000000000000000000000075bcd15");
  });

  it("maps anything else to a stable digest", () => {
    const a = idHex("trace-9a8b7c6d5e4f", 16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(idHex("trace-9a8b7c6d5e4f", 16)).toBe(a);
    expect(idHex("trace-other", 16)).not.toBe(a);
    // A decimal past 64 bits cannot be a span id.
    expect(idHex("99999999999999999999999", 8)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("names no id for empty, zero and `undefined`", () => {
    for (const value of ["", "0", "000", "undefined", "null", undefined, null, 0, -3]) {
      expect(idHex(value, 8)).toBeUndefined();
    }
  });
});

describe("startNanos", () => {
  it("reads the unit from the magnitude", () => {
    const ns = 1_794_650_400_000_000_000n;
    expect(startNanos("1794650400000000000")).toBe(ns);
    expect(startNanos("1794650400000000")).toBe(ns); // µs
    expect(startNanos(1_794_650_400_000)).toBe(ns); // ms, as the docs' example answers
    expect(startNanos(1_794_650_400)).toBe(ns); // s
  });

  it("refuses what is not a positive time", () => {
    for (const value of [0, -1, "x", "12.5", Number.NaN, undefined, null, {}]) {
      expect(startNanos(value)).toBeUndefined();
    }
  });
});

describe("tagValue", () => {
  it("finds the first value of a key", () => {
    const tags = ["source:llm-observability", "source:integration", "env:", "a:b:c"];
    expect(tagValue(tags, "source")).toBe("llm-observability");
    expect(tagValue(tags, "a")).toBe("b:c");
    expect(tagValue(tags, "env")).toBeUndefined();
    expect(tagValue(tags, "missing")).toBeUndefined();
    expect(tagValue(undefined, "source")).toBeUndefined();
  });
});

describe("toReceivedSpan", () => {
  it("carries Datadog's fields as datadog.* attributes", () => {
    const received = toReceivedSpan(
      span({
        name: "llm_call",
        status: "error",
        span_kind: "llm",
        ml_app: "app",
        model_name: "gpt-4o-mini",
        model_provider: "openai",
        input: { value: "hi", messages: [{ role: "user", content: "hi" }] },
        output: { value: "hello" },
        metadata: { temperature: 0.1 },
        metrics: { input_tokens: 10, bad: Number.NaN },
        tags: ["env:prod"],
        session_id: "s-1",
      }),
    );
    expect(received).toMatchObject({
      traceId: "6903738200000000af2d3775dfc70530",
      spanId: "caf3620f7ba1d8c4",
      name: "llm_call",
      kind: 1,
      startTimeUnixNano: "1794650400000000000",
      endTimeUnixNano: "1794650400083000000",
      status: { code: 2 },
    });
    expect(received.parentSpanId).toBeUndefined();
    const attrs = new Attributes(received.attributes);
    expect(attrs.get(ATTR.spanKind)).toBe("llm");
    expect(attrs.get(ATTR.modelName)).toBe("gpt-4o-mini");
    expect(attrs.get(ATTR.inputValue)).toBe("hi");
    expect(JSON.parse(attrs.get(ATTR.inputMessages) as string)).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(attrs.get(ATTR.outputValue)).toBe("hello");
    expect(attrs.has(ATTR.outputMessages)).toBe(false);
    expect(JSON.parse(attrs.get(ATTR.metadata) as string)).toEqual({ temperature: 0.1 });
    expect(attrs.get(`${ATTR.metricPrefix}input_tokens`)).toBe(10);
    expect(attrs.has(`${ATTR.metricPrefix}bad`)).toBe(false);
    expect(attrs.get(ATTR.tags)).toEqual(["env:prod"]);
    expect(attrs.get(ATTR.sessionId)).toBe("s-1");
    expect(attrs.get(ATTR.spanId)).toBe("14624140233640368324");
  });

  it("links a parent and reads an ok status", () => {
    const received = toReceivedSpan(span({ parent_id: "7", status: "ok", duration: undefined }));
    expect(received.parentSpanId).toBe("0000000000000007");
    expect(received.status).toEqual({ code: 1 });
    expect(received.endTimeUnixNano).toBeUndefined();
    expect(received.name).toBe("span");
  });

  it("refuses a span without ids or a start", () => {
    expect(() => toReceivedSpan(span({ span_id: "0" }))).toThrow(/id/);
    expect(() => toReceivedSpan(span({ trace_id: "" }))).toThrow(/id/);
    expect(() => toReceivedSpan(span({ start_ns: 0 }))).toThrow(/start/);
  });
});

describe("sessionOf", () => {
  const of = (tags: string[], extra: Partial<DatadogSpan> = {}) =>
    sessionOf(toReceivedSpan(span({ tags, ...extra })));

  it("reads Trajectory's session tag first, then the correlation tag, then LLM Obs sessions", () => {
    expect(
      of(["session_id:c", "trajectory.trace_correlation.session_id:b", "trajectory.session_id:a"]),
    ).toBe("a");
    expect(of(["session_id:c", "trajectory.trace_correlation.session_id:b"])).toBe("b");
    expect(of(["session_id:c"])).toBe("c");
    expect(of([], { session_id: "d" })).toBe("d");
    expect(of(["env:prod"])).toBeUndefined();
  });

  it("puts no oversight trace in a session", () => {
    expect(of(["trajectory.trace_type:oversight", "trajectory.session_id:a"])).toBeUndefined();
  });
});
