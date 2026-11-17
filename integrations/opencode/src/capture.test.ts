import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  tuiConfigPath,
  tuiPluginPath,
} from "./capture";
import { OPENCODE_FORMAT } from "./index";
import {
  COMMAND_MARKER,
  opencodePlugin,
  opencodeTuiPlugin,
  PLUGIN_MARKER,
  TUI_PLUGIN_MARKER,
} from "./plugin";

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
    expect(path?.resolve?.(host)).toBe(
      join(home, ".local", "state", "seshi", "transcripts", "opencode"),
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

  it("writes the plugins and the /seshi command once, and removes only its own", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    expect(opencodeInstaller.detect(host)).toBe(true);
    const plugin = pluginPath(host);
    const tui = tuiPluginPath(host);
    const command = commandPath(host);
    const config = tuiConfigPath(host);
    expect(tui).toBe(join(home, ".config", "opencode", "seshi", "tui.js"));
    expect((await opencodeInstaller.install(context())).changed).toEqual([
      plugin,
      tui,
      command,
      config,
    ]);
    expect(readFileSync(plugin, "utf8")).toContain(`// ${PLUGIN_MARKER} v1`);
    expect(readFileSync(plugin, "utf8")).toContain('const SESHI = ["/opt/seshi/bin/seshi"];');
    expect(readFileSync(tui, "utf8")).toContain(`// ${TUI_PLUGIN_MARKER} v1`);
    expect(readFileSync(tui, "utf8")).toContain('const SESHI = ["/opt/seshi/bin/seshi"];');
    expect(readFileSync(command, "utf8")).toContain(COMMAND_MARKER);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: [tui],
    });
    expect(await opencodeInstaller.install(context())).toEqual({ changed: [], notes: [] });
    expect(await opencodeInstaller.status(context())).toMatchObject({ installed: true, notes: [] });

    const moved = { ...context(), command: ["/usr/local/bin/seshi"] };
    expect((await opencodeInstaller.status(moved)).notes[0]).toContain("out of date");
    expect((await opencodeInstaller.install(moved)).changed).toEqual([plugin, tui]);
    expect(await opencodeInstaller.uninstall(moved)).toEqual({
      changed: [plugin, tui, command, config],
      notes: [],
    });
    expect([plugin, tui, command, config].some((f) => existsSync(f))).toBe(false);
    expect(existsSync(join(tui, ".."))).toBe(false);
  });

  it("adds its TUI plugin to the person's tui.json, and takes only that out again", async () => {
    const config = tuiConfigPath(host);
    const tui = tuiPluginPath(host);
    const theirs = {
      $schema: "https://opencode.ai/tui.json",
      theme: "tokyonight",
      plugin: ["opencode-wakatime", ["./mine.ts", { loud: true }]],
      keybinds: { leader: "ctrl+x" },
    };
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, JSON.stringify(theirs));
    expect((await opencodeInstaller.install(context())).changed).toContain(config);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      ...theirs,
      plugin: [...theirs.plugin, tui],
    });
    expect((await opencodeInstaller.uninstall(context())).changed).toContain(config);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(theirs);

    // Listed by hand as a file URL, with options: found, not listed twice, and taken out.
    const listed = { plugin: [[pathToFileURL(tui).href, {}]] };
    writeFileSync(config, JSON.stringify(listed));
    expect((await opencodeInstaller.install(context())).changed).not.toContain(config);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(listed);
    expect((await opencodeInstaller.status(context())).installed).toBe(true);
    await opencodeInstaller.uninstall(context());
    expect(existsSync(config)).toBe(false);
  });

  it("leaves a tui.json with comments alone, and says what to add by hand", async () => {
    const config = tuiConfigPath(host);
    const text = '{\n  // my theme\n  "theme": "tokyonight"\n}\n';
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, text);
    const report = await opencodeInstaller.install(context());
    expect(report.changed).toEqual([pluginPath(host), tuiPluginPath(host), commandPath(host)]);
    expect(report.notes[0]).toContain(`add "${tuiPluginPath(host)}" to its "plugin" list`);
    expect(readFileSync(config, "utf8")).toBe(text);
    const status = await opencodeInstaller.status(context());
    expect(status.installed).toBe(true);
    expect(status.notes[0]).toContain("is not plain JSON");
    await opencodeInstaller.uninstall(context());
    expect(readFileSync(config, "utf8")).toBe(text);

    writeFileSync(config, JSON.stringify({ plugin: "one" }));
    expect((await opencodeInstaller.install(context())).notes[0]).toContain("not a list");
    expect(readFileSync(config, "utf8")).toBe(JSON.stringify({ plugin: "one" }));
  });

  it("leaves a seshi.js, seshi/tui.js or seshi.md that is someone else's alone", async () => {
    mkdirSync(join(commandPath(host), ".."), { recursive: true });
    writeFileSync(commandPath(host), "my own command\n");
    const report = await opencodeInstaller.install(context());
    expect(report.changed).toEqual([]);
    expect(report.notes[0]).toContain("not seshi's");
    expect(existsSync(pluginPath(host)) || existsSync(tuiConfigPath(host))).toBe(false);
    expect((await opencodeInstaller.uninstall(context())).changed).toEqual([]);
    expect(readFileSync(commandPath(host), "utf8")).toBe("my own command\n");

    // An empty seshi/ that seshi did not empty stays.
    rmSync(commandPath(host));
    mkdirSync(join(tuiPluginPath(host), ".."), { recursive: true });
    await opencodeInstaller.uninstall(context());
    expect(existsSync(join(tuiPluginPath(host), ".."))).toBe(true);
    writeFileSync(tuiPluginPath(host), "export default {};\n");
    expect((await opencodeInstaller.install(context())).notes[0]).toContain(
      `${tuiPluginPath(host)} is not seshi's`,
    );
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
    const other = { parts: [{ type: "text", text: "/review" }] as unknown[] };
    await oc.hooks["command.execute.before"](
      { command: "review", sessionID: ID, arguments: "" },
      other,
    );
    expect(other.parts).toEqual([{ type: "text", text: "/review" }]);
    expect(oc.calls()).toHaveLength(1);
  });
});

