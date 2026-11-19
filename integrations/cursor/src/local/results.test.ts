import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureHost, hookHandler, keptSessionDir } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_FORMAT } from "./adapter";
import { CURSOR_CAPTURE } from "./capture";
import {
  capText,
  composeCursorTranscript,
  cursorComposer,
  type KeptResult,
  keptResult,
  RESULT_MAX_CHARS,
} from "./results";

const HOOKS = join(import.meta.dirname, "../../testdata/hooks");

interface NormalizedRecord {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; name: string; args: string }[];
  tool_call_id?: string;
  ok?: boolean;
}

interface Recorded {
  event: string;
  payload: Record<string, unknown>;
}

/** A recorded session: its hooks in the order they ran, and Cursor's transcript of it. */
function recorded(name: string): { hooks: Recorded[]; lines: string[]; id: string } {
  const hooks = readFileSync(join(HOOKS, name, "hooks.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Recorded);
  const lines = readFileSync(join(HOOKS, name, "transcript.jsonl"), "utf8")
    .trim()
    .split("\n");
  return { hooks, lines, id: hooks[0]?.payload.conversation_id as string };
}

let home: string;
let host: CaptureHost;
let transcript: string;
let n: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-cursor-results-"));
  host = { env: {}, home, platform: "linux" };
  transcript = join(home, "transcript.jsonl");
  n = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** What `seshi hook cursor <event>` keeps for a payload, written as the hook writes it. */
function keep({ event, payload }: Recorded): void {
  const parsed = hookHandler(CURSOR_CAPTURE, event)?.parse(payload, host);
  const result = parsed?.toolResult;
  if (!result) return;
  const dir = keptSessionDir(host, "cursor", result.session.session_id) as string;
  mkdirSync(join(dir, "results"), { recursive: true });
  const name = `${String(++n).padStart(14, "0")}-test.json`;
  writeFileSync(join(dir, "results", name), JSON.stringify(result.entry));
}

const compose = (id: string) => composeCursorTranscript(id, transcript, host);
const records = (path: string) =>
  CURSOR_FORMAT.normalize(readFileSync(path, "utf8")) as NormalizedRecord[];

/** Each tool call, by name and input, with the content of the result answering it. */
function answered(recs: NormalizedRecord[]): { name: string; args: string; result?: string }[] {
  const results = new Map(
    recs.filter((r) => r.role === "tool").map((r) => [r.tool_call_id, r.content as string]),
  );
  return recs
    .flatMap((r) => r.tool_calls ?? [])
    .map((c) => ({
      name: c.name,
      args: c.args,
      ...(results.has(c.id) ? { result: results.get(c.id) } : {}),
    }));
}

describe("what a result hook keeps", () => {
  const session = recorded("session-1");
  const of = (event: string, tool?: string, nth = 0) =>
    session.hooks.filter(
      (h) => h.event === event && (tool === undefined || h.payload.tool_name === tool),
    )[nth] as Recorded;

  it("is the shell's output, an MCP tool's text, a failure's message, a read file's text", () => {
    expect(keptResult("postToolUse", of("postToolUse", "Shell").payload)).toMatchObject({
      tool: "Shell",
      key: "echo hello-from-shell && ls",
      text: "hello-from-shell\nb.txt\nbig.txt\nnotes.txt\n",
    });
    expect(keptResult("postToolUse", of("postToolUse", "MCP:probe_echo").payload)).toMatchObject({
      text: "ECHO:PING",
      key: '{"text":"ping"}',
    });
    expect(keptResult("postToolUseFailure", of("postToolUseFailure").payload)).toMatchObject({
      text: "ls: /does-not-exist: No such file or directory",
      error: true,
    });
    // postToolUse gives a Read only the file's length; beforeReadFile gives its text.
    expect(keptResult("postToolUse", of("postToolUse", "Read").payload)?.text).toContain(
      '"content_length":147',
    );
    expect(keptResult("beforeReadFile", of("beforeReadFile").payload)).toMatchObject({
      key: "/Users/dev/code/app/notes.txt",
      text: expect.stringContaining("alpha line one\n"),
    });
  });

  it("is cut in the middle past its cap, saying how much went", () => {
    const seq = keptResult(
      "postToolUse",
      session.hooks.find(
        (h) => (h.payload.tool_input as { command?: string })?.command === "seq 1 8000",
      )?.payload as Record<string, unknown>,
    ) as KeptResult;
    expect(seq.text.length).toBeLessThan(RESULT_MAX_CHARS + 100);
    expect(seq.text.startsWith("1\n2\n3\n")).toBe(true);
    expect(seq.text.endsWith("7999\n8000\n")).toBe(true);
    expect(seq.cut).toBeGreaterThan(0);
    expect(seq.text).toContain(`[… ${seq.cut} characters cut by seshi …]`);
    // Never in half a surrogate pair.
    const emoji = "😀".repeat(20);
    const cut = capText(emoji, 9);
    expect(cut.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("is nothing for a read Cursor makes for itself (no tool id), and nothing for other hooks", () => {
    const { tool_use_id: _, ...own } = of("beforeReadFile").payload;
    expect(hookHandler(CURSOR_CAPTURE, "beforeReadFile")?.parse(own, host)).toEqual({
      captures: [],
    });
    expect(keptResult("afterShellExecution", of("postToolUse").payload)).toBeUndefined();
  });

  it("names the session and its folder, and spools nothing", () => {
    expect(
      hookHandler(CURSOR_CAPTURE, "postToolUse")?.parse(of("postToolUse").payload, host),
    ).toMatchObject({
      captures: [],
      toolResult: {
        session: { session_id: session.id, cwd: "/Users/dev/code/app" },
        entry: { event: "postToolUse", tool: "Shell" },
      },
    });
  });
});

describe("the upload composed from the transcript and the kept results", () => {
  it("puts each result after its call, matched in order: parallel reads, a StrReplace, MCP", () => {
    const { hooks, lines, id } = recorded("session-1");
    for (const h of hooks) keep(h);
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    const calls = answered(records(compose(id)));
    expect(calls.map((c) => [c.name, c.result?.slice(0, 25)])).toEqual([
      ["Shell", "hello-from-shell\nb.txt\nbi"],
      ["Read", "alpha line one\nalpha line"],
      ["Read", "beta file\n"],
      ["Read", "alpha line one\nalpha line"],
      ["StrReplace", '{"file_path":"/Users/dev/'],
      ["CallDynamicTool", "ECHO:PING"],
      ["Shell", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n1"],
      ["Read", "line 0 yyyyyyyyyyyyyyyyyy"],
      ["Shell", "ls: /does-not-exist: No s"],
    ]);
    const recs = records(cursorComposer.path(id, host) as string);
    expect(recs.filter((r) => r.role === "tool").at(-1)).toMatchObject({ ok: false });
  });

  it("matches calls by what they ran on, whatever order their results came in", () => {
    const { hooks, lines, id } = recorded("session-2");
    for (const h of hooks) keep(h);
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    const calls = answered(records(compose(id)));
    expect(calls.map((c) => [c.name, JSON.parse(c.args).command, c.result])).toEqual([
      ["Glob", undefined, '{"pattern":"","success":true}'],
      ["Grep", undefined, '{"pattern":"alpha","success":true}'],
      // Run in parallel: the slow one is first in the transcript, its result came second.
      ["Shell", "sleep 3; echo slow", "slow\n"],
      ["Shell", "echo fast", "fast\n"],
      ["Write", undefined, '{"file_path":"/Users/dev/code/app/new.txt","success":true}'],
      ["GetDynamicTools", undefined, undefined],
      ["CallDynamicTool", undefined, '{"file_path":"/Users/dev/code/app/new.txt","deleted":true}'],
      ["GetDynamicTools", undefined, undefined],
      ["CallDynamicTool", undefined, expect.stringContaining('"status":"success"')],
      ["Shell", "printenv HOME", "/Users/dev\n"],
    ]);
  });

  it("only appends: line by line it comes out as the whole does, and twice adds nothing", () => {
    const { hooks, lines, id } = recorded("session-1");
    for (const h of hooks) keep(h);
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    const whole = readFileSync(compose(id), "utf8");
    rmSync(keptSessionDir(host, "cursor", id) as string, { recursive: true });

    n = 0;
    writeFileSync(transcript, "");
    // As Cursor runs it: the hooks of a line's calls (one tool id each) run before it writes the
    // line, and the uploader may compose between any two lines, or while a line is half written.
    const byCall = new Map<string, Recorded[]>();
    for (const h of hooks) {
      const call = h.payload.tool_use_id as string | undefined;
      if (call) byCall.set(call, [...(byCall.get(call) ?? []), h]);
    }
    const calls = [...byCall.values()];
    let previous = "";
    for (const line of lines) {
      const blocks = JSON.parse(line).message?.content ?? [];
      const uses = blocks.filter((b: { type?: string }) => b.type === "tool_use").length;
      for (const h of calls.splice(0, uses).flat()) keep(h);
      appendFileSync(transcript, `${line}\n{"role":"assistant","message":{"con`);
      const now = readFileSync(compose(id), "utf8");
      expect(now.startsWith(previous)).toBe(true);
      previous = now;
      writeFileSync(transcript, readFileSync(transcript, "utf8").replace(/\{"role[^\n]*$/, ""));
    }
    expect(calls).toEqual([]);
    expect(readFileSync(compose(id), "utf8")).toBe(whole);
    // Again, with nothing new: nothing added.
    expect(readFileSync(compose(id), "utf8")).toBe(whole);
  });

  it("answers a StrReplace with its write, whichever of its hooks sorts last", () => {
    const { hooks, lines, id } = recorded("session-1");
    const edit = hooks.find((h) => h.payload.tool_name === "Write")?.payload.tool_use_id;
    const own = hooks.filter((h) => h.payload.tool_use_id === edit);
    expect(own.map((h) => [h.event, h.payload.tool_name])).toEqual([
      ["beforeReadFile", undefined],
      ["postToolUse", "Read"],
      ["postToolUse", "Write"],
    ]);
    // Two hooks in one microsecond are listed in either order.
    for (const h of [...own].reverse()) keep(h);
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    const strReplace = answered(records(compose(id))).find((c) => c.name === "StrReplace");
    expect(strReplace?.result).toBe('{"file_path":"/Users/dev/code/app/notes.txt","success":true}');
  });

  it("keeps the transcript's own bytes where it adds nothing", () => {
    const { lines, id } = recorded("session-1");
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    expect(readFileSync(compose(id), "utf8")).toBe(readFileSync(transcript, "utf8"));
  });

  it("lets go of a result that came after its call was composed, and goes on appending", () => {
    const { hooks, lines, id } = recorded("session-1");
    const late = hooks.find((h) => h.payload.tool_name === "MCP:probe_echo") as Recorded;
    for (const h of hooks) if (h !== late) keep(h);
    const upTo = lines.findIndex((l) => l.includes("CallDynamicTool")) + 1;
    writeFileSync(transcript, `${lines.slice(0, upTo).join("\n")}\n`);
    const first = readFileSync(compose(id), "utf8");
    keep(late);
    appendFileSync(transcript, `${lines.slice(upTo).join("\n")}\n`);
    const next = readFileSync(compose(id), "utf8");
    expect(next.startsWith(first)).toBe(true);
    const mcp = answered(records(compose(id))).find((c) => c.name === "CallDynamicTool");
    expect(mcp?.result).toBeUndefined();
    expect(next).not.toContain('"content":"ECHO:PING"');
  });

  it("starts over when Cursor rewrites the transcript, and when its own file was cut short", () => {
    const { hooks, lines, id } = recorded("session-1");
    for (const h of hooks) keep(h);
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    const whole = readFileSync(compose(id), "utf8");
    const out = cursorComposer.path(id, host) as string;
    // Written but not recorded (the uploader died between the two): written again, the same.
    appendFileSync(out, "half a line");
    expect(readFileSync(compose(id), "utf8")).toBe(whole);
    // Cursor rewrote the transcript (a restored checkpoint): composed again from its start.
    writeFileSync(transcript, `${lines.slice(0, 2).join("\n")}\n`);
    const again = readFileSync(compose(id), "utf8");
    expect(whole.startsWith(again)).toBe(true);
    expect(again).toContain("hello-from-shell\\nb.txt");
  });

  it("is the transcript itself for an unusable id, and nothing before it is written", () => {
    writeFileSync(transcript, "");
    expect(composeCursorTranscript("../x", transcript, host)).toBe(transcript);
    expect(cursorComposer.path("abc", host)).toBeUndefined();
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});
