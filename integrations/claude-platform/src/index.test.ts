import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readExportRequest } from "@seshi/formats";
import type { ReceivedSpan, SpanAttribute } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { anthropicAttributes, claudePlatform, OTLP_GENAI_FORMAT } from "./index";

const FIXTURES = join(import.meta.dirname, "..", "testdata", "otlp");
const text = (name: string) => readFileSync(join(FIXTURES, `${name}.otlp.json`), "utf8");
const spansOf = (name: string) => readExportRequest(JSON.parse(text(name))).groups;
const adapter = OTLP_GENAI_FORMAT.spans;
if (!adapter) throw new Error("otlp-genai takes spans");

const s = (key: string, value: string): SpanAttribute => ({ key, value: { stringValue: value } });
const span = (name: string, attributes: SpanAttribute[], extra: Partial<ReceivedSpan> = {}) => ({
  traceId: "ab".repeat(16),
  spanId: "cd".repeat(8),
  name,
  startTimeUnixNano: "1793527200000000000",
  endTimeUnixNano: "1793527201000000000",
  attributes,
  ...extra,
});

describe("the Claude Platform integration", () => {
  it("provides the otlp-genai format", () => {
    expect(claudePlatform.formats?.map((f) => f.source)).toEqual(["otlp-genai"]);
  });

  it("groups a Managed Agents session's spans by anthropic.session.id, across traces", () => {
    const keys = new Set(
      spansOf("managed-agents-session").flatMap((g) =>
        g.spans.map((sp) => adapter.sessionKey(sp, g.resource)),
      ),
    );
    expect([...keys]).toEqual(["sesn_01JZexample"]);
  });

  it("assembles a Managed Agents session into its conversation", () => {
    const groups = spansOf("managed-agents-session");
    const parts = groups.flatMap((g) => g.spans.map((sp) => adapter.normalize(sp, g.resource)));
    const { records } = adapter.assemble(parts, { source: "otlp-genai" });
    // Read as one document (a log), it says the same, without the LLM calls a log cannot carry.
    expect(OTLP_GENAI_FORMAT.normalize(text("managed-agents-session"))).toEqual(
      records.map((r) => {
        const { llm_call: _call, ...rest } = r as typeof r & { llm_call?: string };
        return rest;
      }),
    );
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(records[3]).toMatchObject({
      tool_calls: [{ id: "sevt_01tooluse", name: "bash", args: '{"command":"bun test auth"}' }],
      llm_call: "10a1b2c3d4e5f603",
    });
    expect(records[4]).toMatchObject({ tool_call_id: "sevt_01tooluse", duration_ms: 4400 });
  });

  it("keeps one copy of a response the SDK and the API both report", () => {
    const groups = spansOf("messages-tool-runner");
    const parts = groups.flatMap((g) => g.spans.map((sp) => adapter.normalize(sp, g.resource)));
    const { records, llm_calls } = adapter.assemble(parts, { source: "otlp-genai" });
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(llm_calls.map((c) => [c.id, c.stop_reason, c.usage?.input_tokens])).toEqual([
      ["b000000000000002", "tool_use", 310],
      ["b000000000000004", "end_turn", 380],
    ]);
  });

  it("finds no content in a metadata-only destination's spans (F4.5)", () => {
    const groups = spansOf("managed-agents-metadata-only");
    expect(groups.flatMap((g) => g.spans).length).toBe(10);
    expect(groups.some((g) => g.spans.some((sp) => adapter.hasContent(sp, g.resource)))).toBe(
      false,
    );
    expect(
      spansOf("managed-agents-session").some((g) =>
        g.spans.some((sp) => adapter.hasContent(sp, g.resource)),
      ),
    ).toBe(true);
  });
});

describe("anthropicAttributes", () => {
  it("records the organization, workspace and end user as account ids", () => {
    const claims = adapter.claims?.(
      span("anthropic.messages.create", [
        s("anthropic.organization.id", "org_1"),
        s("anthropic.workspace.id", "wrk_1"),
        s("user.id", "u-42"),
      ]),
      [],
    );
    expect(claims).toEqual({
      account_ids: {
        "anthropic-org": "org_1",
        "anthropic-workspace": "wrk_1",
        "anthropic-user": "u-42",
      },
    });
    expect(adapter.claims?.(span("x", []), [])).toBeUndefined();
  });

  it("reads a tool span's name and result, and a failed tool", () => {
    const part = adapter.normalize(
      span(
        "anthropic.mcp_tool_use search_issues",
        [
          s("gen_ai.tool.call.id", "mcptoolu_1"),
          s("gen_ai.tool.call.arguments", '{"q":"bug"}'),
          s("anthropic.tool_result.content", '[{"type":"text","text":"none"}]'),
          s("error.type", "tool_error"),
        ],
        { status: { code: 2 } },
      ),
      [],
    );
    expect(part.operation).toBe("execute_tool");
    expect(part.tool).toEqual({
      name: "search_issues",
      call_id: "mcptoolu_1",
      args: '{"q":"bug"}',
      result: "none",
      ok: false,
    });
    expect(part.content).toBe(true);
  });

  it("reads a request's stop reason, request id, thinking and tiers", () => {
    const part = adapter.normalize(
      span("anthropic.messages.create", [
        s("gen_ai.operation.name", "chat"),
        s("gen_ai.request.model", "claude-x"),
        s("anthropic.message.stop_reason", "max_tokens"),
        s("anthropic.request.id", "req_1"),
        s("anthropic.thinking.type", "enabled"),
        { key: "anthropic.thinking.budget_tokens", value: { intValue: 2048 } },
        s("anthropic.request.service_tier", "auto"),
        s("anthropic.response.service_tier", "standard"),
        { key: "gen_ai.usage.input_tokens", value: { intValue: 10 } },
        { key: "anthropic.usage.cache_creation.ephemeral_5m_input_tokens", value: { intValue: 3 } },
        { key: "anthropic.usage.cache_creation.ephemeral_1h_input_tokens", value: { intValue: 4 } },
      ]),
      [],
    );
    expect(part.llm_call).toMatchObject({
      stop_reason: "max_tokens",
      request_id: "req_1",
      usage: { input_tokens: 10, cache_creation_input_tokens: 7 },
      parameters: {
        thinking: "enabled",
        thinking_budget_tokens: 2048,
        service_tier: "auto",
        served_tier: "standard",
      },
    });
  });

  it("writes an outcome evaluation's explanation as an observation", () => {
    const part = adapter.normalize(
      span("anthropic.session.outcome_evaluation", [
        s("anthropic.session.outcome_evaluation.result", "needs_revision"),
        s("anthropic.session.outcome_evaluation.explanation", "Tests still fail."),
      ]),
      [],
    );
    expect(part.content).toBe(true);
    expect(part.output).toEqual([
      {
        role: "observation",
        content: "Outcome evaluation (needs_revision): Tests still fail.",
        timestamp: "2026-11-01T10:00:01.000Z",
      },
    ]);
  });

  it("marks archiving or deleting a session as a final span, unless it failed", () => {
    expect(adapter.normalize(span("anthropic.sessions.archive", []), []).final).toBe(true);
    expect(adapter.normalize(span("anthropic.sessions.delete", []), []).final).toBe(true);
    expect(
      adapter.normalize(span("anthropic.sessions.archive", [], { status: { code: 2 } }), []).final,
    ).toBeUndefined();
    expect(adapter.normalize(span("anthropic.sessions.retrieve", []), []).final).toBeUndefined();
  });

  it("is a mapper named anthropic", () => {
    expect(anthropicAttributes.name).toBe("anthropic");
  });
});
