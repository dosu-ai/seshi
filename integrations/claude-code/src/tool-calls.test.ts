import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalized, onlyMarkers, toolDetail, withoutToolDetail } from "@seshi/formats/testing";
import { TOOL_CALL_MARKER } from "@seshi/kit";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CAPTURE } from "./capture";
import { CLAUDE_CODE_FORMAT } from "./index";
import { redactClaudeToolCalls } from "./tool-calls";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "testdata", "transcripts", name), "utf8");

const ids = { sessionId: "s1", cwd: "/repo/app", gitBranch: "main", version: "2.1.0" };

/** A session with tool content (each string holding `LEAK`) wherever Claude Code keeps it, and
 * what the person and the agent said (`KEPT`). */
const rows: Record<string, unknown>[] = [
  { type: "summary", summary: "KEPT auth walkthrough", leafUuid: "a9" },
  { type: "custom-title", customTitle: "KEPT title", sessionId: "s1" },
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-11-19T00:00:01Z",
    ...ids,
    promptId: "p1",
    message: { role: "user", content: "KEPT how does auth work?" },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-11-19T00:00:02Z",
    ...ids,
    requestId: "req_1",
    wireToolInputs: { toolu_1: { command: "LEAK wire input" } },
    message: {
      role: "assistant",
      id: "msg_1",
      model: "claude-x",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "thinking", thinking: "KEPT reasoning", signature: "sig" },
        { type: "text", text: "KEPT let me look" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "LEAK psql -c 'select'", timeout: 30, flags: ["LEAK -x"] },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "mcp__db__query",
          input: { sql: "LEAK select 1", options: { type: "LEAK typed" } },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: "2026-11-19T00:00:03Z",
    ...ids,
    sourceToolAssistantUUID: "a1",
    toolUseResult: { stdout: "LEAK count 4812", stderr: "", interrupted: false },
    mcpMeta: { structuredContent: { rows: ["LEAK row"] } },
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "LEAK  count\n 4812" },
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          is_error: true,
          content: [
            { type: "text", text: "LEAK permission denied" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "LEAK" } },
          ],
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-11-19T00:00:04Z",
    ...ids,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: { query: "LEAK q" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", url: "LEAK url", title: "LEAK title" }],
        },
        { type: "text", text: "KEPT the query returned rows" },
      ],
    },
  },
  {
    type: "user",
    uuid: "u3",
    timestamp: "2026-11-19T00:00:05Z",
    ...ids,
    isMeta: true,
    sourceToolUseID: "toolu_3",
    message: { role: "user", content: [{ type: "text", text: "LEAK skill body" }] },
  },
  {
    type: "user",
    uuid: "u4",
    timestamp: "2026-11-19T00:00:06Z",
    ...ids,
    message: {
      role: "user",
      content:
        "<bash-input>KEPT git status</bash-input><bash-stdout>LEAK On branch main</bash-stdout><bash-stderr></bash-stderr>",
    },
  },
  {
    type: "user",
    uuid: "u5",
    timestamp: "2026-11-19T00:00:07Z",
    ...ids,
    message: {
      role: "user",
      content: "<task-notification>\n<result>LEAK background output</result>\n</task-notification>",
    },
  },
  {
    type: "attachment",
    uuid: "q1",
    timestamp: "2026-11-19T00:00:08Z",
    ...ids,
    attachment: {
      type: "queued_command",
      prompt: "KEPT also check the changelog",
      commandMode: "prompt",
    },
  },
  {
    type: "attachment",
    uuid: "q2",
    timestamp: "2026-11-19T00:00:09Z",
    ...ids,
    attachment: {
      type: "queued_command",
      prompt: "<task-notification><result>LEAK queued result</result></task-notification>",
      commandMode: "task-notification",
    },
  },
  {
    type: "attachment",
    uuid: "x1",
    timestamp: "2026-11-19T00:00:10Z",
    ...ids,
    attachment: { type: "edited_text_file", filename: "LEAK.ts", snippet: "LEAK code" },
  },
  {
    type: "progress",
    uuid: "p1",
    timestamp: "2026-11-19T00:00:11Z",
    ...ids,
    toolUseID: "toolu_1",
    data: { type: "bash_progress", output: "LEAK partial" },
  },
  {
    type: "system",
    uuid: "sy1",
    timestamp: "2026-11-19T00:00:12Z",
    ...ids,
    subtype: "stop_hook_summary",
    hookInfos: [{ command: "LEAK hook" }],
    content: "LEAK hook output",
  },
  {
    type: "file-history-snapshot",
    messageId: "m1",
    snapshot: { trackedFileBackups: { "LEAK.ts": { backupFileName: "LEAK@v1" } } },
  },
  {
    type: "assistant",
    uuid: "a9",
    timestamp: "2026-11-19T00:00:13Z",
    ...ids,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: "KEPT done" }],
    },
  },
  {
    type: "attachment",
    uuid: "q3",
    timestamp: "2026-11-19T00:00:14Z",
    ...ids,
    attachment: {
      type: "queued_command",
      prompt: [{ type: "text", text: "KEPT a prompt in blocks" }],
      commandMode: "prompt",
    },
  },
];
const session = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("Claude Code's tool-call redaction (capture.redact_tool_calls)", () => {
  const out = redactClaudeToolCalls(session);
  const parsed = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  it("is the capture agent's pass", () => {
    expect(CLAUDE_CODE_CAPTURE.redactToolCalls).toBe(redactClaudeToolCalls);
  });

  it("replaces every string of every tool input and result, wherever the log keeps it", () => {
    expect(out).not.toContain("LEAK");
    expect(out).toContain(TOOL_CALL_MARKER);
  });

  it("keeps the prompts, replies, reasoning and the names of the session", () => {
    for (const kept of session.match(/KEPT[^"<\\]*/g) ?? []) expect(out).toContain(kept);
    expect(parsed[3].message.content[0]).toEqual({
      type: "thinking",
      thinking: "KEPT reasoning",
      signature: "sig",
    });
    expect(parsed[2].message).toEqual({ role: "user", content: "KEPT how does auth work?" });
  });

  it("keeps each call's name and id, their order, and whether each failed", () => {
    const calls = parsed[3].message.content.slice(2);
    expect(calls).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: TOOL_CALL_MARKER, timeout: 30, flags: [TOOL_CALL_MARKER] },
      },
      {
        type: "tool_use",
        id: "toolu_2",
        name: "mcp__db__query",
        input: { sql: TOOL_CALL_MARKER, options: { type: TOOL_CALL_MARKER } },
      },
    ]);
    expect(parsed[4].message.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: TOOL_CALL_MARKER },
      {
        type: "tool_result",
        tool_use_id: "toolu_2",
        is_error: true,
        content: [
          { type: "text", text: TOOL_CALL_MARKER },
          {
            type: "image",
            source: { type: "base64", media_type: TOOL_CALL_MARKER, data: TOOL_CALL_MARKER },
          },
        ],
      },
    ]);
    // The row's copy of the result is replaced whole: its keys can be paths.
    expect(parsed[4].toolUseResult).toBe(TOOL_CALL_MARKER);
    expect(parsed[5].message.content[0]).toMatchObject({ id: "srvtoolu_1", name: "web_search" });
    expect(parsed[4]).toMatchObject({ uuid: "u2", parentUuid: "a1", sessionId: "s1" });
  });

  it("keeps a command the person ran and what kind of input a queued one was", () => {
    expect(parsed[7].message.content).toBe(
      `<bash-input>KEPT git status</bash-input><bash-stdout>${TOOL_CALL_MARKER}</bash-stdout><bash-stderr></bash-stderr>`,
    );
    expect(parsed[8].message.content).toBe(
      `<task-notification>${TOOL_CALL_MARKER}</task-notification>`,
    );
    expect(parsed[10].attachment).toEqual({
      type: "queued_command",
      prompt: `<task-notification>${TOOL_CALL_MARKER}</task-notification>`,
      commandMode: "task-notification",
    });
    expect(parsed[11].attachment.type).toBe("edited_text_file");
    expect(parsed[12]).toMatchObject({ type: "progress", toolUseID: "toolu_1" });
    expect(parsed.at(-1).attachment.prompt).toEqual([
      { type: "text", text: "KEPT a prompt in blocks" },
    ]);
  });

  it("keeps one line per line, so a log redacts as its chunks do", () => {
    expect(out.split("\n")).toHaveLength(session.split("\n").length);
    const lines = session.split("\n");
    const chunks = [lines.slice(0, 4), lines.slice(4, 9), lines.slice(9)].map((l) => l.join("\n"));
    expect(chunks.map(redactClaudeToolCalls).join("\n")).toBe(out);
    expect(redactClaudeToolCalls(out)).toBe(out);
  });

  it("normalizes to the same conversation, with only the tools' detail gone", () => {
    for (const name of ["claude-basic.claude-code.jsonl", "claude-usage.claude-code.jsonl"]) {
      const before = normalized(CLAUDE_CODE_FORMAT, fixture(name));
      const after = normalized(CLAUDE_CODE_FORMAT, redactClaudeToolCalls(fixture(name)));
      expect(withoutToolDetail(after)).toEqual(withoutToolDetail(before));
      expect(toolDetail(before).length).toBeGreaterThan(0);
    }
    const records = normalized(CLAUDE_CODE_FORMAT, out);
    expect(onlyMarkers(toolDetail(records))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("LEAK");
    expect(records.filter((r) => r.role === "tool")).toHaveLength(2);
  });
});
