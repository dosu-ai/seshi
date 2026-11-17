import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type CaptureHost, handedTranscriptDir, hookHandler } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandPath,
  identifyOpencodeExport,
  locateOpencodeExport,
  OPENCODE_CAPTURE,
  opencodeConfigDir,
  opencodeInstaller,
  pluginPath,
  UNKNOWN_SESHI,
} from "./capture";
import { OPENCODE_FORMAT } from "./index";
import { COMMAND_MARKER, opencodePlugin, PLUGIN_MARKER } from "./plugin";

const TESTDATA = join(import.meta.dirname, "../testdata");
const payload = (name: string) =>
  JSON.parse(readFileSync(join(TESTDATA, "hooks", `${name}.json`), "utf8"));
const EXPORT = JSON.parse(
  readFileSync(join(TESTDATA, "transcripts", "opencode-export.opencode.json"), "utf8"),
) as { info: { id: string; directory: string }; messages: unknown[] };
const ID = EXPORT.info.id;

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-opencode-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("OpenCode's hooks, from seshi's plugin (F9.2)", () => {
  it("hands the whole session over as its transcript once a turn is over", () => {
    const stop = { session_id: ID, cwd: "/repo/app", export: EXPORT };
    expect(hookHandler(OPENCODE_CAPTURE, "Stop")?.parse(stop, host)).toEqual({
      captures: [{ session_id: ID, cwd: "/repo/app", transcript: JSON.stringify(EXPORT) }],
    });
    // Written with `info` first whatever order it came in, for identify to read from the head.
    const reordered = { ...stop, export: { messages: EXPORT.messages, info: EXPORT.info } };
    const written = hookHandler(OPENCODE_CAPTURE, "Stop")?.parse(reordered, host)?.captures[0];
    expect(written?.transcript).toBe(JSON.stringify(EXPORT));
    const child = { ...stop, session_id: "ses_child", parent_session_id: ID };
    expect(hookHandler(OPENCODE_CAPTURE, "Stop")?.parse(child, host)?.captures[0]).toMatchObject({
      session_id: "ses_child",
      parent_session_id: ID,
    });
  });

  it("needs the export, and a session id", () => {
    const stop = hookHandler(OPENCODE_CAPTURE, "Stop");
    expect(() => stop?.parse({ session_id: ID }, host)).toThrow("no export");
    expect(() => stop?.parse({ session_id: ID, export: { info: {} } }, host)).toThrow("no export");
    expect(() => stop?.parse({ export: EXPORT }, host)).toThrow("session_id");
  });

  it("announces a new session, and turns /seshi into a request", () => {
    const which = { session_id: ID, cwd: "/repo/app" };
    expect(
      hookHandler(OPENCODE_CAPTURE, "SessionStart")?.parse(payload("SessionStart"), host),
    ).toEqual({ captures: [], announce: which });
    const command = hookHandler(OPENCODE_CAPTURE, "Command");
    expect(command?.parse(payload("Command"), host)).toEqual({
      captures: [],
      request: { action: "off", session: which },
    });
    expect(command?.parse({ ...payload("Command"), arguments: "" }, host)).toEqual({
      captures: [],
      announce: which,
    });
    expect(command?.parse({ ...payload("Command"), arguments: "on" }, host)?.request?.action).toBe(
      "on",
    );
    expect(command?.parse({ ...payload("Command"), arguments: "pause 2h" }, host)).toEqual({
      captures: [],
      say: UNKNOWN_SESHI,
    });
    expect(command?.reply?.("hi")).toEqual({ message: "hi" });
  });
});

