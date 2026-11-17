import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CaptureHost, hookHandler } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extensionPath,
  identifyPiSession,
  locatePiSession,
  PI_CAPTURE,
  piInstaller,
  piSessionsDir,
  sessionIdOfFile,
} from "./capture";
import { EXTENSION_MARKER, piExtension } from "./extension";

const TESTDATA = join(import.meta.dirname, "../testdata");
const payload = (name: string) =>
  JSON.parse(readFileSync(join(TESTDATA, "hooks", `${name}.json`), "utf8"));
const PARENT = "01a1ea89-0000-7000-8000-000000000001";
const FORK = "01a1ea8a-0000-7000-8000-000000000002";
const parentFile = join(
  TESTDATA,
  "sessions",
  "--repo-app--",
  `2026-11-17T09-00-00-000Z_${PARENT}.jsonl`,
);
const forkFile = join(
  TESTDATA,
  "sessions",
  "--repo-app--",
  `2026-11-17T09-05-00-000Z_${FORK}.jsonl`,
);

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-pi-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("pi's hooks, from seshi's extension (F9.2)", () => {
  it("captures the session after each agent run, with the parent a fork names", () => {
    expect(hookHandler(PI_CAPTURE, "Stop")?.parse(payload("Stop"), host)).toEqual({
      captures: [
        {
          session_id: FORK,
          transcript_path: payload("Stop").transcript_path,
          cwd: "/repo/app",
          parent_session_id: PARENT,
        },
      ],
    });
  });

  it("ends the session at SessionEnd, and needs a session id", () => {
    const end = hookHandler(PI_CAPTURE, "SessionEnd")?.parse(payload("Stop"), host);
    expect(end?.captures[0]).toMatchObject({ session_id: FORK, final: true });
    expect(() => hookHandler(PI_CAPTURE, "Stop")?.parse({ cwd: "/x" }, host)).toThrow("session_id");
  });

  it("turns /seshi into a request, a status into an announcement", () => {
    const command = (prompt: string) =>
      hookHandler(PI_CAPTURE, "Command")?.parse({ session_id: "s1", cwd: "/w", prompt }, host);
    const which = { session_id: "s1", cwd: "/w" };
    expect(command("/seshi off")).toEqual({
      captures: [],
      request: { action: "off", session: which },
    });
    expect(command("/seshi on")?.request?.action).toBe("on");
    expect(command("/seshi")).toEqual({ captures: [], announce: which });
    expect(command("/seshi status")).toEqual({ captures: [], announce: which });
    expect(hookHandler(PI_CAPTURE, "Command")?.reply?.("hi")).toEqual({ message: "hi" });
  });
});

