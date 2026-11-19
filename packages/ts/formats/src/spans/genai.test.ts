import type { ReceivedSpan, SpanAttribute } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { Attributes, compareNanos, durationMs, isoFromNanos, plainValue } from "./attributes";
import {
  genAiHasContent,
  genAiPart,
  genAiSessionKey,
  type SpanAttributeMapper,
  viewOf,
} from "./genai";

const s = (key: string, value: string): SpanAttribute => ({ key, value: { stringValue: value } });
const n = (key: string, value: number): SpanAttribute => ({ key, value: { intValue: value } });
const T0 = "1793527200000000000"; // 2026-11-01T10:00:00Z
const T1 = "1793527202500000000"; // +2.5 s

function span(attributes: SpanAttribute[], extra: Partial<ReceivedSpan> = {}): ReceivedSpan {
  return {
    traceId: "ab".repeat(16),
    spanId: "cd".repeat(8),
    name: "chat claude-x",
    startTimeUnixNano: T0,
    endTimeUnixNano: T1,
    attributes,
    ...extra,
  };
}

describe("attributes", () => {
  it("reads AnyValues as plain values", () => {
    expect(plainValue({ intValue: "9007199254740993" })).toBe("9007199254740993");
    expect(plainValue({ intValue: "42" })).toBe(42);
    expect(
      plainValue({
        kvlistValue: {
          values: [{ key: "a", value: { arrayValue: { values: [{ boolValue: true }] } } }],
        },
      }),
    ).toEqual({ a: [true] });
    expect(plainValue(undefined)).toBeNull();
  });

  it("reads counts, strings and lists, the last of a repeated key winning", () => {
    const attrs = new Attributes([n("c", 3), s("c", "4"), s("e", ""), n("neg", -1)]);
    expect(attrs.count("c")).toBe(4);
    expect(attrs.count("neg")).toBeUndefined();
    expect(attrs.string("e")).toBeUndefined();
    expect(attrs.has("e")).toBe(false);
    expect(attrs.first("missing", "c")).toBe("4");
  });

  it("converts and orders Unix nanoseconds", () => {
    expect(isoFromNanos(T0)).toBe("2026-11-01T10:00:00.000Z");
    expect(isoFromNanos("0")).toBeUndefined();
    expect(isoFromNanos("x")).toBeUndefined();
    expect(durationMs(T0, T1)).toBe(2500);
    expect(durationMs(T1, T0)).toBeUndefined();
    expect(compareNanos("999", "1000")).toBeLessThan(0);
    expect(compareNanos(T1, T0)).toBeGreaterThan(0);
  });
});

