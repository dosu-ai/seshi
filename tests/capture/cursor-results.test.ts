/** Tool results in Cursor sessions, end to end: Cursor's result hooks (`postToolUse`,
 * `postToolUseFailure`, `beforeReadFile`), replayed from recorded payloads through `seshi hook
 * cursor <event>`, keep each result beside the session; `seshi daemon` uploads Cursor's transcript
 * with each result after its call, redacted, to a seshi server on 127.0.0.1. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSession, getTrace } from "@seshi/pipeline";
import { archiveId } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";

const OWNER = "alice@acme.com";
const RECORDED = join(import.meta.dirname, "../../integrations/cursor/testdata/hooks");

interface NormalizedRecord {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; name: string; args: string }[];
  tool_call_id?: string;
}

interface Recorded {
  event: string;
  payload: Record<string, unknown>;
}

let server: TestServer;
let machine: Machine;
let project: string;

/** A recorded session on this machine: its hooks with the folder and transcript moved here. */
function session(name: string) {
  const text = (file: string) => readFileSync(join(RECORDED, name, file), "utf8");
  const hooks = text("hooks.jsonl")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Recorded);
  const id = hooks[0]?.payload.conversation_id as string;
  const dir = join(machine.dir, ".cursor", "projects", "code-app", "agent-transcripts", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const move = (value: string) =>
    value.replaceAll("/Users/dev/code/app", project).replaceAll("/Users/dev/", `${machine.dir}/`);
  const lines = text("transcript.jsonl").trim().split("\n").map(move);
  const replay = (h: Recorded) =>
    machine.seshi(["hook", "cursor", h.event], {
      stdin: move(
        JSON.stringify({
          ...h.payload,
          transcript_path: file,
          workspace_roots: [project],
        }),
      ),
    });
  return { id, hooks, lines, file, replay };
}

async function daemon() {
  const run = await machine.seshi(["daemon", "--once", "--json"]);
  return { ...run, summary: run.out ? JSON.parse(run.out) : undefined };
}

/** Every record the server stored for the session, trace by trace. */
async function stored(id: string): Promise<NormalizedRecord[]> {
  const meta = await getSession(server.instance.store, OWNER, "cursor", id);
  if (!meta) return [];
  const out: NormalizedRecord[] = [];
  for (const ref of meta.traces) {
    const trace = await getTrace(
      server.instance.store,
      OWNER,
      archiveId(OWNER, "cursor", id),
      ref.content_hash,
    );
    out.push(...((trace?.records ?? []) as NormalizedRecord[]));
  }
  return out;
}

/** Each stored call with the stored result for it. */
function answered(records: NormalizedRecord[]) {
  const results = new Map<string, string[]>();
  for (const r of records.filter((x) => x.role === "tool")) {
    const id = r.tool_call_id as string;
    results.set(id, [...(results.get(id) ?? []), r.content as string]);
  }
  return records
    .flatMap((r) => r.tool_calls ?? [])
    .map((c) => ({ name: c.name, args: c.args, results: results.get(c.id) ?? [] }));
}

const stateDir = () => join(machine.dir, ".local", "state", "seshi");
const kept = (id: string) => {
  try {
    return readdirSync(join(stateDir(), "kept", "cursor", id, "results"));
  } catch {
    return [];
  }
};

beforeEach(async () => {
  server = await startServer();
  const orgKey = (await server.auth.initAdmin({ owner: "ops" })).org_key?.token as string;
  machine = new Machine();
  const login = await machine.seshi(
    ["login", "--server", server.url, "--key", "-", "--user", OWNER],
    {
      stdin: orgKey,
    },
  );
  expect(login.code, login.err).toBe(0);
  project = join(machine.dir, "code", "app");
  mkdirSync(project, { recursive: true });
});
afterEach(async () => {
  await server.stop();
  machine.cleanup();
});

