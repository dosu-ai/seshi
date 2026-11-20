import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalized, onlyMarkers, toolDetail, withoutToolDetail } from "@seshi/formats/testing";
import { TOOL_CALL_MARKER } from "@seshi/kit";
import { describe, expect, it } from "vitest";
import { PI_CAPTURE } from "./capture";
import { PI_FORMAT } from "./index";
import { redactPiToolCalls } from "./tool-calls";

const TESTDATA = join(import.meta.dirname, "..", "testdata");
const injected = readFileSync(join(TESTDATA, "transcripts", "pi-injected.pi.jsonl"), "utf8");

const entry = (n: number, rest: Record<string, unknown>) => ({
  id: `e${n}`,
  parentId: n > 1 ? `e${n - 1}` : null,
  timestamp: `2026-11-19T00:00:${String(n).padStart(2, "0")}.000Z`,
  ...rest,
});
const message = (n: number, m: Record<string, unknown>) =>
  entry(n, { type: "message", message: m });

/** A session with tool content (`LEAK`) wherever pi keeps it, and what was said (`KEPT`). */
const rows: Record<string, unknown>[] = [
  {
    type: "session",
    version: 3,
    id: "sess-1",
    timestamp: "2026-11-19T00:00:00.000Z",
    cwd: "/repo",
  },
  entry(1, { type: "model_change", provider: "p", modelId: "m" }),
  message(2, { role: "user", content: [{ type: "text", text: "KEPT why is auth slow?" }] }),
  message(3, {
    role: "assistant",
    model: "m",
    usage: { input: 1, output: 2 },
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "KEPT check the db" },
      { type: "text", text: "KEPT looking" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "LEAK psql", n: 3 } },
    ],
  }),
  message(4, {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "LEAK timeout after 30s" }],
    details: { stdout: "LEAK", exitCode: 1 },
  }),
  message(5, { role: "bashExecution", command: "LEAK ls", output: "LEAK a.txt", exitCode: 0 }),
  entry(6, {
    type: "custom_message",
    customType: "memory",
    content: "LEAK injected file",
    display: false,
    details: { note: "LEAK", session_capture: { omit: true } },
  }),
  entry(7, { type: "compaction", summary: "LEAK summary", details: { readFiles: ["LEAK.ts"] } }),
  entry(8, { type: "custom", customType: "ext", data: { path: "LEAK" } }),
  message(9, { role: "assistant", model: "m", content: [{ type: "text", text: "KEPT done" }] }),
];
const log = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("pi's tool-call redaction (capture.redact_tool_calls)", () => {
  const out = redactPiToolCalls(log);
  const parsed = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  it("is the capture agent's pass", () => {
    expect(PI_CAPTURE.redactToolCalls).toBe(redactPiToolCalls);
  });

  it("replaces every string of every tool call and result, wherever the session keeps it", () => {
    expect(out).not.toContain("LEAK");
    for (const kept of log.match(/KEPT[^"\\]*/g) ?? []) expect(out).toContain(kept);
    expect(parsed.slice(0, 3)).toEqual(rows.slice(0, 3));
  });

  it("keeps each call's name and id, their order, and whether each failed", () => {
    expect(parsed[3].message.content[2]).toEqual({
      type: "toolCall",
      id: "call_1",
      name: "bash",
      arguments: { command: TOOL_CALL_MARKER, n: 3 },
    });
    expect(parsed[4].message).toEqual({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: TOOL_CALL_MARKER }],
      details: TOOL_CALL_MARKER,
    });
    expect(parsed[5].message).toEqual({
      role: "bashExecution",
      command: TOOL_CALL_MARKER,
      output: TOOL_CALL_MARKER,
      exitCode: 0,
    });
    // An extension's text goes; its request to be left out stays.
    expect(parsed[6]).toMatchObject({
      content: TOOL_CALL_MARKER,
      details: { note: TOOL_CALL_MARKER, session_capture: { omit: true } },
    });
  });

  it("keeps one line per line, so a log redacts as its chunks do", () => {
    const lines = log.split("\n");
    const chunks = [lines.slice(0, 4), lines.slice(4)].map((l) => l.join("\n"));
    expect(chunks.map(redactPiToolCalls).join("\n")).toBe(out);
    expect(redactPiToolCalls(out)).toBe(out);
  });

  it("normalizes to the same conversation, with only the tools' detail gone", () => {
    // The recorded session, but for the text its extensions added, which goes.
    const before = normalized(PI_FORMAT, injected);
    const after = normalized(PI_FORMAT, redactPiToolCalls(injected));
    const said = (records: typeof before) =>
      withoutToolDetail(records).filter((r) => !("synthetic" in r));
    expect(said(after)).toEqual(said(before));
    expect(toolDetail(before).length).toBeGreaterThan(0);
    expect(onlyMarkers(toolDetail(after))).toBe(true);
    const records = normalized(PI_FORMAT, out);
    expect(onlyMarkers(toolDetail(records))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("LEAK");
  });
});