/** The TUI plugin as OpenCode's TUI loads it: `@opentui/solid` and `solid-js` stand-ins in a
 * `node_modules` beside it (the stand-in effect runs once, the signal is read through the
 * text's accessor), a stand-in for the TUI's plugin API, and a stand-in seshi. */
describe("the OpenCode TUI plugin", () => {
  const FAKE_SESHI = `
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const log = process.env.FAKE_SESHI_LOG;
  const off = join(log, "..", "off");
  appendFileSync(log, JSON.stringify({ args, input, inherited: process.env.SESHI_SESSION_ID ?? null, noColor: process.env.NO_COLOR ?? null }) + "\\n");
  if (args[0] === "statusline") {
    const line = existsSync(off) ? "Session Capture ⏸ · turned off for this session\\n" : "Session Capture ◉\\n";
    // A "slow" file makes this one read answer late, with what it read now.
    const slow = join(log, "..", "slow");
    if (!existsSync(slow)) return process.stdout.write(line);
    require("node:fs").rmSync(slow);
    setTimeout(() => process.stdout.write(line), 800);
  }
  if (args[2] === "Command") {
    writeFileSync(off, "");
    process.stdout.write(JSON.stringify({ message: "Session Capture ⏸ · turned off for this session" }) + "\\n");
  }
});
`;
  const SOLID = `
export const createElement = (tag) => ({ tag, props: {} });
export const setProp = (node, name, value) => { node.props[name] = value; return value; };
export const insert = (node, accessor) => { node.text = accessor; };
`;
  const SOLID_JS = `
export function createSignal(value) {
  return [() => value, (next) => { value = typeof next === "function" ? next(value) : next; }];
}
globalThis.__effects = [];
export function createEffect(fn) { globalThis.__effects.push(fn); fn(); }
`;

  interface Call {
    args: string[];
    input: string;
    inherited: string | null;
    noColor: string | null;
  }
  interface Node {
    tag: string;
    props: Record<string, unknown>;
    text: () => string;
  }
  type Binding = { key: unknown; cmd: (ctx: { focused: unknown }) => boolean };

  function stub(name: string, source: string) {
    const dir = join(home, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), source);
  }

  async function load(
    options: { keybinds?: Record<string, unknown[]>; clearFails?: boolean } = {},
  ) {
    stub("@opentui/solid", SOLID);
    stub("solid-js", SOLID_JS);
    const fake = join(home, "fake-seshi.cjs");
    writeFileSync(fake, FAKE_SESHI);
    const log = join(home, "calls.jsonl");
    process.env.FAKE_SESHI_LOG = log;
    const file = join(home, "seshi", "tui.js");
    mkdirSync(join(home, "seshi"), { recursive: true });
    writeFileSync(file, opencodeTuiPlugin([process.execPath, fake]));
    const module = (await import(pathToFileURL(file).href)) as {
      default: { id: string; tui: (api: unknown) => Promise<void> };
    };
    expect(module.default.id).toBe("seshi");

    const sessions: Record<string, { id: string; directory: string; parentID?: string }> = {
      [ID]: { id: ID, directory: "/repo/app" },
      ses_child: { id: "ses_child", directory: "/repo/app", parentID: ID },
    };
    const toasts: { message: string; variant: string }[] = [];
    const dispatched: string[] = [];
    const layers: { priority: number; bindings: Binding[] }[] = [];
    const slots: { slots: Record<string, (ctx: unknown, props: unknown) => Node> }[] = [];
    const events: Record<string, (event: unknown) => void> = {};
    const waiting: Record<string, { permission: unknown[]; question: unknown[] }> = {};
    const api = {
      state: {
        session: {
          get: (id: string) => sessions[id],
          permission: (id: string) => waiting[id]?.permission ?? [],
          question: (id: string) => waiting[id]?.question ?? [],
        },
        path: { directory: "/repo/elsewhere" },
      },
      route: { current: { name: "session", params: { sessionID: ID } } as unknown },
      ui: {
        toast: (t: { message: string; variant: string }) => toasts.push(t),
        dialog: { open: false },
      },
      theme: { current: { warning: "warning", textMuted: "muted" } },
      slots: { register: (plugin: (typeof slots)[number]) => slots.push(plugin) },
      event: {
        on: (type: string, fn: (event: unknown) => void) => {
          events[type] = fn;
          return () => {};
        },
      },
      lifecycle: { onDispose: () => () => {} },
      tuiConfig: {
        keybinds: {
          get: (name: string) =>
            options.keybinds?.[name] ?? (name === "input.submit" ? [{ key: "return" }] : []),
        },
      },
      keymap: {
        registerLayer: (layer: (typeof layers)[number]) => layers.push(layer),
        dispatchCommand: (name: string) => {
          dispatched.push(name);
          return options.clearFails ? { ok: false, reason: "not-found" } : { ok: true };
        },
      },
    };
    await module.default.tui(api);
    const calls = (): Call[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Call)
        : [];
    const show = (session_id: string) =>
      slots[0]?.slots.session_prompt_right?.({}, { session_id }) as Node;
    const submit = (text: unknown) => layers[0]?.bindings[0]?.cmd({ focused: { plainText: text } });
    const rerun = () => {
      for (const effect of (globalThis as { __effects?: (() => void)[] }).__effects ?? []) effect();
    };
    return { api, calls, toasts, dispatched, layers, events, waiting, show, submit, rerun };
  }

  beforeEach(() => {
    process.env.SESHI_SESSION_ID = "the-claude-code-session-opencode-was-started-in";
  });
  afterEach(() => {
    delete process.env.FAKE_SESHI_LOG;
    delete process.env.SESHI_SESSION_ID;
  });

  it("shows beside the prompt whether the session in view is captured", async () => {
    const tui = await load();
    const node = tui.show(ID);
    expect(node.tag).toBe("text");
    await vi.waitFor(() => expect(node.text()).toBe("Session Capture ◉"));
    expect(node.props.fg).toBe("muted");
    const [call] = tui.calls();
    expect(call?.args).toEqual(["statusline", "--agent", "opencode"]);
    expect(JSON.parse(call?.input ?? "")).toEqual({ session_id: ID, cwd: "/repo/app" });
    expect(call).toMatchObject({ inherited: null, noColor: "1" });

    // A subagent's session is captured with its parent's: the status is the parent's.
    const child = tui.show("ses_child");
    await vi.waitFor(() => expect(child.text()).toBe("Session Capture ◉"));
    expect(JSON.parse(tui.calls()[1]?.input ?? "")).toEqual({ session_id: ID, cwd: "/repo/app" });

    // After a turn, the session in view is read again: for its own turn or a subagent's, not
    // another session's.
    tui.events["session.idle"]?.({ properties: { sessionID: "ses_other" } });
    tui.events["session.idle"]?.({ properties: { sessionID: "ses_child" } });
    await vi.waitFor(() => expect(tui.calls()).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tui.calls()).toHaveLength(3);
  });

  it("carries out /seshi off from the prompt, so nothing reaches the model", async () => {
    const tui = await load();
    const node = tui.show(ID);
    await vi.waitFor(() => expect(node.text()).toBe("Session Capture ◉"));
    expect(tui.submit("  /seshi off ")).toBe(true);
    expect(tui.dispatched).toEqual(["prompt.clear"]);
    await vi.waitFor(() => expect(node.text()).toBe("Session Capture ⏸"));
    const command = tui.calls().find((c) => c.args[2] === "Command");
    expect(command?.args).toEqual(["hook", "opencode", "Command"]);
    expect(JSON.parse(command?.input ?? "")).toEqual({
      session_id: ID,
      cwd: "/repo/app",
      arguments: "off",
    });
    expect(tui.toasts).toEqual([
      expect.objectContaining({
        message: "Session Capture ⏸ · turned off for this session",
        variant: "warning",
      }),
    ]);
    tui.rerun();
    expect(node.props.fg).toBe("warning");
  });

  it("shows the latest read when an earlier one answers late", async () => {
    const tui = await load();
    writeFileSync(join(home, "slow"), "");
    const node = tui.show(ID);
    await vi.waitFor(() => expect(existsSync(join(home, "slow"))).toBe(false));
    expect(tui.submit("/seshi off")).toBe(true);
    await vi.waitFor(() => expect(node.text()).toBe("Session Capture ⏸"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(node.text()).toBe("Session Capture ⏸");
  });

  it("passes every other prompt on, and /seshi too where there is no session yet", async () => {
    const tui = await load();
    expect(tui.submit("hello")).toBe(false);
    expect(tui.submit("/seshiful")).toBe(false);
    expect(tui.submit(undefined)).toBe(false);
    // With an attachment's placeholder, or a word seshi does not take, the server's command gets
    // it, attachments and all.
    expect(tui.submit("/seshi off [Image 1]")).toBe(false);
    expect(tui.submit("/seshi offf")).toBe(false);
    // A permission or a question replaces the prompt; a subagent's session has none.
    tui.waiting[ID] = { permission: [{}], question: [] };
    expect(tui.submit("/seshi off")).toBe(false);
    tui.waiting[ID] = { permission: [], question: [{}] };
    expect(tui.submit("/seshi off")).toBe(false);
    delete tui.waiting[ID];
    tui.api.route.current = { name: "session", params: { sessionID: "ses_child" } };
    expect(tui.submit("/seshi off")).toBe(false);
    tui.api.route.current = { name: "session", params: { sessionID: ID } };
    tui.api.ui.dialog.open = true;
    expect(tui.submit("/seshi off")).toBe(false);
    tui.api.ui.dialog.open = false;
    tui.api.route.current = { name: "home" };
    expect(tui.submit("/seshi off")).toBe(false);
    expect(tui.dispatched).toEqual([]);
    expect(tui.calls()).toEqual([]);
  });

  it("passes /seshi on when the prompt cannot be cleared", async () => {
    const tui = await load({ clearFails: true });
    expect(tui.submit("/seshi off")).toBe(false);
    expect(tui.dispatched).toEqual(["prompt.clear"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tui.calls()).toEqual([]);
  });

  it("listens on the keys the person submits the prompt with", async () => {
    expect((await load()).layers[0]?.bindings.map((b) => b.key)).toEqual(["return"]);
    const tui = await load({
      keybinds: {
        "input.submit": [{ key: "ctrl+s" }, { key: undefined }],
        "prompt.submit": [{ key: "ctrl+s" }, { key: "alt+return" }],
      },
    });
    expect(tui.layers[0]?.bindings.map((b) => b.key)).toEqual(["ctrl+s", "alt+return"]);
    expect(tui.layers[0]?.priority).toBeGreaterThan(0);
    const none = await load({ keybinds: { "input.submit": [], "prompt.submit": [] } });
    expect(none.layers[0]?.bindings.map((b) => b.key)).toEqual(["return"]);
  });
});