describe("a Cursor session's tool results", () => {
  it("are uploaded after their calls, the read files' text included, secrets redacted", async () => {
    const s = session("session-1");
    for (const h of s.hooks.filter((h) => h.event !== "sessionEnd")) {
      expect(await s.replay(h)).toEqual({ code: 0, out: "", err: "" });
    }
    // A result hook neither spools nor starts the uploader.
    expect(machine.spawned).toEqual([]);
    expect(kept(s.id).length).toBeGreaterThan(0);
    writeFileSync(s.file, `${s.lines.join("\n")}\n`);
    await s.replay(s.hooks.at(-1) as Recorded);
    expect((await daemon()).summary).toMatchObject({ uploaded: 1, failed: 0 });

    const calls = answered(await stored(s.id));
    expect(calls.map((c) => [c.name, c.results.length])).toEqual([
      ["Shell", 1],
      ["Read", 1],
      ["Read", 1],
      ["Read", 1],
      ["StrReplace", 1],
      ["CallDynamicTool", 1],
      ["Shell", 1],
      ["Read", 1],
      ["Shell", 1],
    ]);
    expect(calls[0]?.results[0]).toBe("hello-from-shell\nb.txt\nbig.txt\nnotes.txt\n");
    expect(calls[2]?.results[0]).toBe("beta file\n");
    expect(calls[5]?.results[0]).toBe("ECHO:PING");
    // The file's text, its key redacted as anywhere else in a session.
    expect(calls[1]?.results[0]).toContain("alpha line one\nalpha line two\n");
    expect(calls[1]?.results[0]).toContain("PROBE_SECRET=[redacted:");
    expect(JSON.stringify(await stored(s.id))).not.toContain("sk-ant-api03-xxxx");
  });

  it("are withheld for a secret command, and for a read of a sensitive file", async () => {
    const s = session("session-2");
    for (const h of s.hooks.filter((h) => h.event !== "sessionEnd")) await s.replay(h);
    // A read of .env: Cursor's Read, as it hooks it, of a file seshi's rules call sensitive.
    const env = join(project, ".env");
    const read = { conversation_id: s.id, tool_use_id: "toolu_01EnvRead", tool_name: "Read" };
    await s.replay({
      event: "beforeReadFile",
      payload: { ...read, file_path: env, content: "DB_PASSWORD=hunter2hunter2\n" },
    });
    await s.replay({
      event: "postToolUse",
      payload: { ...read, tool_input: { file_path: env }, tool_output: '{"content_length":27}' },
    });
    const call = {
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { path: env } }] },
    };
    writeFileSync(
      s.file,
      `${[...s.lines.slice(0, -1), JSON.stringify(call), ...s.lines.slice(-1)].join("\n")}\n`,
    );
    await s.replay(s.hooks.at(-1) as Recorded);
    expect((await daemon()).summary).toMatchObject({ uploaded: 1, failed: 0 });

    const calls = answered(await stored(s.id));
    const printenv = calls.find((c) => JSON.parse(c.args).command === "printenv HOME");
    expect(printenv?.results).toEqual(["[redacted:secret-output]"]);
    expect(calls.find((c) => c.name === "Read")?.results).toEqual(["[redacted:sensitive-file]"]);
    expect(calls.find((c) => JSON.parse(c.args).command === "echo fast")?.results).toEqual([
      "fast\n",
    ]);
    expect(JSON.stringify(await stored(s.id))).not.toContain("hunter2");
  });

  it("pass the doctor's checks, read from the upload they were added to", async () => {
    const s = session("session-1");
    for (const h of s.hooks.filter((h) => h.event !== "sessionEnd")) await s.replay(h);
    writeFileSync(s.file, `${s.lines.join("\n")}\n`);
    await s.replay(s.hooks.at(-1) as Recorded);
    expect((await daemon()).summary).toMatchObject({ uploaded: 1, failed: 0 });
    const run = await machine.seshi(["doctor", "--session", s.id, "--agent", "cursor", "--json"], {
      env: { NO_COLOR: "1" },
    });
    const report = JSON.parse(run.out).sessions[0];
    const by = Object.fromEntries(
      report.checks.map((c: { id: string; status: string; summary: string }) => [c.id, c]),
    );
    for (const id of ["transcript", "offsets", "records", "prefix", "chain"]) {
      expect(by[id]?.status, `${id}: ${by[id]?.summary}`).toBe("ok");
    }
    expect(by.transcript.summary).toContain("with what the hooks kept");
  });

  it("are hooked on a machine that installed Cursor's hooks before them, once reinstalled", async () => {
    mkdirSync(join(machine.dir, ".cursor"));
    expect((await machine.seshi(["capture", "install", "cursor"])).code).toBe(0);
    const file = join(machine.dir, ".cursor", "hooks.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    for (const event of ["postToolUse", "postToolUseFailure", "beforeReadFile"]) {
      delete config.hooks[event];
    }
    writeFileSync(file, JSON.stringify(config));
    const doctor = JSON.parse((await machine.seshi(["doctor", "--json"])).out);
    expect(doctor.hooks).toEqual([
      expect.objectContaining({
        title: "cursor",
        status: "warn",
        summary:
          "hooks missing for postToolUse, postToolUseFailure, beforeReadFile: run seshi capture install cursor",
      }),
    ]);
    expect((await machine.seshi(["capture", "install", "cursor"])).code).toBe(0);
    expect(JSON.parse((await machine.seshi(["doctor", "--json"])).out).hooks).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).hooks)).toEqual(
      expect.arrayContaining(["postToolUse", "postToolUseFailure", "beforeReadFile"]),
    );
  });

  it("go up once: uploading again, or sending the session again, adds none twice", async () => {
    const s = session("session-1");
    for (const h of s.hooks) await s.replay(h);
    writeFileSync(s.file, `${s.lines.join("\n")}\n`);
    await s.replay(s.hooks.at(-1) as Recorded);
    await daemon();
    const before = await stored(s.id);
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    const resend = await machine.seshi([
      "capture",
      "resend",
      "--session",
      s.id,
      "--agent",
      "cursor",
    ]);
    expect(resend.code, resend.err).toBe(0);
    await daemon();
    const after = await stored(s.id);
    const results = (records: NormalizedRecord[]) => records.filter((r) => r.role === "tool");
    expect(results(after)).toHaveLength(9);
    expect(results(after)).toEqual(results(before));
  });

  it("let go of a result kept after its call went up, and the next upload goes on", async () => {
    const s = session("session-1");
    const late = s.hooks.find((h) => h.payload.tool_name === "MCP:probe_echo") as Recorded;
    for (const h of s.hooks.filter((h) => h !== late && h.event !== "sessionEnd")) {
      await s.replay(h);
    }
    const upTo = s.lines.findIndex((l) => l.includes("CallDynamicTool")) + 1;
    writeFileSync(s.file, `${s.lines.slice(0, upTo).join("\n")}\n`);
    await s.replay({ event: "stop", payload: { ...(s.hooks.at(-1) as Recorded).payload } });
    expect((await daemon()).summary).toMatchObject({ uploaded: 1, failed: 0 });
    const first = (await stored(s.id)).length;

    await s.replay(late);
    appendFileSync(s.file, `${s.lines.slice(upTo).join("\n")}\n`);
    await s.replay(s.hooks.at(-1) as Recorded);
    const next = await daemon();
    expect(next.summary).toMatchObject({ uploaded: 1, failed: 0 });
    const records = await stored(s.id);
    expect(records.length).toBeGreaterThan(first);
    const calls = answered(records);
    expect(calls.find((c) => c.name === "CallDynamicTool")?.results).toEqual([]);
    expect(calls.at(-1)?.results).toEqual(["ls: /does-not-exist: No such file or directory"]);
    const log = join(stateDir(), "capture.log");
    if (existsSync(log)) expect(readFileSync(log, "utf8")).not.toMatch(/409|mismatch/);
  });

  it("are not kept for a session turned off, nor in a folder whose repo turns capture off", async () => {
    const s = session("session-1");
    const shell = s.hooks.find((h) => h.payload.tool_name === "Shell") as Recorded;
    await s.replay(shell);
    expect(kept(s.id)).toHaveLength(1);
    const off = await machine.seshi(["capture", "off", "--session", s.id, "--agent", "cursor"]);
    expect(off.code, off.err).toBe(0);
    // Turning it off removed what was kept, and nothing more is.
    expect(existsSync(join(stateDir(), "kept", "cursor", s.id))).toBe(false);
    await s.replay(shell);
    expect(kept(s.id)).toEqual([]);

    // Kept while captured, then the folder is turned off: the next result removes what was kept.
    const fresh = "c0ffee00-5555-4222-8333-444455556666";
    const again = { ...shell, payload: { ...shell.payload, conversation_id: fresh } };
    await s.replay(again);
    expect(kept(fresh)).toHaveLength(1);
    const rule = await machine.seshi(["capture", "off", "--path", project]);
    expect(rule.code, rule.err).toBe(0);
    await s.replay(again);
    expect(existsSync(join(stateDir(), "kept", "cursor", fresh))).toBe(false);
    await machine.seshi(["capture", "on", "--path", project]);

    const other = session("session-2");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".seshi"));
    writeFileSync(join(project, ".seshi", "config.toml"), "capture = false\n");
    for (const h of other.hooks) await other.replay(h);
    expect(existsSync(join(stateDir(), "kept", "cursor", other.id))).toBe(false);
  });

  it("are kept in milliseconds, a large one too", async () => {
    const s = session("session-1");
    const shell = s.hooks.find((h) => h.payload.tool_name === "Shell") as Recorded;
    const big = `${"x".repeat(79)}\n`;
    const output = JSON.stringify({ output: big.repeat(18_000), exitCode: 0 });
    const hook = {
      event: "postToolUse",
      payload: { ...shell.payload, tool_output: output, tool_use_id: "big" },
    };
    await s.replay(hook); // the first run loads seshi's modules
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const run = await s.replay({
        ...hook,
        payload: { ...hook.payload, tool_use_id: `big-${i}` },
      });
      times.push(performance.now() - start);
      expect(run.code).toBe(0);
    }
    times.sort((a, b) => a - b);
    // The median of a 1.4 MB result: the hook reads it, judges the session and writes 32 KB.
    expect(times[2]).toBeLessThan(HOOK_BUDGET_MS);
    const file = kept(s.id).at(-1) as string;
    const entry = JSON.parse(
      readFileSync(join(stateDir(), "kept", "cursor", s.id, "results", file), "utf8"),
    );
    expect(entry.text.length).toBeLessThan(33_000);
    expect(entry.cut).toBeGreaterThan(1_400_000);
  });
});

/** What a result hook may take in-process, beyond starting seshi: Cursor waits for it on every
 * tool call. docs/capture.md gives the whole hook's cost, the process included. */
const HOOK_BUDGET_MS = 100;

describe("a Cursor Cloud hook an earlier seshi committed to a repository", () => {
  it("does nothing: nothing spooled, kept or uploaded", async () => {
    const s = session("session-1");
    const stop = s.hooks.find((h) => h.event === "stop") ?? (s.hooks.at(-1) as Recorded);
    for (const h of [...s.hooks, stop]) {
      const run = await machine.seshi(["hook", "cursor", h.event, "--cloud"], {
        stdin: JSON.stringify({
          ...h.payload,
          transcript_path: s.file,
          workspace_roots: [project],
        }),
      });
      expect(run.code).toBe(0);
      expect(run.out).toBe("");
    }
    expect(kept(s.id)).toEqual([]);
    await daemon();
    expect(await stored(s.id)).toEqual([]);
    expect(readFileSync(join(stateDir(), "capture.log"), "utf8")).toContain(
      "seshi no longer captures through it",
    );
  });
});
