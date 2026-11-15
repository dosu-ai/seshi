import type { LlmCall, NormalizedRecord, SpanPart } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { assembleSpanParts, newInput } from "./assemble";

const at = (sec: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, sec)).toISOString();
const nanos = (sec: number) => (BigInt(Date.UTC(2026, 10, 1, 10, 0, sec)) * 1_000_000n).toString();
const user = (content: string, sec = 0): NormalizedRecord => ({
  role: "user",
  content,
  timestamp: at(sec),
});
const said = (content: string, sec = 0): NormalizedRecord => ({
  role: "assistant",
  content,
  timestamp: at(sec),
});
const system = (content: string, sec = 0): NormalizedRecord => ({
  role: "system",
  content,
  timestamp: at(sec),
});
const call = (id: string, name = "bash", sec = 0): NormalizedRecord => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, name, args: "{}" }],
  timestamp: at(sec),
});
const result = (id: string, content: string, sec = 0): NormalizedRecord => ({
  role: "tool",
  tool_call_id: id,
  content,
  timestamp: at(sec),
});

function part(id: string, start: number, end: number, extra: Partial<SpanPart> = {}): SpanPart {
  return {
    trace_id: extra.trace_id ?? "t1",
    span_id: id,
    name: id,
    started_at: at(start),
    ended_at: at(end),
    start_unix_nano: nanos(start),
    end_unix_nano: nanos(end),
    content: true,
    ...extra,
  };
}
const usage = (input: number): LlmCall => ({ id: "x", usage: { input_tokens: input } });
const assemble = (parts: SpanPart[]) => assembleSpanParts(parts, { source: "otlp-genai" });
const roles = (records: NormalizedRecord[]) =>
  records.map(
    (r) =>
      `${r.role}:${"content" in r && r.content !== null ? r.content : "tool_calls" in r ? r.tool_calls?.[0]?.id : ""}`,
  );

describe("newInput", () => {
  it("drops the history an input repeats, whole or with its start cut", () => {
    const history = [user("a"), said("b"), user("c"), said("d")];
    expect(newInput(history, [user("a"), said("b"), user("c"), said("d"), user("e")])).toEqual([
      user("e"),
    ]);
    expect(newInput(history, [user("c"), said("d"), user("e")])).toEqual([user("e")]);
    expect(newInput(history, [user("e")])).toEqual([user("e")]);
    expect(newInput([], [user("a")])).toEqual([user("a")]);
  });

  it("leaves reasoning out of the comparison", () => {
    const thinking: NormalizedRecord = { role: "reasoning", content: "hm", timestamp: at(0) };
    expect(newInput([user("a"), thinking, said("b")], [user("a"), said("b"), user("c")])).toEqual([
      user("c"),
    ]);
    expect(newInput([user("a"), said("b")], [user("a"), thinking, said("b"), user("c")])).toEqual([
      user("c"),
    ]);
  });
});