describe("pi's session files", () => {
  it("are known by their header: id, folder, start, and a fork's parent", () => {
    expect(identifyPiSession(parentFile, readFileSync(parentFile, "utf8"))).toEqual({
      session_id: PARENT,
      cwd: "/repo/app",
      started_at: "2026-11-17T09:00:00.000Z",
    });
    expect(identifyPiSession(forkFile, readFileSync(forkFile, "utf8"))).toMatchObject({
      session_id: FORK,
      parent_session_id: PARENT,
    });
    expect(identifyPiSession("x.jsonl", '{"type":"message"}\n')).toBeNull();
    expect(identifyPiSession("x.jsonl", "not json")).toBeNull();
    expect(identifyPiSession("x.json", readFileSync(parentFile, "utf8"))).toBeNull();
    expect(sessionIdOfFile(parentFile)).toBe(PARENT);
  });

  it("are found by id, where PI_CODING_AGENT_DIR or PI_CODING_AGENT_SESSION_DIR puts them", () => {
    const agentDir = join(home, "agent");
    cpSync(join(TESTDATA, "sessions"), join(agentDir, "sessions"), { recursive: true });
    const moved = { ...host, env: { PI_CODING_AGENT_DIR: agentDir } };
    expect(piSessionsDir(moved)).toBe(join(agentDir, "sessions"));
    expect(locatePiSession(FORK, moved)).toBe(
      join(agentDir, "sessions", "--repo-app--", `2026-11-17T09-05-00-000Z_${FORK}.jsonl`),
    );
    expect(locatePiSession("missing", moved)).toBeUndefined();
    expect(locatePiSession("../x", moved)).toBeUndefined();
    const sessions = { ...host, env: { PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions") } };
    expect(locatePiSession(PARENT, sessions)).toContain(PARENT);
    expect(piSessionsDir(host)).toBe(join(home, ".pi", "agent", "sessions"));
  });

  it("are what the sweep matches, one folder below sessions/", () => {
    const [path] = PI_CAPTURE.sweep;
    expect(path?.match(`--repo-app--/2026-11-17T09-00-00-000Z_${PARENT}.jsonl`)).toBe(true);
    expect(path?.match("--repo-app--/notes.jsonl")).toBe(false);
    expect(path?.match(`2026-11-17T09-00-00-000Z_${PARENT}.jsonl`)).toBe(false);
    expect(PI_CAPTURE).toMatchObject({ encoding: "jsonl", chunkable: true, format: "pi" });
  });
});

describe("seshi capture install pi", () => {
  const context = () => ({ ...host, command: ["/opt/seshi/bin/seshi"] });

  it("writes the extension once, replaces only its own, and removes it", async () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    expect(piInstaller.detect(host)).toBe(true);
    const path = extensionPath(host);
    expect(await piInstaller.install(context())).toMatchObject({ changed: [path] });
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(`// ${EXTENSION_MARKER} v1`)).toBe(true);
    expect(text).toContain('const SESHI = ["/opt/seshi/bin/seshi"];');
    expect(await piInstaller.install(context())).toEqual({ changed: [], notes: [] });
    expect(await piInstaller.status(context())).toMatchObject({ installed: true, notes: [] });

    const moved = { ...context(), command: ["/usr/local/bin/seshi"] };
    expect((await piInstaller.status(moved)).notes[0]).toContain("out of date");
    expect((await piInstaller.install(moved)).changed).toEqual([path]);

    expect(await piInstaller.uninstall(moved)).toEqual({ changed: [path], notes: [] });
    expect(existsSync(path)).toBe(false);
    expect(await piInstaller.status(moved)).toMatchObject({ installed: false });
  });

  it("leaves a seshi.ts that is someone else's alone", async () => {
    const path = extensionPath(host);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export default function () {}\n");
    const report = await piInstaller.install(context());
    expect(report.changed).toEqual([]);
    expect(report.notes[0]).toContain("not seshi's");
    expect(await piInstaller.uninstall(context())).toEqual({ changed: [], notes: [] });
    expect(readFileSync(path, "utf8")).toBe("export default function () {}\n");
    expect(piInstaller.detect({ ...host, home: join(home, "nobody") })).toBe(false);
  });
});

/** The extension as pi loads it, run against a stand-in for pi's API and a stand-in seshi that
 * records each call. */
