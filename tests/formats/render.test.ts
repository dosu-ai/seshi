/** The renderers (X6.2) over traces the pipeline stored: the canonical trace as Letta, OTLP and
 * ATIF, and OTLP back to the canonical trace. It crosses packages (formats, pipeline, store),
 * so it lives in tests/ (X3.6). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATIF_FORMAT,
  fromOtlp,
  isOtlpTrace,
  otlpMeta,
  otlpResource,
  renderTrace,
  toAtif,
  toLetta,
  toOtlp,
} from "@seshi/formats";
import {
  type AtifDocument,
  type LlmCall,
  type OtlpSpan,
  type OtlpTrace,
  parseTrace,
  type StoreSessionResult,
  type Trace,
  type TraceRecord,
} from "@seshi/model";
import { StoreSessionDB as Db, getTrace, type StoreClientOptions } from "@seshi/pipeline";
import { FsStore } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const formats = buildFormats();
/** The pipeline over a store with this binary's formats. */
class StoreSessionDB extends Db {
  constructor(options: Omit<StoreClientOptions, "formats">) {
    super({ formats, ...options });
  }
}
const SMALL = transcript("claude-basic.claude-code.jsonl");
const line = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`;
const turn = (n: number, text: string, sessionId = "sess1") =>
  line({
    type: "user",
    uuid: `u${n}`,
    timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:00.000Z`,
    sessionId,
    message: { role: "user", content: `question ${n}` },
  }) +
  line({
    type: "assistant",
    uuid: `a${n}`,
    timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:05.000Z`,
    sessionId,
    message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] },
  });
/** The basic fixture (a question, an answer, a Read and its result) plus a long answer, so it
 * is worth a trace. */
const CLAUDE = `${SMALL.trim()}\n${turn(9, `The auth flow: ${"details ".repeat(400)}`)}`;

function stored(result: StoreSessionResult): Extract<StoreSessionResult, { content_hash: string }> {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

function spansOf(trace: OtlpTrace): OtlpSpan[] {
  return trace.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
}

function attr(span: OtlpSpan, key: string): string | undefined {
  const v = span.attributes.find((a) => a.key === key)?.value;
  return v && "stringValue" in v ? v.stringValue : undefined;
}

let dir: string;
let store: FsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-render-"));
  store = new FsStore(join(dir, "bucket"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function storedTrace(): Promise<Trace> {
  const db = new StoreSessionDB({ store, owner: "acme" });
  const result = stored(
    await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
  );
  return (await getTrace(store, "acme", result.archive_id, result.content_hash)) as Trace;
}

/** A stored trace with what raw used to keep: LLM calls with usage, ids, a tool duration. */
async function enrichedTrace(): Promise<Trace> {
  const trace = await storedTrace();
  // The first two assistant records are one LLM call (a text and a tool call), the third
  // another.
  let assistants = 0;
  const records = trace.records.map((record, i): TraceRecord => {
    if (record.role === "assistant") {
      assistants++;
      return { ...record, id: `msg-${i}`, llm_call: assistants <= 2 ? "c1" : "c2" };
    }
    if (record.role === "tool") return { ...record, duration_ms: 40 };
    return record;
  });
  const llm_calls: LlmCall[] = [
    {
      id: "c1",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      started_at: "2026-09-01T00:00:01.000Z",
      ended_at: "2026-09-01T00:00:04.000Z",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
      },
      request_id: "msg_01abc",
      stop_reason: "tool_use",
    },
    {
      id: "c2",
      model: "claude-haiku-5-5",
      usage: { input_tokens: 7, output_tokens: 3 },
      error: "overloaded",
    },
  ];
  return parseTrace(records, {
    agent: trace.agent,
    session_id: trace.session_id ?? undefined,
    metadata: trace.metadata,
    llm_calls,
    provenance: { source: "hook", source_id: "upload", format: "claude-code" },
  });
}

describe("toOtlp", () => {
  it("makes an invoke_agent root, a chat span per assistant record and a span per tool call", async () => {
    const trace = await storedTrace();
    const otlp = toOtlp(trace);
    const spans = spansOf(otlp);
    const [root, ...rest] = spans;

    expect(root?.name).toBe("invoke_agent claude-code");
    expect(root?.parentSpanId).toBeUndefined();
    expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(attr(root as OtlpSpan, "gen_ai.conversation.id")).toBe("sess1");
    expect(rest.every((s) => s.parentSpanId === root?.spanId && s.traceId === root?.traceId)).toBe(
      true,
    );
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);

    const chats = rest.filter((s) => attr(s, "gen_ai.operation.name") === "chat");
    expect(chats).toHaveLength(3);
    expect(chats[0]?.name).toBe("chat claude-x");
    // The first call's input is the question; it took from the question to the answer.
    const input = JSON.parse(attr(chats[0] as OtlpSpan, "gen_ai.input.messages") as string);
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe("user");
    expect(chats[0]?.startTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:00.000Z")}000000`);
    expect(chats[0]?.endTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:05.000Z")}000000`);

    const [tool] = rest.filter((s) => attr(s, "gen_ai.operation.name") === "execute_tool");
    expect(tool?.name).toBe("execute_tool Read");
    expect(attr(tool as OtlpSpan, "gen_ai.tool.call.id")).toBe("toolu_01AbCdEfGhJkLmNpQr");
    expect(JSON.parse(attr(tool as OtlpSpan, "gen_ai.tool.call.arguments") as string)).toEqual({
      file_path: "/repo/app/auth.ts",
    });
    expect(attr(tool as OtlpSpan, "gen_ai.tool.call.result")).toContain("KEY");
    expect(tool?.endTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:07.000Z")}000000`);

    // The tool result is the next call's input.
    const next = JSON.parse(attr(chats[2] as OtlpSpan, "gen_ai.input.messages") as string);
    expect(next.map((m: { role: string }) => m.role)).toEqual(["tool", "user"]);
  });

  it("is deterministic, redacted, and carries the meta record and session on its resource", async () => {
    const trace = await storedTrace();
    const otlp = toOtlp(trace);
    expect(JSON.stringify(toOtlp(trace))).toBe(JSON.stringify(otlp));
    const text = JSON.stringify(otlp);
    expect(text).not.toContain("hunter2secretvalue42");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");

    expect(otlpMeta(otlp)).toEqual(trace.records[0]);
    expect(otlpResource(otlp, "seshi.content_hash")).toBe(trace.content_hash);
    expect(otlpResource(otlp, "seshi.session_id")).toBe("sess1");
    expect(otlpResource(otlp, "seshi.records")).toBe(trace.records.length);
    expect(isOtlpTrace(otlp)).toBe(true);
    expect(isOtlpTrace(trace)).toBe(false);
  });

  it("converts back to the canonical trace it was made from, LLM calls and provenance included", async () => {
    for (const trace of [await storedTrace(), await enrichedTrace()]) {
      expect(fromOtlp(toOtlp(trace))).toEqual(trace);
      // Through JSON too, as a reader gets it over HTTP.
      expect(fromOtlp(JSON.parse(JSON.stringify(toOtlp(trace))))).toEqual(trace);
    }
  });

  it("puts each LLM call's model, usage and timing on its first chat span only", async () => {
    const trace = await enrichedTrace();
    const chats = spansOf(toOtlp(trace)).filter((s) => attr(s, "gen_ai.operation.name") === "chat");
    const int = (span: OtlpSpan, key: string) => {
      const v = span.attributes.find((a) => a.key === key)?.value;
      return v && "intValue" in v ? Number(v.intValue) : undefined;
    };
    expect(chats.map((s) => attr(s, "seshi.llm_call"))).toEqual(["c1", "c1", "c2"]);
    expect(chats[0]?.name).toBe("chat claude-sonnet-4-5");
    expect(attr(chats[0] as OtlpSpan, "gen_ai.response.model")).toBe("claude-sonnet-4-5");
    expect(attr(chats[0] as OtlpSpan, "gen_ai.provider.name")).toBe("anthropic");
    expect(attr(chats[0] as OtlpSpan, "gen_ai.response.id")).toBe("msg_01abc");
    expect(int(chats[0] as OtlpSpan, "gen_ai.usage.input_tokens")).toBe(100);
    expect(int(chats[0] as OtlpSpan, "gen_ai.usage.output_tokens")).toBe(20);
    expect(int(chats[0] as OtlpSpan, "gen_ai.usage.cache_read.input_tokens")).toBe(1000);
    expect(int(chats[0] as OtlpSpan, "gen_ai.usage.cache_creation.input_tokens")).toBe(50);
    expect(chats[0]?.startTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:01.000Z")}000000`);
    expect(chats[0]?.endTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:04.000Z")}000000`);
    // The second record of the same call is not counted again.
    expect(int(chats[1] as OtlpSpan, "gen_ai.usage.input_tokens")).toBeUndefined();
    expect(int(chats[2] as OtlpSpan, "gen_ai.usage.input_tokens")).toBe(7);
    expect(chats[2]?.status).toEqual({ code: 2, message: "overloaded" });
  });

  it("refuses to convert an object whose records are missing or changed", async () => {
    const otlp = toOtlp(await storedTrace());
    const spans = otlp.resourceSpans[0]?.scopeSpans[0]?.spans as OtlpSpan[];
    const gap = structuredClone(otlp);
    gap.resourceSpans[0]?.scopeSpans[0]?.spans.splice(1, 1);
    expect(() => fromOtlp(gap)).toThrow(/on no span/);

    const changed = structuredClone(otlp);
    const chat = changed.resourceSpans[0]?.scopeSpans[0]?.spans.find(
      (s) => s.spanId === spans[1]?.spanId,
    ) as OtlpSpan;
    const kv = chat.attributes.find((a) => a.key === "seshi.records");
    if (!kv || !("stringValue" in kv.value)) throw new Error("no records");
    kv.value.stringValue = kv.value.stringValue.replace("auth", "AUTH");
    expect(() => fromOtlp(changed)).toThrow(/hash to/);
  });

  it("marks a failed tool call as an error and keeps an unanswered question on the root", () => {
    const trace = {
      schema: "seshi/trace/1",
      content_hash: "h".repeat(64),
      source: "codex",
      agent: "codex",
      session_id: "s",
      started_at: "2026-09-01T00:00:00.000Z",
      ended_at: "2026-09-01T00:00:09.000Z",
      records: [
        { role: "meta", source: "codex" },
        { role: "user", content: "run it", timestamp: "2026-09-01T00:00:00.000Z" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", name: "shell", args: "not json" }],
          timestamp: "2026-09-01T00:00:01.000Z",
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: "boom",
          ok: false,
          timestamp: "bad",
        },
        { role: "user", content: "well?", timestamp: "2026-09-01T00:00:09.000Z" },
      ],
      events: [],
      metadata: {},
    } as unknown as Trace;
    const spans = spansOf(toOtlp(trace));
    const tool = spans.find((s) => s.name === "execute_tool shell") as OtlpSpan;
    expect(tool.status).toEqual({ code: 2, message: "tool call failed" });
    expect(attr(tool, "gen_ai.tool.call.arguments")).toBe("not json");
    // An unparseable timestamp falls back to the last one known.
    expect(tool.endTimeUnixNano).toBe(tool.startTimeUnixNano);
    const left = JSON.parse(attr(spans[0] as OtlpSpan, "seshi.unanswered_messages") as string);
    expect(left.map((m: { role: string }) => m.role)).toEqual(["tool", "user"]);
  });
});

describe("toLetta", () => {
  it("is the sessiondb trace object: plain trajectory-v1 records, same events and hash", async () => {
    const trace = await enrichedTrace();
    const letta = toLetta(trace);
    expect(letta.schema).toBe("sessionstorage/trace/1");
    expect(letta.content_hash).toBe(trace.content_hash);
    expect(letta.events).toEqual(trace.events);
    expect(Object.keys(letta)).toEqual([
      "schema",
      "content_hash",
      "source",
      "agent",
      "session_id",
      "started_at",
      "ended_at",
      "records",
      "events",
      "metadata",
    ]);
    const text = JSON.stringify(letta);
    for (const field of ["llm_call", "duration_ms", "msg-", "llm_calls", "provenance"]) {
      expect(text).not.toContain(field);
    }
    // The plain records hash to the same trace.
    expect(parseTrace(letta.records, { metadata: letta.metadata }).content_hash).toBe(
      trace.content_hash,
    );
    expect(renderTrace(trace, "letta")).toEqual(letta);
    expect(renderTrace(trace, "seshi")).toBe(trace);
  });
});

describe("toAtif", () => {
  it("renders steps, tool results as observations and usage as metrics", async () => {
    const trace = await enrichedTrace();
    const atif = toAtif(trace);
    expect(atif).toMatchObject({
      schema_version: "ATIF-v1.7",
      session_id: "sess1",
      agent: { name: "claude-code", version: "unknown" },
      extra: { seshi: { content_hash: trace.content_hash, agent: "claude-code" } },
    });
    expect(atif.steps.map((s) => s.step_id)).toEqual(atif.steps.map((_, i) => i + 1));
    expect(atif.steps.map((s) => s.source)).toEqual(["user", "agent", "agent", "user", "agent"]);
    const call = atif.steps.find((s) => s.tool_calls);
    expect(call?.tool_calls?.[0]).toEqual({
      tool_call_id: "toolu_01AbCdEfGhJkLmNpQr",
      function_name: "Read",
      arguments: { file_path: "/repo/app/auth.ts" },
    });
    expect(call?.observation?.results[0]).toMatchObject({
      source_call_id: "toolu_01AbCdEfGhJkLmNpQr",
    });
    expect(atif.steps[1]?.metrics).toEqual({
      prompt_tokens: 1150,
      completion_tokens: 20,
      cached_tokens: 1000,
    });
    expect(atif.steps[1]?.model_name).toBe("claude-sonnet-4-5");
    expect(atif.final_metrics).toEqual({
      total_prompt_tokens: 1157,
      total_completion_tokens: 23,
      total_cached_tokens: 1000,
      total_steps: atif.steps.length,
    });
  });

  it("reads back through ATIF's own adapter to the same conversation", async () => {
    const trace = await storedTrace();
    const atif: AtifDocument = toAtif(trace);
    const records = ATIF_FORMAT.normalize(JSON.stringify(atif));
    const back = parseTrace(records);
    expect(back.source).toBe(trace.source);
    expect(back.events.map((e) => [e.role, e.text])).toEqual(
      trace.events.map((e) => [e.role, e.text]),
    );
    expect(back.content_hash).toBe(trace.content_hash);
  });

  it("holds reasoning, observations and results that follow a user step", () => {
    const trace = parseTrace([
      { role: "meta", source: "codex", agent_version: "1.2.3" },
      { role: "system", content: "be brief", timestamp: "t0" },
      { role: "user", content: "go", timestamp: "t1" },
      { role: "reasoning", content: "think", timestamp: "t2" },
      { role: "assistant", content: "done", timestamp: "t3" },
      { role: "user", content: "and?", timestamp: "t4" },
      { role: "observation", content: "file changed", timestamp: "t5" },
      { role: "tool", tool_call_id: "x", content: "late", ok: false, timestamp: "t6" },
      { role: "reasoning", content: "trailing", timestamp: "t7" },
    ]);
    const atif = toAtif(trace);
    expect(atif.agent.version).toBe("1.2.3");
    expect(atif.steps.map((s) => [s.source, s.message])).toEqual([
      ["system", "be brief"],
      ["user", "go"],
      ["agent", "done"],
      ["user", "and?"],
      ["agent", ""],
      ["agent", ""],
    ]);
    expect(atif.steps[2]?.reasoning_content).toBe("think");
    expect(atif.steps[4]?.observation?.results).toEqual([
      { content: "file changed" },
      { source_call_id: "x", content: "late", extra: { is_error: true } },
    ]);
    expect(atif.steps[5]?.reasoning_content).toBe("trailing");
    expect(atif.final_metrics).toEqual({ total_steps: 6 });
  });
});
