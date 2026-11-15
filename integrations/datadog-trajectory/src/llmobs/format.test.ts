import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HeadValue, NormalizedRecord, SpanPart } from "@seshi/model";
import { describe, expect, it } from "vitest";
import type { DatadogSpan } from "./api-types";
import {
  assembleDatadogParts,
  DATADOG_LLMOBS,
  DATADOG_LLMOBS_FORMAT,
  DATADOG_SPANS,
  datadogClaims,
  datadogPart,
  mergeCalls,
  spansOfDocument,
} from "./format";
import { toReceivedSpan } from "./spans";

const FIXTURES = join(import.meta.dirname, "..", "..", "testdata", "llmobs");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const spansOf = (...names: string[]) =>
  names.flatMap((name) => spansOfDocument(JSON.parse(fixture(name))));
const SESSION = "8f14e45f-ceea-4e7a-9d1b-2b6a1f0c3d11";

const TRACE = "6916fdc000000000a1b2c3d4e5f60718";
let n = 0;
/** A Datadog span starting `ms` after 10:00:00, lasting `dur` ms. */
const dd = (ms: number, dur: number, extra: Partial<DatadogSpan> = {}): DatadogSpan => ({
  span_id: String(++n + 1000),
  trace_id: TRACE,
  parent_id: "undefined",
  start_ns: (Date.parse("2026-11-14T10:00:00Z") + ms) * 1_000_000,
  duration: dur * 1_000_000,
  tags: ["trajectory.session_id:s"],
  ...extra,
});
const part = (span: DatadogSpan) => datadogPart(toReceivedSpan(span));
const semantic = (type: string) => ["trajectory.session_id:s", `trajectory.semantic_type:${type}`];
const assemble = (parts: SpanPart[]) => assembleDatadogParts(parts, { source: DATADOG_LLMOBS });
const said = (records: NormalizedRecord[]) =>
  records.map((r) => {
    const x = r as { role: string; content?: unknown; tool_calls?: { name: string }[] };
    return x.tool_calls
      ? `${x.role}:${x.tool_calls.map((c) => c.name).join(",")}`
      : `${x.role}:${x.content ?? ""}`;
  });

