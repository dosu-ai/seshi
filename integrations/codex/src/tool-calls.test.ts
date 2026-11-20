import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalized, onlyMarkers, toolDetail, withoutToolDetail } from "@seshi/formats/testing";
import { TOOL_CALL_MARKER } from "@seshi/kit";
import { describe, expect, it } from "vitest";
import { CODEX_CAPTURE } from "./capture";
import { CODEX_FORMAT } from "./index";
import { redactCodexToolCalls } from "./tool-calls";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "testdata", "transcripts", name), "utf8");

const at = (n: number) => `2026-11-19T00:00:${String(n).padStart(2, "0")}.000Z`;
const item = (n: number, payload: Record<string, unknown>) => ({
  timestamp: at(n),
  type: "response_item",
  payload,
});
const event = (n: number, payload: Record<string, unknown>) => ({
  timestamp: at(n),
  type: "event_msg",
  payload,
});

/** A rollout with tool content (`LEAK`) wherever Codex keeps it, and what was said (`KEPT`). */
const rows: Record<string, unknown>[] = [
  {
    timestamp: at(0),
    type: "session_meta",
    payload: { id: "019a0000-0000-7000-8000-000000000001", timestamp: at(0), cwd: "/repo/app" },
  },
  { timestamp: at(0), type: "turn_context", payload: { cwd: "/repo/app", model: "gpt-x" } },
  item(1, {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "KEPT count the customers" }],
  }),
  event(1, { type: "user_message", message: "KEPT count the customers" }),
  item(2, { type: "reasoning", summary: [{ type: "summary_text", text: "KEPT plan" }] }),
  item(3, {
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["LEAK psql", "-c"], timeout_ms: 1000 }),
    call_id: "call_1",
  }),
  event(3, {
    type: "exec_command_end",
    call_id: "call_1",
    stdout: "LEAK 4812",
    aggregated_output: "LEAK 4812",
    exit_code: 0,
  }),
  item(4, {
    type: "function_call_output",
    call_id: "call_1",
    output: JSON.stringify({ output: "LEAK  count\n 4812", metadata: { exit_code: 0 } }),
  }),
  item(5, {
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: "call_2",
    status: "completed",
    input: "*** Begin Patch\n*** Update File: LEAK.ts\n+LEAK code\n*** End Patch",
  }),
  item(6, { type: "custom_tool_call_output", call_id: "call_2", output: "LEAK patch failed" }),
  item(7, {
    type: "function_call",
    name: "mcp__db__query",
    arguments: "LEAK not json",
    call_id: "call_3",
  }),
  item(8, {
    type: "function_call_output",
    call_id: "call_3",
    output: { content: [{ type: "input_text", text: "LEAK row" }], success: false },
  }),
  item(9, { type: "web_search_call", status: "completed", action: { query: "LEAK q" } }),
  event(9, {
    type: "item_completed",
    item: { type: "commandExecution", aggregatedOutput: "LEAK" },
  }),
  {
    timestamp: at(10),
    type: "compacted",
    payload: {
      message: "KEPT summary so far",
      replacement_history: [
        {
          type: "function_call",
          name: "shell",
          arguments: '{"command":["LEAK old"]}',
          call_id: "call_0",
        },
        { type: "function_call_output", call_id: "call_0", output: "LEAK old output" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "KEPT earlier" }] },
      ],
    },
  },
  { timestamp: at(11), type: "world_state", payload: { full: { files: ["LEAK.ts"] } } },
  item(12, {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "KEPT 4812 customers" }],
  }),
  event(12, { type: "agent_message", message: "KEPT 4812 customers" }),
  event(13, { type: "task_complete", last_agent_message: "KEPT 4812 customers" }),
];
const rollout = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("Codex's tool-call redaction (capture.redact_tool_calls)", () => {
  const out = redactCodexToolCalls(rollout);
  const parsed = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  it("is the capture agent's pass", () => {
    expect(CODEX_CAPTURE.redactToolCalls).toBe(redactCodexToolCalls);
  });

  it("replaces every string of every tool input and output, wherever the rollout keeps it", () => {
    expect(out).not.toContain("LEAK");
    for (const kept of rollout.match(/KEPT[^"\\]*/g) ?? []) expect(out).toContain(kept);
    expect(parsed.slice(0, 2)).toEqual(rows.slice(0, 2));
  });

  it("keeps each call's name, call id, order, and numbers in its arguments", () => {
    expect(parsed[5].payload).toEqual({
      type: "function_call",
      name: "shell",
      arguments: JSON.stringify({
        command: [TOOL_CALL_MARKER, TOOL_CALL_MARKER],
        timeout_ms: 1000,
      }),
      call_id: "call_1",
    });
    expect(parsed[6].payload).toEqual({
      type: "exec_command_end",
      call_id: "call_1",
      stdout: TOOL_CALL_MARKER,
      aggregated_output: TOOL_CALL_MARKER,
      exit_code: 0,
    });
    expect(JSON.parse(parsed[7].payload.output)).toEqual({
      output: TOOL_CALL_MARKER,
      metadata: { exit_code: 0 },
    });
    expect(parsed[8].payload).toMatchObject({ name: "apply_patch", input: TOOL_CALL_MARKER });
    expect(parsed[10].payload.arguments).toBe(TOOL_CALL_MARKER);
    expect(parsed[11].payload.output).toEqual({
      content: [{ type: "input_text", text: TOOL_CALL_MARKER }],
      success: false,
    });
    expect(parsed[14].payload.replacement_history[0]).toMatchObject({
      name: "shell",
      call_id: "call_0",
    });
  });

  it("keeps one line per line, so a log redacts as its chunks do", () => {
    const lines = rollout.split("\n");
    const chunks = [lines.slice(0, 6), lines.slice(6, 13), lines.slice(13)].map((l) =>
      l.join("\n"),
    );
    expect(chunks.map(redactCodexToolCalls).join("\n")).toBe(out);
    expect(redactCodexToolCalls(out)).toBe(out);
  });

  it("normalizes to the same conversation, with only the tools' detail gone", () => {
    for (const name of ["codex-usage.codex.jsonl", "codex-subagent-report.codex.jsonl"]) {
      const before = normalized(CODEX_FORMAT, fixture(name));
      const after = normalized(CODEX_FORMAT, redactCodexToolCalls(fixture(name)));
      // A call's id is its byte position in the log (codex-calls.ts), which redaction moves.
      const same = (records: typeof before) =>
        withoutToolDetail(records).map(({ llm_call: _call, ...r }) => r);
      expect(same(after)).toEqual(same(before));
    }
    const records = normalized(CODEX_FORMAT, out);
    expect(onlyMarkers(toolDetail(records))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("LEAK");
    expect(records.filter((r) => r.role === "tool").length).toBeGreaterThanOrEqual(3);
  });
});