describe("the sessions seshi was handed", () => {
  const write = () => {
    const dir = handedTranscriptDir(host, "opencode");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${ID}.json`);
    writeFileSync(file, JSON.stringify(EXPORT));
    return file;
  };

  it("are known by their file name and the session's info", () => {
    const file = write();
    expect(identifyOpencodeExport(file, readFileSync(file, "utf8"))).toEqual({
      session_id: ID,
      cwd: "/repo/app",
      started_at: new Date(1790963932400).toISOString(),
    });
    const child = { ...EXPORT, info: { ...EXPORT.info, id: "ses_child", parentID: ID } };
    expect(
      identifyOpencodeExport(join(home, "ses_child.json"), JSON.stringify(child)),
    ).toMatchObject({ session_id: "ses_child", parent_session_id: ID });
    expect(identifyOpencodeExport(join(home, "other.json"), JSON.stringify(EXPORT))).toBeNull();
    // Whatever order info's keys come in, and an id nested before its own.
    const shuffled = {
      info: { share: { id: "share_1" }, directory: "/repo/app", id: ID, time: { created: 1 } },
      messages: [],
    };
    expect(
      identifyOpencodeExport(join(home, `${ID}.json`), JSON.stringify(shuffled)),
    ).toMatchObject({ session_id: ID, cwd: "/repo/app" });
    expect(identifyOpencodeExport(file, '{"messages":[]}')).toBeNull();
  });

  it("are found in seshi's capture folder, which the sweep reads", () => {
    const file = write();
    expect(file).toBe(
      join(home, ".local", "state", "seshi", "transcripts", "opencode", `${ID}.json`),
    );
    expect(locateOpencodeExport(ID, host)).toBe(file);
    expect(locateOpencodeExport("ses_missing", host)).toBeUndefined();
    expect(locateOpencodeExport("../x", host)).toBeUndefined();
    const [path] = OPENCODE_CAPTURE.sweep;
    // The host is Linux on every machine, so the folder is written with `/`; resolve() reads it
    // as this machine's path.
    expect(resolve(path?.resolve?.(host) ?? "")).toBe(
      resolve(home, ".local", "state", "seshi", "transcripts", "opencode"),
    );
    expect(path?.match(`${ID}.json`)).toBe(true);
    expect(path?.match(`${ID}.json.123.tmp`)).toBe(false);
  });

  it("are one JSON document each, uploaded whole", () => {
    expect(OPENCODE_CAPTURE).toMatchObject({
      encoding: "json",
      chunkable: false,
      format: "opencode",
    });
    expect(OPENCODE_FORMAT.chunkable).toBe(false);
  });
});

describe("seshi capture install opencode", () => {
  const context = () => ({ ...host, command: ["/opt/seshi/bin/seshi"] });

  it("writes the plugin and the /seshi command once, and removes only its own", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    expect(opencodeInstaller.detect(host)).toBe(true);
    const plugin = pluginPath(host);
    const command = commandPath(host);
    expect((await opencodeInstaller.install(context())).changed).toEqual([plugin, command]);
    expect(readFileSync(plugin, "utf8")).toContain(`// ${PLUGIN_MARKER} v2`);
    expect(readFileSync(plugin, "utf8")).toContain('const SESHI = ["/opt/seshi/bin/seshi"];');
    expect(readFileSync(command, "utf8")).toContain(COMMAND_MARKER);
    expect(await opencodeInstaller.install(context())).toEqual({ changed: [], notes: [] });
    expect(await opencodeInstaller.status(context())).toMatchObject({ installed: true, notes: [] });

    const moved = { ...context(), command: ["/usr/local/bin/seshi"] };
    expect((await opencodeInstaller.status(moved)).notes[0]).toContain("out of date");
    expect((await opencodeInstaller.install(moved)).changed).toEqual([plugin]);
    expect(await opencodeInstaller.uninstall(moved)).toEqual({
      changed: [plugin, command],
      notes: [],
    });
    expect(existsSync(plugin) || existsSync(command)).toBe(false);
  });

  it("leaves a seshi.js or seshi.md that is someone else's alone", async () => {
    mkdirSync(join(commandPath(host), ".."), { recursive: true });
    writeFileSync(commandPath(host), "my own command\n");
    const report = await opencodeInstaller.install(context());
    expect(report.changed).toEqual([]);
    expect(report.notes[0]).toContain("not seshi's");
    expect(existsSync(pluginPath(host))).toBe(false);
    expect((await opencodeInstaller.uninstall(context())).changed).toEqual([]);
    expect(readFileSync(commandPath(host), "utf8")).toBe("my own command\n");
  });

  it("follows XDG_CONFIG_HOME, and finds OpenCode by its data folder too", () => {
    expect(opencodeConfigDir({ ...host, env: { XDG_CONFIG_HOME: join(home, "cfg") } })).toBe(
      join(home, "cfg", "opencode"),
    );
    expect(opencodeInstaller.detect(host)).toBe(false);
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    expect(opencodeInstaller.detect(host)).toBe(true);
  });
});

/** The plugin as OpenCode loads it, run against a stand-in for OpenCode's client and a stand-in
 * seshi that records each call. */
