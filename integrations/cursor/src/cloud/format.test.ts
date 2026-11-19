import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_CLOUD_FORMAT } from ".";
import { eventTime, normalizeCursorCloud, resultText } from "./format";

const FIXTURES = join(import.meta.dirname, "..", "..", "testdata", "cloud");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("cursor-cloud-api", () => {
  it("reads a run and its follow-up into one session", () => {
    const records = normalizeCursorCloud(fixture("followup.jsonl"));
    expect(records[0]).toEqual({
      role: "meta",
      source: "cursor-cloud-api",
      git_branch: "cursor/seshi-trial-ok-e13a",
    });
    const roles = records.slice(1).map((r) => r.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const [, user, call, result, reply, followup] = records;
    expect(user).toMatchObject({ role: "user", timestamp: "2026-11-18T02:17:32.927Z" });
    expect((user as { content: string }).content).toContain("echo seshi-trial-ok");
    expect(call).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "toolu_vrtx_01StiJsmHuh2JTEutH4rYXax", name: "run_terminal_cmd" }],
    });
    const args = JSON.parse((call as { tool_calls: { args: string }[] }).tool_calls[0]?.args ?? "");
    expect(args).toMatchObject({ command: "echo seshi-trial-ok", timeout: 600000 });
    for (const noise of ["toolCallId", "conversationId", "requestId", "parsingResult"]) {
      expect(args).not.toHaveProperty(noise);
    }
    expect(result).toMatchObject({
      role: "tool",
      tool_call_id: "toolu_vrtx_01StiJsmHuh2JTEutH4rYXax",
      content: "seshi-trial-ok\n",
      ok: true,
    });
    expect(reply).toMatchObject({ role: "assistant", content: "done." });
    expect((followup as { content: string }).content).toMatch(/^This is a follow-up\./);
    expect(records.at(-1)).toMatchObject({ role: "assistant", content: "followup done." });
  });

  it("normalizes chunk by chunk to the whole log's records", () => {
    const log = fixture("followup.jsonl");
    const [first, second] = log.split("\n");
    const whole = normalizeCursorCloud(log).slice(1);
    const chunks = [
      ...normalizeCursorCloud(`${first}\n`, { partial: true }),
      ...normalizeCursorCloud(`${second}\n`, { partial: true }),
    ];
    expect(chunks).toEqual(whole);
    const offset = Buffer.byteLength(`${first}\n`);
    expect(CURSOR_CLOUD_FORMAT.normalize(`${second}\n`, { offset, session_id: "x" })).toEqual(
      normalizeCursorCloud(`${second}\n`, { partial: true }),
    );
  });

  it("marks a call that failed, as a cancelled run's shell call does", () => {
    const records = normalizeCursorCloud(fixture("cancelled.jsonl"));
    const result = records.find((r) => r.role === "tool");
    expect(result).toMatchObject({ ok: false });
    expect((result as { content: string }).content).toContain("spawnError");
  });

  it("keeps every tool's result, in the shapes Cursor sends them", () => {
    const records = normalizeCursorCloud(fixture("tools.jsonl"));
    const results = new Map(
      records
        .filter((r) => r.role === "tool")
        .map((r) => [
          (r as { tool_call_id: string }).tool_call_id,
          r as { content: string; ok: boolean },
        ]),
    );
    expect(records.find((r) => r.role === "reasoning")).toMatchObject({
      content: "I'll read the README first.",
    });
    expect(JSON.parse(results.get("toolu_read")?.content ?? "")).toMatchObject({
      contentBlobId: "blob-1",
    });
    expect(results.get("toolu_grep")?.content).toContain("./app/main.py");
    expect(results.get("toolu_edit")?.content).toContain("diffString");
    expect(results.get("toolu_seq")?.content).toMatch(/^\[\.\.\. earlier output omitted/);
    expect(results.get("toolu_seq")?.content).toMatch(/8000\n$/);
    expect(results.get("toolu_fail")).toMatchObject({ ok: false });
    expect(results.get("toolu_fail")?.content).toContain("boom");
    expect(results.get("toolu_task")?.content).toMatch(/\[truncated by Cursor\]$/);
    const seq = records.find(
      (r) =>
        r.role === "assistant" &&
        (r as { tool_calls?: { id: string }[] }).tool_calls?.[0]?.id === "toolu_seq",
    ) as { tool_calls: { args: string }[] };
    expect(JSON.parse(seq.tool_calls[0]?.args ?? "")).toEqual({
      command: "seq 1 8000",
      timeout: 600000,
    });
    expect(records.at(-1)).toMatchObject({ role: "assistant", content: "All done." });
  });

  it("dates records from their events' ids", () => {
    expect(eventTime({ id: "1795000000000-0", event: "x", data: {} })).toBe(
      "2026-11-18T11:06:40.000Z",
    );
    expect(eventTime({ event: "x", data: {} })).toBeUndefined();
  });

  it("reads a result's text", () => {
    expect(resultText({ success: { stdout: "a", stderr: "b" } }, false)).toEqual({
      content: "a\nb",
      ok: true,
    });
    expect(resultText({ success: { interleavedOutput: "x", stdout: "y" } }, false)).toEqual({
      content: "x",
      ok: true,
    });
    expect(resultText({ error: "no" }, false)).toEqual({ content: '{"error":"no"}', ok: false });
  });

  it("refuses a line that is not a run, and an empty conversation", () => {
    expect(() => normalizeCursorCloud('{"role":"user"}\n')).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    const empty = JSON.stringify({
      type: "cursor_cloud_run",
      agent_id: "bc-1",
      run_id: "run-1",
      run: {},
      events: [],
    });
    expect(() => normalizeCursorCloud(`${empty}\n`)).toThrow(
      expect.objectContaining({ code: "missing_user_records" }),
    );
    expect(normalizeCursorCloud(`${empty}\n`, { partial: true })).toEqual([]);
  });

  it("is detected from a run line", () => {
    const row = JSON.parse(fixture("cancelled.jsonl").split("\n")[0] as string);
    expect(CURSOR_CLOUD_FORMAT.detect?.record?.(row)).toBe(true);
    expect(CURSOR_CLOUD_FORMAT.detect?.record?.({ role: "user", message: {} })).toBe(false);
  });
});
