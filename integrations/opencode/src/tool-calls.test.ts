import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalized, onlyMarkers, toolDetail, withoutToolDetail } from "@seshi/formats/testing";
import { TOOL_CALL_MARKER } from "@seshi/kit";
import { describe, expect, it } from "vitest";
import { OPENCODE_CAPTURE } from "./capture";
import { OPENCODE_FORMAT } from "./index";
import { redactOpencodeToolCalls } from "./tool-calls";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "testdata", "transcripts", name), "utf8");

const ids = (n: number) => ({ id: `prt_${n}`, sessionID: "ses_1", messageID: `msg_${n}` });

/** An export with tool content (`LEAK`) wherever OpenCode keeps it, and what was said (`KEPT`). */
const document = {
  info: {
    id: "ses_1",
    slug: "auth",
    projectID: "p1",
    directory: "/repo/app",
    title: "KEPT auth",
    version: "1.2.0",
    time: { created: 1, updated: 2 },
    revert: { messageID: "msg_2", diff: "LEAK diff" },
  },
  messages: [
    {
      info: {
        id: "msg_1",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1 },
        agent: "build",
        summary: { diffs: [{ file: "LEAK.ts", before: "LEAK old", after: "LEAK new" }] },
      },
      parts: [
        { ...ids(1), type: "text", text: "KEPT how does auth work? @auth.ts" },
        {
          ...ids(2),
          type: "text",
          synthetic: true,
          text: 'Called the Read tool with the following input: {"filePath":"LEAK"}',
        },
        { ...ids(3), type: "file", mime: "text/plain", filename: "LEAK.ts", url: "file://LEAK" },
      ],
    },
    {
      info: {
        id: "msg_2",
        sessionID: "ses_1",
        role: "assistant",
        time: { created: 2, completed: 3 },
        parentID: "msg_1",
        modelID: "m",
        providerID: "p",
        mode: "build",
        path: { cwd: "/repo/app", root: "/repo/app" },
        cost: 0.01,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { ...ids(4), type: "step-start", snapshot: "abc" },
        { ...ids(5), type: "reasoning", text: "KEPT think", time: { start: 1 } },
        { ...ids(6), type: "text", text: "KEPT reading it" },
        {
          ...ids(7),
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { command: "LEAK cat .env", timeout: 5 },
            output: "LEAK SECRET=1",
            title: "LEAK cat .env",
            metadata: { output: "LEAK SECRET=1", exit: 0 },
            time: { start: 1, end: 2 },
            attachments: [{ type: "file", url: "data:LEAK" }],
          },
        },
        {
          ...ids(8),
          type: "tool",
          tool: "read",
          callID: "call_2",
          state: { status: "error", input: { filePath: "LEAK" }, error: "LEAK not found" },
        },
        { ...ids(9), type: "patch", hash: "h", files: ["LEAK.ts"] },
        { ...ids(10), type: "text", text: "KEPT the key is set in .env" },
        { ...ids(11), type: "step-finish", reason: "stop", cost: 0.01 },
      ],
    },
  ],
};
const exported = JSON.stringify(document, null, 2);

describe("OpenCode's tool-call redaction (capture.redact_tool_calls)", () => {
  const out = redactOpencodeToolCalls(exported);
  const parsed = JSON.parse(out);

  it("is the capture agent's pass", () => {
    expect(OPENCODE_CAPTURE.redactToolCalls).toBe(redactOpencodeToolCalls);
  });

  it("replaces every string of every tool's input and output, wherever the export keeps it", () => {
    expect(out).not.toContain("LEAK");
    for (const kept of exported.match(/KEPT[^"\\]*/g) ?? []) expect(out).toContain(kept);
  });

  it("keeps each call's tool, call id, order and status", () => {
    const tools = parsed.messages[1].parts.filter((p: { type: string }) => p.type === "tool");
    expect(tools).toEqual([
      {
        ...ids(7),
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: { command: TOOL_CALL_MARKER, timeout: 5 },
          output: TOOL_CALL_MARKER,
          title: TOOL_CALL_MARKER,
          metadata: TOOL_CALL_MARKER,
          time: { start: 1, end: 2 },
          attachments: TOOL_CALL_MARKER,
        },
      },
      {
        ...ids(8),
        type: "tool",
        tool: "read",
        callID: "call_2",
        state: {
          status: "error",
          input: { filePath: TOOL_CALL_MARKER },
          error: TOOL_CALL_MARKER,
        },
      },
    ]);
    expect(parsed.messages[0].parts[1]).toMatchObject({ synthetic: true, text: TOOL_CALL_MARKER });
    expect(parsed.messages[0].info.summary).toBe(TOOL_CALL_MARKER);
    expect(parsed.messages[1].info).toEqual(document.messages[1]?.info);
  });

  it("normalizes to the same conversation, with only the tools' detail gone", () => {
    const name = "opencode-export.opencode.json";
    const before = normalized(OPENCODE_FORMAT, fixture(name));
    const after = normalized(OPENCODE_FORMAT, redactOpencodeToolCalls(fixture(name)));
    expect(withoutToolDetail(after)).toEqual(withoutToolDetail(before));
    expect(toolDetail(before).length).toBeGreaterThan(0);
    const records = normalized(OPENCODE_FORMAT, out);
    expect(onlyMarkers(toolDetail(records))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("LEAK");
    expect(records.filter((r) => r.role === "tool")).toHaveLength(2);
  });

  it("keeps an integrator's request to leave injected text out", () => {
    const injected = redactOpencodeToolCalls(fixture("opencode-injected.opencode.json"));
    const omitted = JSON.parse(injected)
      .messages.flatMap((m: { parts: unknown[] }) => m.parts)
      .filter((p: { metadata?: { session_capture?: { omit?: boolean } } }) =>
        Boolean(p.metadata?.session_capture?.omit),
      );
    expect(omitted.length).toBeGreaterThan(0);
  });
});