describe("genAiPart", () => {
  it("reads a chat span: messages, the model request and its usage", () => {
    const part = genAiPart(
      span(
        [
          s("gen_ai.operation.name", "chat"),
          s("gen_ai.provider.name", "anthropic"),
          s("gen_ai.request.model", "claude-x"),
          s("gen_ai.response.model", "claude-x-2026"),
          s("gen_ai.response.id", "msg_1"),
          s("gen_ai.conversation.id", "conv_1"),
          {
            key: "gen_ai.response.finish_reasons",
            value: { arrayValue: { values: [{ stringValue: "stop" }] } },
          },
          n("gen_ai.usage.input_tokens", 100),
          n("gen_ai.usage.output_tokens", 20),
          n("gen_ai.usage.cache_read.input_tokens", 80),
          n("gen_ai.request.max_tokens", 512),
          { key: "gen_ai.request.temperature", value: { doubleValue: 0.2 } },
          {
            key: "gen_ai.request.stop_sequences",
            value: { arrayValue: { values: [{ stringValue: "END" }] } },
          },
          s("gen_ai.system_instructions", '[{"type":"text","content":"Be kind."}]'),
          s("gen_ai.input.messages", '[{"role":"user","parts":[{"type":"text","content":"Hi"}]}]'),
          s(
            "gen_ai.output.messages",
            '[{"role":"assistant","parts":[{"type":"text","content":"Hello"}]}]',
          ),
        ],
        { kind: 2, parentSpanId: "ef".repeat(8) },
      ),
    );
    expect(part).toMatchObject({
      trace_id: "ab".repeat(16),
      span_id: "cd".repeat(8),
      parent_span_id: "ef".repeat(8),
      kind: 2,
      started_at: "2026-11-01T10:00:00.000Z",
      ended_at: "2026-11-01T10:00:02.500Z",
      operation: "chat",
      thread: "conv_1",
      response_id: "msg_1",
      content: true,
      status: "unset",
      meta: { model: "claude-x-2026" },
      input: [
        { role: "system", content: "Be kind.", timestamp: "2026-11-01T10:00:00.000Z" },
        { role: "user", content: "Hi", timestamp: "2026-11-01T10:00:00.000Z" },
      ],
      output: [{ role: "assistant", content: "Hello", timestamp: "2026-11-01T10:00:02.500Z" }],
    });
    expect(part.llm_call).toEqual({
      id: "cd".repeat(8),
      model: "claude-x-2026",
      provider: "anthropic",
      started_at: "2026-11-01T10:00:00.000Z",
      ended_at: "2026-11-01T10:00:02.500Z",
      duration_ms: 2500,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
      stop_reason: "stop",
      request_id: "msg_1",
      parameters: { max_tokens: 512, temperature: 0.2, stop_sequences: '["END"]' },
    });
  });

  it("reads an execute_tool span as its tool call", () => {
    const part = genAiPart(
      span(
        [
          s("gen_ai.operation.name", "execute_tool"),
          s("gen_ai.tool.name", "bash"),
          s("gen_ai.tool.call.id", "call_1"),
          s("gen_ai.tool.call.arguments", '{"command":"ls"}'),
          s("gen_ai.tool.call.result", "a.txt"),
          s("error.type", "tool_error"),
        ],
        { name: "execute_tool bash", status: { code: 2, message: "exit 1" } },
      ),
    );
    expect(part.tool).toEqual({
      name: "bash",
      call_id: "call_1",
      args: '{"command":"ls"}',
      result: "a.txt",
      ok: false,
    });
    expect(part.status).toBe("error");
    expect(part.llm_call).toBeUndefined();
  });

  it("records a failed model request's error, and takes the operation from the span name", () => {
    const part = genAiPart(
      span([s("gen_ai.request.model", "m"), s("error.type", "rate_limit_error")], {
        status: { code: 2, message: "slow down" },
      }),
    );
    expect(part.operation).toBe("chat");
    expect(part.llm_call?.error).toBe("rate_limit_error: slow down");
    expect(part.content).toBe(false);
  });

  it("reads content carried in an event", () => {
    const view = span([], {
      events: [
        {
          name: "gen_ai.client.inference.operation.details",
          attributes: [
            s(
              "gen_ai.output.messages",
              '[{"role":"assistant","parts":[{"type":"text","content":"yo"}]}]',
            ),
          ],
        },
      ],
    });
    expect(genAiHasContent(viewOf(view, []))).toBe(true);
    expect(genAiPart(view).output).toEqual([
      { role: "assistant", content: "yo", timestamp: "2026-11-01T10:00:02.500Z" },
    ]);
  });

  it("reads the flattened legacy prompt and completion", () => {
    const part = genAiPart(
      span([
        s("gen_ai.prompt.0.role", "user"),
        s("gen_ai.prompt.0.content", "q"),
        s("gen_ai.completion.0.content", "a"),
      ]),
    );
    expect(part.content).toBe(true);
    expect(part.input).toEqual([
      { role: "user", content: "q", timestamp: "2026-11-01T10:00:00.000Z" },
    ]);
    expect(part.output).toEqual([
      { role: "assistant", content: "a", timestamp: "2026-11-01T10:00:02.500Z" },
    ]);
  });

  it("refuses a span without a start time", () => {
    expect(() => genAiPart(span([], { startTimeUnixNano: "0" }))).toThrow(/start time/);
  });

  it("lets mappers refine the part and name the session first", () => {
    const mapper: SpanAttributeMapper = {
      name: "acme",
      sessionKey: (view) => view.attributes.string("acme.session"),
      hasContent: (view) => view.attributes.has("acme.text"),
      refine: (part, view) => ({ ...part, final: view.attributes.boolean("acme.end") === true }),
    };
    const a = span([
      s("acme.session", "S"),
      s("acme.text", "x"),
      { key: "acme.end", value: { boolValue: true } },
    ]);
    expect(genAiSessionKey(a, [], [mapper])).toBe("S");
    expect(genAiPart(a, [], [mapper])).toMatchObject({ content: true, final: true });
    expect(genAiSessionKey(span([s("gen_ai.conversation.id", "C")]), [], [mapper])).toBe("C");
    expect(genAiSessionKey(span([]), [], [mapper])).toBe("ab".repeat(16));
  });
});