describe("the OpenCode plugin", () => {
  const FAKE_SESHI = `
const { appendFileSync } = require("node:fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  appendFileSync(process.env.FAKE_SESHI_LOG, JSON.stringify({ args, input, inherited: process.env.SESHI_SESSION_ID ?? null }) + "\\n");
  if (args[2] === "SessionStart") process.stdout.write(JSON.stringify({ message: "Session Capture ◉ · uploaded as you work" }) + "\\n");
  if (args[2] === "Command") process.stdout.write(JSON.stringify({ message: "Session Capture ⏸ · turned off for this session" }) + "\\n");
});
`;

  interface Call {
    args: string[];
    input: string;
    inherited: string | null;
  }

  async function load() {
    const fake = join(home, "fake-seshi.cjs");
    writeFileSync(fake, FAKE_SESHI);
    const log = join(home, "calls.jsonl");
    process.env.FAKE_SESHI_LOG = log;
    const file = join(home, "plugins", "seshi.js");
    mkdirSync(join(home, "plugins"), { recursive: true });
    writeFileSync(file, opencodePlugin([process.execPath, fake]));
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    expect(Object.keys(module)).toEqual(["SeshiCapture"]);
    const toasts: { message: string; variant: string }[] = [];
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: path.id === ID ? EXPORT.info : undefined,
        }),
        messages: async () => ({ data: EXPORT.messages }),
      },
      tui: {
        showToast: async ({ body }: { body: { message: string; variant: string } }) => {
          toasts.push(body);
        },
      },
    };
    const hooks = (await (module.SeshiCapture as (input: unknown) => Promise<unknown>)({
      client,
    })) as {
      event: (input: { event: { type: string; properties: unknown } }) => Promise<void>;
      "command.execute.before": (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: unknown[] },
      ) => Promise<void>;
    };
    const calls = (): Call[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Call)
        : [];
    return { hooks, calls, toasts };
  }

  beforeEach(() => {
    process.env.SESHI_SESSION_ID = "the-claude-code-session-opencode-was-started-in";
  });
  afterEach(() => {
    delete process.env.FAKE_SESHI_LOG;
    delete process.env.SESHI_SESSION_ID;
  });

  it("hands the session over whole once a turn is over", async () => {
    const oc = await load();
    await oc.hooks.event({ event: { type: "session.idle", properties: { sessionID: ID } } });
    const [call] = oc.calls();
    expect(call?.args).toEqual(["hook", "opencode", "Stop"]);
    expect(JSON.parse(call?.input ?? "")).toEqual({
      session_id: ID,
      cwd: "/repo/app",
      export: { info: EXPORT.info, messages: EXPORT.messages },
    });
    expect(call?.inherited).toBeNull();
  });

  it("toasts whether a new top-level session is captured, and stays quiet for a subagent's", async () => {
    const oc = await load();
    await oc.hooks.event({
      event: { type: "session.created", properties: { info: EXPORT.info } },
    });
    await oc.hooks.event({
      event: {
        type: "session.created",
        properties: { info: { ...EXPORT.info, id: "ses_child", parentID: ID } },
      },
    });
    await vi.waitFor(() => expect(oc.toasts).toHaveLength(1));
    expect(oc.calls().map((c) => c.args)).toEqual([["hook", "opencode", "SessionStart"]]);
    expect(oc.toasts).toEqual([
      expect.objectContaining({
        message: "Session Capture ◉ · uploaded as you work",
        variant: "info",
      }),
    ]);
  });

  it("carries out /seshi and gives the model the result instead of the command", async () => {
    const oc = await load();
    const output = { parts: [{ type: "text", text: "/seshi off" }] as unknown[] };
    await oc.hooks["command.execute.before"](
      { command: "seshi", sessionID: ID, arguments: "off" },
      output,
    );
    const [call] = oc.calls();
    expect(call?.args).toEqual(["hook", "opencode", "Command"]);
    expect(JSON.parse(call?.input ?? "")).toEqual({
      session_id: ID,
      cwd: "/repo/app",
      arguments: "off",
    });
    expect(oc.toasts[0]).toMatchObject({ variant: "warning" });
    expect(output.parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Session Capture ⏸ · turned off for this session"),
      },
    ]);
    // A session seshi turned off is not read or handed over again.
    await oc.hooks.event({ event: { type: "session.idle", properties: { sessionID: ID } } });
    expect(oc.calls()).toHaveLength(1);
    const other = { parts: [{ type: "text", text: "/review" }] as unknown[] };
    await oc.hooks["command.execute.before"](
      { command: "review", sessionID: ID, arguments: "" },
      other,
    );
    expect(other.parts).toEqual([{ type: "text", text: "/review" }]);
    expect(oc.calls()).toHaveLength(1);
  });
});
