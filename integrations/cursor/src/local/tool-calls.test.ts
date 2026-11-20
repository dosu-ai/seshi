import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalized, onlyMarkers, toolDetail, withoutToolDetail } from "@seshi/formats/testing";
import { type CaptureHost, hookHandler, keptSessionDir, TOOL_CALL_MARKER } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_FORMAT } from "./adapter";
import { CURSOR_CAPTURE } from "./capture";
import { composeCursorTranscript, cursorComposer } from "./results";
import { redactCursorToolCalls } from "./tool-calls";

const SESSION = join(import.meta.dirname, "../../testdata/hooks/session-1");

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-cursor-redact-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The file seshi uploads for the recorded session: its transcript with the results its hooks
 * kept added after each call (#42). */
function composed(): string {
  const hooks = readFileSync(join(SESSION, "hooks.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown> });
  let n = 0;
  for (const { event, payload } of hooks) {
    const result = hookHandler(CURSOR_CAPTURE, event)?.parse(payload, host)?.toolResult;
    if (!result) continue;
    const dir = keptSessionDir(host, "cursor", result.session.session_id) as string;
    mkdirSync(join(dir, "results"), { recursive: true });
    writeFileSync(
      join(dir, "results", `${String(++n).padStart(14, "0")}-t.json`),
      JSON.stringify(result.entry),
    );
  }
  const id = hooks[0]?.payload.conversation_id as string;
  const transcript = join(home, "transcript.jsonl");
  writeFileSync(transcript, readFileSync(join(SESSION, "transcript.jsonl")));
  composeCursorTranscript(id, transcript, host);
  return readFileSync(cursorComposer.path(id, host) as string, "utf8");
}

describe("Cursor's tool-call redaction (capture.redact_tool_calls)", () => {
  it("is the capture agent's pass", () => {
    expect(CURSOR_CAPTURE.redactToolCalls).toBe(redactCursorToolCalls);
  });

  it("replaces the calls' inputs and the results the hooks kept, keeping names, ids and failures", () => {
    const upload = composed();
    const out = redactCursorToolCalls(upload);
    // What the shell printed, a file read, and the failure's message.
    const leaks = ["b.txt\\nbig.txt", "alpha line one", "No such file", "1\\n2\\n3"];
    for (const leaked of leaks) {
      expect(upload).toContain(leaked);
      expect(out).not.toContain(leaked);
    }
    // The person's words and the agent's are kept.
    expect(out).toContain("This is a hook-recording test.");
    expect(out).toContain("I'm working through the user's exact steps");

    const before = normalized(CURSOR_FORMAT, upload);
    const after = normalized(CURSOR_FORMAT, out);
    expect(withoutToolDetail(after)).toEqual(withoutToolDetail(before));
    expect(onlyMarkers(toolDetail(after))).toBe(true);
    const tools = after.filter((r) => r.role === "tool");
    expect(tools).toHaveLength(9);
    expect(tools.at(-1)).toMatchObject({ ok: false });
    const calls = after.flatMap((r) => ("tool_calls" in r ? (r.tool_calls ?? []) : []));
    expect(calls.map((c) => c.name)).toEqual([
      "Shell",
      "Read",
      "Read",
      "Read",
      "StrReplace",
      "CallDynamicTool",
      "Shell",
      "Read",
      "Shell",
    ]);
  });

  it("keeps one line per line, so a log redacts as its chunks do", () => {
    const upload = composed();
    const out = redactCursorToolCalls(upload);
    const lines = upload.split("\n");
    expect(out.split("\n")).toHaveLength(lines.length);
    const half = Math.floor(lines.length / 2);
    expect(
      [lines.slice(0, half), lines.slice(half)]
        .map((l) => redactCursorToolCalls(l.join("\n")))
        .join("\n"),
    ).toBe(out);
  });

  it("blanks a block or field it does not know", () => {
    expect(redactCursorToolCalls('{"type":"turn_ended","status":"success"}')).toBe(
      '{"type":"turn_ended","status":"success"}',
    );
    const line = JSON.stringify({
      role: "assistant",
      extra: { path: "/secret" },
      message: {
        content: [
          { type: "text", text: "kept" },
          { type: "future_block", body: "/secret" },
        ],
      },
    });
    expect(JSON.parse(redactCursorToolCalls(line))).toEqual({
      role: "assistant",
      extra: TOOL_CALL_MARKER,
      message: {
        content: [
          { type: "text", text: "kept" },
          { type: "future_block", body: TOOL_CALL_MARKER },
        ],
      },
    });
  });
});