describe("the pi extension", () => {
  const FAKE_SESHI = `
const { appendFileSync } = require("node:fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  appendFileSync(process.env.FAKE_SESHI_LOG, JSON.stringify({ args, input, inherited: process.env.SESHI_SESSION_ID ?? null, color: process.env.NO_COLOR ?? null }) + "\\n");
  if (args[0] === "statusline") process.stdout.write("Session Capture ◉\\n");
  if (args[0] === "hook" && args[2] === "Command") process.stdout.write(JSON.stringify({ message: "Session Capture ⏸ · turned off for this session" }) + "\\n");
});
`;

  interface Call {
    args: string[];
    input: string;
    inherited: string | null;
    color: string | null;
  }

  async function load() {
    const fake = join(home, "fake-seshi.cjs");
    writeFileSync(fake, FAKE_SESHI);
    const log = join(home, "calls.jsonl");
    const file = join(home, "extension", "seshi.ts");
    mkdirSync(join(home, "extension"), { recursive: true });
    writeFileSync(file, piExtension([process.execPath, fake]));
    const module = (await import(pathToFileURL(file).href)) as {
      default: (pi: unknown) => void;
    };
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
    module.default({
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
      registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => unknown }) =>
        commands.set(name, def),
    });
    const status: (string | undefined)[] = [];
    const notes: string[] = [];
    const ctx = (file: string | undefined, hasUI = true) => ({
      cwd: home,
      hasUI,
      sessionManager: {
        getSessionFile: () => file,
        getSessionId: () => FORK,
        getHeader: () => ({ type: "session", id: FORK, parentSession: parentFile }),
      },
      ui: {
        setStatus: (_key: string, text: string | undefined) => status.push(text),
        notify: (message: string) => notes.push(message),
      },
    });
    const calls = (): Call[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Call)
        : [];
    return { handlers, commands, ctx, calls, status, notes, log };
  }

  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FAKE_SESHI_LOG;
    process.env.SESHI_SESSION_ID = "the-claude-code-session-pi-was-started-in";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FAKE_SESHI_LOG;
    else process.env.FAKE_SESHI_LOG = saved;
    delete process.env.SESHI_SESSION_ID;
  });

  it("hands each agent run and the session's end to seshi hook pi", async () => {
    const pi = await load();
    process.env.FAKE_SESHI_LOG = pi.log;
    expect([...pi.handlers.keys()].sort()).toEqual([
      "agent_end",
      "session_shutdown",
      "session_start",
    ]);
    await pi.handlers.get("agent_end")?.({}, pi.ctx(forkFile));
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, pi.ctx(forkFile));
    await vi.waitFor(() => expect(pi.calls()).toHaveLength(3));
    const hooks = pi.calls().filter((c) => c.args[0] === "hook");
    expect(hooks.map((c) => c.args)).toEqual([
      ["hook", "pi", "Stop"],
      ["hook", "pi", "SessionEnd"],
    ]);
    expect(JSON.parse(hooks[0]?.input ?? "")).toEqual({
      session_id: FORK,
      transcript_path: forkFile,
      cwd: home,
      parent_session: parentFile,
    });
    // A Claude Code shell's SESHI_SESSION_ID names that session, not pi's.
    expect(pi.calls().every((c) => c.inherited === null)).toBe(true);
  });

  it("shows seshi's status line in the footer, without colour", async () => {
    const pi = await load();
    process.env.FAKE_SESHI_LOG = pi.log;
    await pi.handlers.get("session_start")?.({ reason: "startup" }, pi.ctx(forkFile));
    await vi.waitFor(() => expect(pi.status).toEqual(["Session Capture ◉"]));
    const [call] = pi.calls();
    expect(call?.args).toEqual(["statusline", "--agent", "pi"]);
    expect(JSON.parse(call?.input ?? "")).toEqual({ session_id: FORK, cwd: home });
    expect(call?.color).toBe("1");
  });

  it("runs /seshi through seshi and shows what it said", async () => {
    const pi = await load();
    process.env.FAKE_SESHI_LOG = pi.log;
    await pi.commands.get("seshi")?.handler("off", pi.ctx(forkFile));
    expect(pi.notes).toEqual(["Session Capture ⏸ · turned off for this session"]);
    const [command] = pi.calls();
    expect(command?.args).toEqual(["hook", "pi", "Command"]);
    expect(JSON.parse(command?.input ?? "").prompt).toBe("/seshi off");
  });

  it("does nothing for a session pi keeps no file for, and draws nothing without a UI", async () => {
    const pi = await load();
    process.env.FAKE_SESHI_LOG = pi.log;
    await pi.handlers.get("agent_end")?.({}, pi.ctx(undefined));
    await pi.handlers.get("session_start")?.({}, pi.ctx(forkFile, false));
    await pi.handlers.get("agent_end")?.({}, pi.ctx(forkFile, false));
    await vi.waitFor(() => expect(pi.calls()).toHaveLength(1));
    expect(pi.calls()[0]?.args).toEqual(["hook", "pi", "Stop"]);
    // The session with no file clears the footer; the one without a UI draws nothing.
    expect(pi.status).toEqual([undefined]);
  });

  it("gives up quietly when seshi is missing", async () => {
    const file = join(home, "missing.ts");
    writeFileSync(file, piExtension([join(home, "no-such-seshi")]));
    const module = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    module.default({ on: (n: string, f: never) => handlers.set(n, f), registerCommand: () => {} });
    const status: unknown[] = [];
    await expect(
      handlers.get("agent_end")?.(
        {},
        {
          cwd: home,
          hasUI: true,
          sessionManager: {
            getSessionFile: () => forkFile,
            getSessionId: () => FORK,
            getHeader: () => undefined,
          },
          ui: { setStatus: (_k: string, t: unknown) => status.push(t), notify: () => {} },
        },
      ),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(status).toEqual([undefined]));
  });
});
