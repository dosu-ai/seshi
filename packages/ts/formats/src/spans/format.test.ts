import { describe, expect, it } from "vitest";
import { asTranscript } from "../calls";
import { FormatRegistry } from "../registry";
import { genAiSpanAdapter, OTLP_GENAI, otlpGenAiFormat } from "./format";

const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
const DOC = {
  resourceSpans: [
    {
      resource: { attributes: [s("service.name", "app")] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: "ab".repeat(16),
              spanId: "cd".repeat(8),
              name: "chat m",
              startTimeUnixNano: "1793527200000000000",
              endTimeUnixNano: "1793527201000000000",
              attributes: [
                s("gen_ai.operation.name", "chat"),
                s("gen_ai.request.model", "m"),
                s(
                  "gen_ai.input.messages",
                  '[{"role":"user","parts":[{"type":"text","content":"q"}]}]',
                ),
                s(
                  "gen_ai.output.messages",
                  '[{"role":"assistant","parts":[{"type":"text","content":"a"}]}]',
                ),
              ],
            },
            { traceId: "ab".repeat(16), spanId: "ef".repeat(8), name: "no start" },
          ],
        },
      ],
    },
  ],
};

describe("otlpGenAiFormat", () => {
  it("is a whole-document format that takes span sets", () => {
    const format = otlpGenAiFormat();
    expect(format.source).toBe(OTLP_GENAI);
    expect(format.chunkable).toBe(false);
    expect(format.spans).toBeDefined();
  });

  it("reads an OTLP/JSON export as one session", () => {
    const { records, llm_calls } = asTranscript(otlpGenAiFormat().normalize(JSON.stringify(DOC)));
    const call = (records[2] as { llm_call?: string }).llm_call;
    expect(records).toEqual([
      { role: "meta", source: "otlp-genai", model: "m" },
      { role: "user", content: "q", timestamp: "2026-11-01T10:00:00.000Z" },
      // A log keeps the LLM calls the span path keeps.
      { role: "assistant", content: "a", timestamp: "2026-11-01T10:00:01.000Z", llm_call: call },
    ]);
    expect(llm_calls?.map((c) => c.id)).toEqual([call]);
  });

  it("is detected from an export's first key, and refuses what is not JSON", () => {
    const registry = new FormatRegistry([otlpGenAiFormat()]);
    expect(registry.detect(JSON.stringify(DOC).slice(0, 40))).toBe(OTLP_GENAI);
    expect(registry.detect('{"resource_spans": [')).toBe(OTLP_GENAI);
    expect(registry.detect('{"steps": []}')).toBeNull();
    expect(() => registry.normalize({ source: OTLP_GENAI, transcript: "{oops" })).toThrow(
      /one JSON document/,
    );
  });

  it("can be named otherwise", () => {
    expect(otlpGenAiFormat({ name: "acme-spans" }).source).toBe("acme-spans");
  });
});

describe("genAiSpanAdapter", () => {
  it("merges mappers' claims, account ids together", () => {
    const adapter = genAiSpanAdapter([
      { name: "a", claims: () => ({ account_ids: { a: "1" } }) },
      { name: "b", claims: () => ({ username: "u", account_ids: { b: "2" } }) },
      { name: "c" },
    ]);
    const span = {
      traceId: "ab".repeat(16),
      spanId: "cd".repeat(8),
      name: "x",
      startTimeUnixNano: "1",
    };
    expect(adapter.claims?.(span, [])).toEqual({ username: "u", account_ids: { a: "1", b: "2" } });
    expect(genAiSpanAdapter().claims?.(span, [])).toBeUndefined();
  });
});