describe("datadogPart", () => {
  it("reads a turn root's prompt and answer, and its totals as an LLM call", () => {
    const p = part(
      dd(0, 30_000, {
        name: "turn",
        span_kind: "agent",
        tags: semantic("turn"),
        input: { value: "Fix it" },
        output: { value: "Fixed." },
        metrics: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }),
    );
    expect(p).toMatchObject({
      operation: "turn",
      content: true,
      status: "unset",
      input: [{ role: "user", content: "Fix it" }],
      output: [{ role: "assistant", content: "Fixed." }],
      llm_call: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    });
  });

  it("reads messages: text, tool calls, tool results and thinking", () => {
    const p = part(
      dd(0, 1000, {
        span_kind: "llm",
        input: {
          messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Hi" },
            {
              role: "tool",
              tool_results: [{ name: "ls", result: "[1, 2]", tool_id: "t1" }],
            },
          ],
        },
        output: {
          messages: [
            { role: "thinking", content: "Hmm." },
            {
              role: "assistant",
              content: "Listing.",
              tool_calls: [{ name: "ls", arguments: { path: "." }, tool_id: "t2" }],
            },
          ],
        },
      }),
    );
    expect(p.input).toEqual([
      { role: "system", content: "Be brief.", timestamp: p.started_at },
      { role: "user", content: "Hi", timestamp: p.started_at },
      { role: "tool", tool_call_id: "t1", content: "[1, 2]", timestamp: p.started_at },
    ]);
    expect(p.output).toEqual([
      { role: "reasoning", content: "Hmm.", timestamp: p.ended_at },
      {
        role: "assistant",
        content: "Listing.",
        tool_calls: [{ id: "t2", name: "ls", args: '{"path":"."}' }],
        timestamp: p.ended_at,
      },
    ]);
    // An LLM span is a model request even without token counts.
    expect(p.llm_call?.id).toBe(p.span_id);
  });

  it("reads a tool span's call id, input, result and failure", () => {
    const p = part(
      dd(0, 1500, {
        name: "Bash",
        span_kind: "tool",
        status: "error",
        input: { value: '{"command":"ls"}' },
        output: { value: "boom" },
        metadata: { tool_use_id: "toolu_1" },
      }),
    );
    expect(p).toMatchObject({
      operation: "tool",
      status: "error",
      tool: {
        name: "Bash",
        call_id: "toolu_1",
        args: '{"command":"ls"}',
        result: "boom",
        ok: false,
      },
    });
    expect(p.input).toBeUndefined();
    expect(p.llm_call).toBeUndefined();
    // The name in metadata wins; a plain-text input stays text.
    expect(
      part(
        dd(0, 1, {
          name: "x",
          span_kind: "tool",
          input: { value: "ls -la" },
          metadata: { tool_name: "Shell" },
        }),
      ).tool,
    ).toEqual({ name: "Shell", args: "ls -la" });
  });

  it("reads a compaction as an observation, and a permission wait as nothing", () => {
    expect(
      part(
        dd(0, 1, {
          span_kind: "task",
          tags: semantic("compaction"),
          output: { value: "Summary." },
        }),
      ).output,
    ).toMatchObject([{ role: "observation", content: "Summary." }]);
    const wait = part(
      dd(0, 1, { span_kind: "task", tags: semantic("permission_wait"), input: { value: "x" } }),
    );
    expect(wait.operation).toBe("permission_wait");
    expect(wait.input).toBeUndefined();
  });

  it("names the model call's model, usage, stop reason, parameters and error", () => {
    const p = part(
      dd(0, 2000, {
        span_kind: "llm",
        status: "error",
        model_name: "claude-sonnet-4-5",
        model_provider: "anthropic",
        metadata: {
          finish_reason: "max_tokens",
          request_id: "req_1",
          temperature: 0.5,
          max_tokens: 100,
          ignored: { nested: true },
          "error.type": "overloaded_error",
          "error.message": "Overloaded",
        },
        metrics: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 80,
          cache_write_input_tokens: 5,
          reasoning_output_tokens: 7,
          total_tokens: 120,
          estimated_total_cost: 999,
        },
      }),
    );
    expect(p.llm_call).toEqual({
      id: p.span_id,
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      started_at: "2026-11-14T10:00:00.000Z",
      ended_at: "2026-11-14T10:00:02.000Z",
      duration_ms: 2000,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 5,
        reasoning_tokens: 7,
        total_tokens: 120,
      },
      stop_reason: "max_tokens",
      request_id: "req_1",
      parameters: { temperature: 0.5, max_tokens: 100 },
      error: "overloaded_error: Overloaded",
    });
    expect(part(dd(0, 1, { span_kind: "llm", status: "error" })).llm_call?.error).toBe("error");
    expect(
      part(dd(0, 1, { span_kind: "llm", status: "error", metadata: { error: { message: "m" } } }))
        .llm_call?.error,
    ).toBe("m");
  });

  it("names the session's model, the client version and an absolute working folder", () => {
    expect(
      part(
        dd(0, 1, {
          tags: ["trajectory.client_version:2.1.0", "gen_ai.request.model:m1"],
          metadata: { project_dir: "/home/me/repo" },
        }),
      ).meta,
    ).toEqual({ model: "m1", agent_version: "2.1.0", cwd: "/home/me/repo" });
    expect(part(dd(0, 1, { metadata: { project_dir: "repo" } })).meta).toBeUndefined();
  });

  it("says when a span has no content (minimal capture)", () => {
    const span = dd(0, 1, { span_kind: "llm", metrics: { input_tokens: 3 } });
    expect(part(span).content).toBe(false);
    expect(DATADOG_SPANS.hasContent(toReceivedSpan(span), [])).toBe(false);
    expect(DATADOG_SPANS.hasContent(toReceivedSpan(dd(0, 1, { input: { value: "x" } })), [])).toBe(
      true,
    );
  });
});