describe("assembleSpanParts", () => {
  it("keeps each thing a chat conversation said once, and system instructions when they change", () => {
    const { records } = assemble([
      part("c1", 0, 2, { input: [system("S"), user("q1")], output: [said("a1", 2)] }),
      part("c2", 3, 5, {
        input: [system("S"), user("q1"), said("a1"), user("q2")],
        output: [said("a2", 5)],
      }),
      part("c3", 6, 8, {
        input: [system("S2"), user("q1"), said("a1"), user("q2"), said("a2"), user("q3")],
        output: [said("a3", 8)],
      }),
    ]);
    expect(roles(records)).toEqual([
      "meta:",
      "system:S",
      "user:q1",
      "assistant:a1",
      "user:q2",
      "assistant:a2",
      "system:S2",
      "user:q3",
      "assistant:a3",
    ]);
  });

  it("gives the same session whatever order the parts arrive in, and with repeats", () => {
    const parts = [
      part("c1", 0, 2, {
        input: [user("q1")],
        output: [said("a1", 2)],
        llm_call: { ...usage(1), id: "c1" },
      }),
      part("t1", 2.5, 3, { tool: { name: "x", call_id: "k", args: "{}", result: "r" } }),
      part("c2", 4, 6, {
        input: [user("q1"), said("a1"), user("q2")],
        output: [said("a2", 6)],
        llm_call: { ...usage(2), id: "c2" },
      }),
    ];
    const forward = assemble(parts);
    expect(assemble([parts[2], parts[0], parts[1], parts[0]] as SpanPart[])).toEqual(forward);
  });

  it("keeps the server's report of a response over the client's", () => {
    const shared = { input: [user("q")], output: [said("a", 2)], response_id: "msg_1" };
    const { records, llm_calls } = assemble([
      part("client", 0, 3, { ...shared, kind: 3, llm_call: { ...usage(10), id: "client" } }),
      part("server", 1, 2, {
        ...shared,
        kind: 2,
        parent_span_id: "client",
        llm_call: { ...usage(10), id: "server" },
      }),
    ]);
    expect(roles(records)).toEqual(["meta:", "user:q", "assistant:a"]);
    expect(llm_calls.map((c) => c.id)).toEqual(["server"]);
    expect((records[2] as { llm_call?: string }).llm_call).toBe("server");
  });

  it("keeps a history per thread", () => {
    const { records } = assemble([
      part("a", 0, 1, { thread: "one", input: [user("go")], output: [said("ok1", 1)] }),
      part("b", 2, 3, { thread: "two", input: [user("go")], output: [said("ok2", 3)] }),
    ]);
    expect(roles(records)).toEqual([
      "meta:",
      "user:go",
      "assistant:ok1",
      "user:go",
      "assistant:ok2",
    ]);
  });

  it("writes a tool span's call only when no message holds it", () => {
    const { records } = assemble([
      part("turn", 0, 10, { output: [call("held"), result("held", "from message")] }),
      part("held-span", 1, 3, {
        tool: { name: "bash", call_id: "held", args: "{}", result: "x", ok: false },
      }),
      part("client-tool", 4, 5, {
        tool: { name: "lookup", call_id: "own", args: '{"q":1}', result: "found" },
      }),
      part("empty-tool", 6, 7, { content: false, tool: { name: "bash" } }),
    ]);
    expect(records.slice(1)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "own", name: "lookup", args: '{"q":1}' }],
        timestamp: at(4),
      },
      { role: "tool", tool_call_id: "own", content: "found", duration_ms: 1000, timestamp: at(5) },
      call("held"),
      { ...result("held", "from message"), duration_ms: 2000, ok: false },
    ]);
  });

  it("counts a request's usage once, and names a turn's records by its model requests", () => {
    const { records, llm_calls } = assemble([
      part("create", 0, 5, {
        input: [user("q")],
        output: [said("a", 5)],
        llm_call: { ...usage(100), id: "create" },
      }),
      part("inner", 1, 4, {
        content: false,
        parent_span_id: "create",
        llm_call: { ...usage(100), id: "inner" },
      }),
      part("turn", 10, 20, {
        trace_id: "t2",
        input: [user("next")],
        output: [
          said("one", 20),
          { role: "reasoning", content: "hm", timestamp: at(20) },
          said("two", 20),
        ],
      }),
      part("m1", 11, 12, {
        trace_id: "t2",
        content: false,
        parent_span_id: "turn",
        llm_call: { ...usage(1), id: "m1" },
      }),
      part("m2", 13, 14, {
        trace_id: "t2",
        content: false,
        parent_span_id: "turn",
        llm_call: { ...usage(2), id: "m2" },
      }),
      part("m3", 15, 16, {
        trace_id: "t2",
        content: false,
        parent_span_id: "turn",
        llm_call: { id: "m3", usage: { input_tokens: 3 }, ended_at: at(16) },
      }),
      // A turn on another thread, nested in the first: its model request is its own.
      part("sub", 17, 19, {
        trace_id: "t2",
        thread: "side",
        parent_span_id: "turn",
        input: [user("side q")],
        output: [said("side a", 19)],
      }),
      part("m4", 17.5, 18, {
        trace_id: "t2",
        content: false,
        parent_span_id: "sub",
        llm_call: { ...usage(4), id: "m4" },
      }),
    ]);
    const refs = records.map((r) => (r as { llm_call?: string }).llm_call ?? "-");
    expect(roles(records)).toEqual([
      "meta:",
      "user:q",
      "assistant:a",
      "user:next",
      "user:side q",
      "assistant:side a",
      "assistant:one",
      "reasoning:hm",
      "assistant:two",
    ]);
    expect(refs).toEqual(["-", "-", "create", "-", "-", "m4", "m1", "m2", "m2"]);
    // inner is the same request as create; m3 is counted into m2 (more requests than records).
    expect(llm_calls.map((c) => [c.id, c.usage?.input_tokens])).toEqual([
      ["create", 100],
      ["m4", 4],
      ["m1", 1],
      ["m2", 5],
    ]);
    expect(llm_calls.find((c) => c.id === "m2")?.ended_at).toBe(at(16));
  });

  it("survives parent chains that loop", () => {
    const { records, llm_calls } = assemble([
      part("a", 0, 5, { parent_span_id: "b", input: [user("q")], output: [said("x", 5)] }),
      part("b", 1, 4, { parent_span_id: "a", content: false, llm_call: { ...usage(1), id: "b" } }),
      part("c", 2, 3, { parent_span_id: "c", content: false, llm_call: { ...usage(2), id: "c" } }),
    ]);
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
    expect(llm_calls.map((c) => c.id)).toEqual(["b"]);
  });

  it("makes LLM call ids unique across traces", () => {
    const { llm_calls, records } = assemble([
      part("same", 0, 1, {
        trace_id: "a",
        input: [user("1")],
        output: [said("x", 1)],
        llm_call: { ...usage(1), id: "same" },
      }),
      part("same", 2, 3, {
        trace_id: "b",
        input: [user("2")],
        output: [said("y", 3)],
        llm_call: { ...usage(2), id: "same" },
      }),
    ]);
    expect(llm_calls.map((c) => c.id)).toEqual(["same", "b-same"]);
    expect(records.map((r) => (r as { llm_call?: string }).llm_call).filter(Boolean)).toEqual([
      "same",
      "b-same",
    ]);
  });

  it("starts with a meta record naming the format and what the parts say of the session", () => {
    const { records } = assemble([
      part("a", 0, 1, { meta: { model: "m1" } }),
      part("b", 2, 3, { meta: { model: "m2", cwd: "/repo", agent_version: "1.2" } }),
    ]);
    expect(records).toEqual([
      { role: "meta", source: "otlp-genai", model: "m1", cwd: "/repo", agent_version: "1.2" },
    ]);
  });
});