describe("assembling a Trajectory session", () => {
  const spans = spansOf("trajectory-session.page1.json", "trajectory-session.page2.json").filter(
    (s) => DATADOG_SPANS.sessionKey(s, []) === SESSION,
  );
  const result = () =>
    DATADOG_SPANS.assemble(
      spans.map((s) => DATADOG_SPANS.normalize(s, [])),
      { source: DATADOG_LLMOBS },
    );

  it("writes each turn once: prompt, steps, tool calls and results", () => {
    const { records } = result();
    expect(records[0]).toEqual({
      role: "meta",
      source: DATADOG_LLMOBS,
      model: "claude-sonnet-4-5",
      cwd: "/home/jdoe/src/payments-api",
      agent_version: "2.1.40",
    });
    expect(said(records.slice(1))).toEqual([
      "user:Fix the failing auth test in src/auth.ts",
      "assistant:I'll run the auth tests first to see what fails.",
      "assistant:Bash",
      "tool:1 fail: expired token accepted (src/auth.test.ts:42)",
      "assistant:The expiry comparison is inverted. Fixing it in src/auth.ts.",
      "assistant:Edit",
      "tool:The file src/auth.ts has been updated.",
      "assistant:Fixed: the expiry check was inverted, and the auth tests pass.",
      "user:Now add a test for the refresh path",
      "assistant:Adding a test for token refresh.",
      "assistant:Write",
      "tool:File created successfully at: src/refresh.test.ts",
      "assistant:Bash",
      "tool:TypeError: refresh is not a function",
      "assistant:Added src/refresh.test.ts; it found a missing export, which I fixed.",
      "observation:Earlier: fixed the inverted expiry check in src/auth.ts.",
    ]);
    const tools = records.filter((r) => r.role === "tool") as (NormalizedRecord & {
      tool_call_id: string;
      ok?: boolean;
      duration_ms?: number;
    })[];
    expect(tools.map((t) => [t.tool_call_id, t.ok, t.duration_ms])).toEqual([
      ["toolu_01A", undefined, 4000],
      ["toolu_01B", undefined, 1000],
      ["toolu_02A", undefined, 1000],
      ["toolu_02B", false, 3000],
    ]);
  });

  it("counts each turn's tokens once: the carrier's totals, or the real calls", () => {
    const { records, llm_calls } = result();
    expect(llm_calls.map((c) => c.usage)).toEqual([
      // Turn 1 had no captured call: the synthetic carrier's totals, not the root's as well.
      {
        input_tokens: 5200,
        output_tokens: 410,
        cache_read_input_tokens: 3900,
        cache_creation_input_tokens: 600,
        total_tokens: 5610,
      },
      { input_tokens: 6100, output_tokens: 220, cache_read_input_tokens: 5400, total_tokens: 6320 },
      { input_tokens: 6900, output_tokens: 130, total_tokens: 7030 },
    ]);
    const refs = records
      .filter((r) => (r as { llm_call?: string }).llm_call)
      .map((r) => [
        (r as { content: string }).content.slice(0, 12),
        (r as unknown as { llm_call: string }).llm_call,
      ]);
    expect(refs).toEqual([
      // The totals are named by the turn's last words.
      ["Fixed: the e", llm_calls[0]?.id],
      ["Adding a tes", llm_calls[1]?.id],
      ["Added src/re", llm_calls[2]?.id],
    ]);
    expect(llm_calls[1]).toMatchObject({ stop_reason: "tool_use", parameters: { temperature: 1 } });
  });

  it("is the same whatever order and however often the spans arrive", () => {
    const parts = spans.map((s) => DATADOG_SPANS.normalize(s, []));
    const shuffled = [...parts.slice().reverse(), ...parts.slice(0, 5)];
    expect(DATADOG_SPANS.assemble(shuffled, { source: DATADOG_LLMOBS })).toEqual(result());
  });

  it("keeps a prompt that repeats the previous turn's", () => {
    const turn = (trace: string, at: number, text: string) => [
      part(
        dd(at, 5000, {
          trace_id: trace,
          span_id: `${at + 1}`,
          tags: semantic("turn"),
          input: { value: "continue" },
        }),
      ),
      part(
        dd(at + 1000, 1000, {
          trace_id: trace,
          span_id: `${at + 2}`,
          parent_id: `${at + 1}`,
          tags: semantic("agent_message"),
          output: { value: text },
        }),
      ),
    ];
    const { records } = assemble([
      ...turn("a".repeat(32), 0, "one"),
      ...turn("b".repeat(32), 60_000, "two"),
    ]);
    expect(said(records.slice(1))).toEqual([
      "user:continue",
      "assistant:one",
      "user:continue",
      "assistant:two",
    ]);
  });
});

describe("assembling a turn from what it has", () => {
  const root = (extra: Partial<DatadogSpan> = {}) =>
    dd(0, 10_000, {
      span_id: "1",
      span_kind: "agent",
      tags: semantic("turn"),
      input: { value: "Do it" },
      output: { value: "Done." },
      ...extra,
    });
  const child = (ms: number, extra: Partial<DatadogSpan>) =>
    dd(ms, 1000, { parent_id: "1", ...extra });

  it("uses the root's answer when no agent message spoke", () => {
    const { records, llm_calls } = assemble([
      part(root({ metrics: { input_tokens: 9, output_tokens: 1 } })),
      part(child(1000, { span_kind: "tool", input: { value: "{}" }, output: { value: "ok" } })),
    ]);
    expect(said(records.slice(1))).toEqual([
      "user:Do it",
      "assistant:tool",
      "tool:ok",
      "assistant:Done.",
    ]);
    // The root's totals, named by its answer.
    expect(llm_calls).toHaveLength(1);
    expect(llm_calls[0]?.usage).toEqual({ input_tokens: 9, output_tokens: 1 });
  });

  it("keeps a message's own tool calls when the turn has no tool spans", () => {
    const { records } = assemble([
      part(root()),
      part(
        child(1000, {
          tags: semantic("agent_message"),
          output: {
            messages: [
              {
                role: "assistant",
                content: "Looking.",
                tool_calls: [{ name: "Read", tool_id: "r1", arguments: {} }],
              },
            ],
          },
        }),
      ),
    ]);
    expect(said(records.slice(1))).toEqual(["user:Do it", "assistant:Read"]);
    expect(records[2]).toMatchObject({ content: "Looking." });
  });

  it("takes the prompt from the first captured request when the root has none", () => {
    const { records } = assemble([
      part(root({ input: undefined })),
      part(
        child(500, {
          span_kind: "llm",
          tags: ["trajectory.session_id:s", "trajectory.llm_call:true"],
          input: {
            messages: [
              { role: "user", content: "old" },
              { role: "assistant", content: "old answer" },
              { role: "user", content: "Do it, please" },
            ],
          },
        }),
      ),
      part(child(1000, { tags: semantic("agent_message"), output: { value: "Done." } })),
    ]);
    expect(said(records.slice(1))).toEqual(["user:Do it, please", "assistant:Done."]);
  });

  it("names real calls by the messages that made them, merging extra ones into the last", () => {
    const m1 = child(1000, {
      span_id: "11",
      tags: semantic("agent_message"),
      output: { value: "a" },
    });
    const m2 = child(5000, {
      span_id: "12",
      tags: semantic("agent_message"),
      output: { value: "b" },
    });
    const call = (id: string, ms: number, parent: string, tokens: number) =>
      dd(ms, 500, {
        span_id: id,
        parent_id: parent,
        span_kind: "llm",
        tags: ["trajectory.session_id:s", "trajectory.llm_call:true"],
        metrics: { input_tokens: tokens, output_tokens: 1 },
      });
    const { records, llm_calls } = assemble([
      part(root({ metrics: { input_tokens: 999 } })),
      part(m1),
      part(m2),
      // The agent messages' own counts and a carrier lose to the real calls.
      part(
        child(0, {
          span_kind: "llm",
          tags: ["trajectory.session_id:s", "trajectory.placeholder_llm_span:true"],
          metrics: { input_tokens: 500 },
        }),
      ),
      part(call("21", 6000, "12", 30)),
      part(call("22", 1100, "11", 10)),
      part(call("23", 7000, "12", 40)),
    ]);
    expect(llm_calls.map((c) => c.usage?.input_tokens)).toEqual([10, 70]);
    expect(llm_calls[1]?.usage?.output_tokens).toBe(2);
    const named = records.filter((r) => (r as { llm_call?: string }).llm_call);
    expect(named.map((r) => (r as { content: string }).content)).toEqual(["a", "b"]);
  });

  it("prefers a tier that counts tokens over one that only names a model", () => {
    const { llm_calls } = assemble([
      part(root({ output: undefined })),
      // An agent message that is an LLM span without counts…
      part(
        child(1000, { span_kind: "llm", tags: semantic("agent_message"), output: { value: "a" } }),
      ),
      // …and the carrier of the turn's totals.
      part(
        child(0, {
          span_kind: "llm",
          tags: ["trajectory.session_id:s", "trajectory.placeholder_llm_span:true"],
          output: { value: "a" },
          metrics: { input_tokens: 50 },
        }),
      ),
    ]);
    expect(llm_calls.map((c) => c.usage?.input_tokens)).toEqual([50]);
  });
});

describe("assembling another LLM Observability app", () => {
  it("reads LLM spans' messages against the session's history, and covered tool spans", () => {
    const spans = spansOf("generic-app.json");
    expect(new Set(spans.map((s) => DATADOG_SPANS.sessionKey(s, [])))).toEqual(
      new Set(["chat-42"]),
    );
    const { records, llm_calls } = DATADOG_SPANS.assemble(
      spans.map((s) => DATADOG_SPANS.normalize(s, [])),
      { source: DATADOG_LLMOBS },
    );
    expect(said(records.slice(1))).toEqual([
      "system:You are a support agent.",
      "user:Where is my order 1234?",
      "assistant:lookup_order",
      'tool:{"status":"shipped"}',
      "assistant:Order 1234 shipped yesterday.",
      "user:Thanks! Can I change the address?",
      "assistant:Not once it has shipped, sorry.",
    ]);
    // The tool span adds its duration to the result the next request carried.
    expect(records[4]).toMatchObject({ tool_call_id: "call_1", duration_ms: 300 });
    // Times in milliseconds (as the docs' example answers) read as such.
    expect(records[2]).toHaveProperty("timestamp", "2026-11-14T10:00:00.100Z");
    // The LLM spans' own counts; the workflow's aggregate is not counted again.
    expect(llm_calls.map((c) => c.usage?.total_tokens)).toEqual([420, 540, 715]);
  });

  it("uses the root's input and output when no LLM span carries messages", () => {
    const rootSpan = dd(0, 3000, {
      span_id: "1",
      span_kind: "workflow",
      tags: ["session_id:x"],
      input: { value: "q" },
      output: { value: "a" },
      metrics: { total_tokens: 30 },
    });
    const llm = dd(100, 1000, {
      span_id: "2",
      parent_id: "1",
      span_kind: "llm",
      tags: ["session_id:x"],
      metrics: { total_tokens: 30 },
    });
    const tool = dd(1200, 100, {
      span_id: "3",
      parent_id: "1",
      span_kind: "tool",
      input: { value: "{}" },
      output: { value: "r" },
    });
    const { records, llm_calls } = assemble([part(rootSpan), part(llm), part(tool)]);
    expect(said(records.slice(1))).toEqual(["user:q", "assistant:tool", "tool:r", "assistant:a"]);
    expect(llm_calls).toHaveLength(1);
    expect(llm_calls[0]?.id).toBe(part(llm).span_id);
    // With no LLM span, the root's own counts.
    expect(assemble([part(rootSpan)]).llm_calls.map((c) => c.usage)).toEqual([
      { total_tokens: 30 },
    ]);
  });

  it("leaves out a tool span whose call no message names, when messages name calls", () => {
    const llm = dd(0, 1000, {
      span_id: "2",
      span_kind: "llm",
      input: { messages: [{ role: "user", content: "go" }] },
      output: {
        messages: [{ role: "assistant", content: "", tool_calls: [{ name: "a", tool_id: "c1" }] }],
      },
    });
    const tool = dd(1100, 100, {
      span_id: "3",
      span_kind: "tool",
      input: { value: "{}" },
      output: { value: "r" },
    });
    expect(said(assemble([part(llm), part(tool)]).records.slice(1))).toEqual([
      "user:go",
      "assistant:a",
    ]);
  });
});

describe("mergeCalls", () => {
  it("sums usage and spans the calls' times", () => {
    expect(
      mergeCalls([
        {
          id: "a",
          started_at: "2026-01-01T00:00:01Z",
          ended_at: "2026-01-01T00:00:02Z",
          usage: { input_tokens: 1 },
        },
        {
          id: "b",
          model: "m",
          started_at: "2026-01-01T00:00:00Z",
          ended_at: "2026-01-01T00:00:05Z",
          usage: { input_tokens: 2, output_tokens: 3 },
          stop_reason: "end",
          error: "e",
        },
      ]),
    ).toEqual({
      id: "a",
      model: "m",
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:05Z",
      duration_ms: 5000,
      usage: { input_tokens: 3, output_tokens: 3 },
      stop_reason: "end",
      error: "e",
    });
  });
});

describe("claims", () => {
  it("records the user, emails and GitHub name the tags assert", () => {
    const [span] = spansOf("trajectory-session.page1.json");
    expect(datadogClaims(span as never)).toEqual({
      email: "jdoe@example.com",
      git_email: "jdoe@users.noreply.example.com",
      username: "jdoe",
      account_ids: { github: "jdoe-dev" },
    });
    expect(DATADOG_SPANS.claims?.(toReceivedSpan(dd(0, 1, { tags: [] })), [])).toBeUndefined();
    expect(
      datadogClaims(
        toReceivedSpan(dd(0, 1, { tags: [`trajectory.user_email:${"x".repeat(400)}`] })),
      ),
    ).toBeUndefined();
  });
});

describe("the datadog-llmobs format", () => {
  it("takes span sets and is never chunked", () => {
    expect(DATADOG_LLMOBS_FORMAT.source).toBe("datadog-llmobs");
    expect(DATADOG_LLMOBS_FORMAT.chunkable).toBe(false);
    expect(DATADOG_LLMOBS_FORMAT.spans).toBe(DATADOG_SPANS);
  });

  it("detects a saved Export API answer", () => {
    const head = (entries: [string, HeadValue["kind"]][]) =>
      new Map(entries.map(([k, kind]) => [k, { kind }] as [string, HeadValue]));
    const detect = DATADOG_LLMOBS_FORMAT.detect?.document;
    expect(
      detect?.(
        head([
          ["data", "array"],
          ["meta", "object"],
        ]),
      ),
    ).toBe(true);
    expect(detect?.(head([["data", "array"]]))).toBe(false);
    expect(
      detect?.(
        head([
          ["data", "object"],
          ["meta", "object"],
        ]),
      ),
    ).toBe(false);
  });

  it("reads one session's export whole, without LLM call references", () => {
    const records = DATADOG_LLMOBS_FORMAT.normalize(fixture("generic-app.json"));
    expect(said(records.slice(1))).toContain("assistant:Order 1234 shipped yesterday.");
    expect(records.some((r) => "llm_call" in r)).toBe(false);
  });

  it("leaves out spans of no session, and refuses an export of several", () => {
    const page = JSON.parse(fixture("trajectory-session.page1.json"));
    const one = {
      ...page,
      data: page.data.filter(
        (d: { attributes: { name: string } }) => d.attributes.name !== "nightly-eval",
      ),
    };
    const records = DATADOG_LLMOBS_FORMAT.normalize(JSON.stringify(one));
    expect(said(records)).not.toContain("assistant:No risky commands.");
    const mixed = [...page.data, ...JSON.parse(fixture("generic-app.json")).data];
    expect(() => DATADOG_LLMOBS_FORMAT.normalize(JSON.stringify({ data: mixed }))).toThrow(
      /2 sessions/,
    );
  });

  it("refuses what is not an export", () => {
    expect(() => DATADOG_LLMOBS_FORMAT.normalize("{")).toThrow(/one JSON document/);
    expect(() => DATADOG_LLMOBS_FORMAT.normalize('{"spans": []}')).toThrow(/data list/);
    // Odd items are skipped.
    expect(spansOfDocument({ data: [null, { attributes: { span_id: "1" } }] })).toEqual([]);
  });
});
