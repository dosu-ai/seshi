/** Capturing OpenCode sessions (F9): the payloads its plugin sends, where seshi keeps the
 * sessions it was handed, and the installer that writes that plugin. Loaded alone by
 * `seshi hook opencode <event>`, so it imports only `@seshi/kit` and `node:` modules (X3.3),
 * never the transcript adapter.
 *
 * OpenCode keeps its sessions in a SQLite database (`~/.local/share/opencode/opencode.db`), not
 * in transcript files, and runs no shell hooks. seshi's plugin (`./plugin.ts`) runs
 * `seshi hook opencode Stop` when a turn is over. On OpenCode 1.x it reads the session through
 * OpenCode's client and sends `{session_id, cwd, parent_session_id?, export: {info, messages}}`
 * on stdin; on 2.x, whose plugins cannot read a whole session, it sends the same without
 * `export` (with `opencode_channel`), and seshi reads the session from the database
 * (`./db.ts`), in the same shape. The export is the transcript: seshi writes it, for a captured
 * session only, to
 * `<capture dir>/transcripts/opencode/<id>.json` and uploads it whole (a JSON document, never in
 * chunks). OpenCode has no end-of-session event (`session.idle` follows every turn), so a session
 * ends when the uploader finds it quiet. A sweep also reads OpenCode's database (`./db.ts`) for
 * the sessions the plugin never handed over, and writes a captured one's export to that same
 * file: a session is one file, and one upload, whichever way seshi found it. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAPTURE_COMMAND,
  type CaptureAgent,
  type CaptureHost,
  captureCommandPrompt,
  expandTilde,
  type HookCapture,
  type HookHandler,
  handedTranscriptDir,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  installOwnedFiles,
  type OwnedFile,
  ownedFileNotes,
  ownedFileState,
  payloadObject,
  readTextFile,
  removeOwnedFiles,
  stringField,
  type TranscriptInfo,
  writeJsonConfig,
} from "@seshi/kit";
import {
  COMMAND_MARKER,
  opencodeCommand,
  opencodePlugin,
  opencodeTuiPlugin,
  PLUGIN_MARKER,
  TUI_PLUGIN_MARKER,
} from "./plugin";
import { redactOpencodeToolCalls } from "./tool-calls";

export const AGENT = "opencode";

/** OpenCode's global config folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (on
 * every platform). */
export function opencodeConfigDir(host: CaptureHost): string {
  const configured = host.env.XDG_CONFIG_HOME;
  return join(
    configured ? expandTilde(configured, host.home) : join(host.home, ".config"),
    "opencode",
  );
}

/** OpenCode's data folder, which holds its database: `$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode` (on every platform). */
export function opencodeDataDir(host: CaptureHost): string {
  const configured = host.env.XDG_DATA_HOME;
  return join(
    configured ? expandTilde(configured, host.home) : join(host.home, ".local", "share"),
    "opencode",
  );
}

function which(payload: unknown): HookCapture {
  const object = payloadObject(payload, AGENT);
  const session = stringField(object, "session_id");
  if (!session) throw new Error(`${AGENT}: the hook payload has no session_id`);
  const cwd = stringField(object, "cwd");
  const parent = stringField(object, "parent_session_id");
  return {
    session_id: session,
    ...(cwd ? { cwd } : {}),
    ...(parent ? { parent_session_id: parent } : {}),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const UNKNOWN_COMMAND = `Session Capture: /${CAPTURE_COMMAND} takes off, on, status, share or unshare; nothing was changed. For a pause, run seshi capture pause in a terminal.`;

/** What the plugin shows for a message seshi has for the person: it toasts `message`. */
const reply = (message: string) => ({ message });

export const OPENCODE_HOOKS: readonly HookHandler[] = [
  {
    // A new top-level session: the plugin toasts whether it is captured.
    event: "SessionStart",
    reply,
    parse: (payload) => ({ captures: [], announce: which(payload) }),
  },
  {
    event: "Stop",
    reply,
    parse(payload, host) {
      const object = payloadObject(payload, AGENT);
      const exported = object.export;
      if (exported === undefined) {
        // OpenCode 2.x's plugin cannot read a whole session, so it names only the session (and
        // the release channel, which says which database file OpenCode keeps): seshi reads it
        // from OpenCode's database, once it is captured.
        const session = which(payload);
        const channel = stringField(object, "opencode_channel");
        const read = async () =>
          (await import("./db")).readOpencodeSession(host, session.session_id, channel);
        return { captures: [{ ...session, read }] };
      }
      if (!isObject(exported) || !isObject(exported.info) || !Array.isArray(exported.messages)) {
        throw new Error(`${AGENT}: the Stop payload's export is not {info, messages}`);
      }
      // `info` first, whatever order it came in: `identify` reads it from the file's head.
      const transcript = JSON.stringify({ info: exported.info, messages: exported.messages });
      return { captures: [{ ...which(payload), transcript }] };
    },
  },
  {
    // `/session-capture off|on|status|share|unshare`: the plugin hands it over before OpenCode
    // sends it to the model.
    event: "Command",
    reply,
    parse(payload) {
      const args = stringField(payloadObject(payload, AGENT), "arguments") ?? "";
      const asked = captureCommandPrompt(`/${CAPTURE_COMMAND} ${args}`);
      const { session_id, cwd } = which(payload);
      const session = { session_id, ...(cwd ? { cwd } : {}) };
      if (!asked) return { captures: [], say: UNKNOWN_COMMAND };
      if (asked === "status") return { captures: [], announce: session };
      return { captures: [], request: { action: asked, session } };
    },
  },
];

/** A JSON string value that starts right after `key` in `text`, decoded. */
function stringAfter(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/** Which session an export seshi wrote is: its file name, and, from the session's `info` (which
 * seshi writes first, before `messages`), where it ran, when it started and its parent. Whatever
 * order `info`'s own keys come in, it must name the same id. */
export function identifyOpencodeExport(path: string, head: string): TranscriptInfo | null {
  if (!path.endsWith(".json") || !head.startsWith('{"info":{')) return null;
  const id = basename(path, ".json");
  const end = head.indexOf('"messages":');
  const info = end === -1 ? head : head.slice(0, end);
  if (!info.includes(`"id":${JSON.stringify(id)}`)) return null;
  const cwd = stringAfter(info, "directory");
  const parent = stringAfter(info, "parentID");
  const created = /"created":(\d+)/.exec(info)?.[1];
  return {
    session_id: id,
    ...(cwd ? { cwd } : {}),
    ...(created ? { started_at: new Date(Number(created)).toISOString() } : {}),
    ...(parent ? { parent_session_id: parent } : {}),
  };
}

export function locateOpencodeExport(sessionId: string, host: CaptureHost): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const file = join(handedTranscriptDir(host, AGENT), `${sessionId}.json`);
  return existsSync(file) ? file : undefined;
}

export function pluginPath(host: CaptureHost): string {
  return join(opencodeConfigDir(host), "plugins", "seshi.js");
}

export function commandPath(host: CaptureHost): string {
  return join(opencodeConfigDir(host), "command", `${CAPTURE_COMMAND}.md`);
}

/** Remove the command's file under its old name, `seshi.md`, when it is seshi's. */
function removeOldCommand(host: CaptureHost): string[] {
  const path = join(opencodeConfigDir(host), "command", "seshi.md");
  if (!readTextFile(path)?.includes(COMMAND_MARKER)) return [];
  rmSync(path, { force: true });
  return [path];
}

/** The TUI plugin: not in `plugins/`, which OpenCode's server loads as server plugins. */
export function tuiPluginPath(host: CaptureHost): string {
  return join(opencodeConfigDir(host), "seshi", "tui.js");
}

/** OpenCode's global TUI config, whose `plugin` list names the TUI plugins to load. OpenCode also
 * reads a `tui.jsonc` beside it and merges the two lists, so seshi writes only `tui.json`. */
export function tuiConfigPath(host: CaptureHost): string {
  return join(opencodeConfigDir(host), "tui.json");
}

const TUI_SCHEMA = "https://opencode.ai/tui.json";

function owned(context: InstallContext): OwnedFile[] {
  return [
    { path: pluginPath(context), text: opencodePlugin(context.command), marker: PLUGIN_MARKER },
    {
      path: tuiPluginPath(context),
      text: opencodeTuiPlugin(context.command),
      marker: TUI_PLUGIN_MARKER,
    },
    { path: commandPath(context), text: opencodeCommand(), marker: COMMAND_MARKER },
  ];
}

/** OpenCode 2.x's TUI config, whose `plugins` list names TUI plugins; a local one by its folder,
 * from which 2.x loads `tui.js`. OpenCode 2.x writes it (copying `tui.json` over) when it first
 * starts, so seshi changes it only once it is there. */
export function cliConfigPath(host: CaptureHost): string {
  return join(opencodeConfigDir(host), "cli.json");
}

/** Whether an entry of a TUI config's plugin list (a path or URL, alone, with options in a pair, or
 * as 2.x's `{package, options}`) names `target`. */
function isOurEntry(entry: unknown, target: string): boolean {
  const spec = Array.isArray(entry) ? entry[0] : isObject(entry) ? entry.package : entry;
  return spec === target || spec === pathToFileURL(target).href;
}

type PluginConfig =
  | { present: boolean; config: Record<string, unknown>; plugins: unknown[] }
  | { present: true; problem: string };

/** A TUI config as seshi may change it: plain JSON holding an object, its `key` a list. OpenCode
 * reads it as JSONC; one with comments is left to the person, since rewriting it would drop them. */
function readPluginConfig(path: string, key: string): PluginConfig {
  const text = readTextFile(path);
  if (text === undefined || text.trim() === "") {
    return { present: text !== undefined, config: {}, plugins: [] };
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return { present: true, problem: "is not plain JSON (comments?)" };
  }
  if (!isObject(config)) return { present: true, problem: "does not hold a JSON object" };
  const plugins = config[key] ?? [];
  if (!Array.isArray(plugins))
    return { present: true, problem: `has a "${key}" that is not a list` };
  return { present: true, config, plugins };
}

/** `tui.json` (1.x), the TUI plugin's path, and whether the list names it. */
function tuiEntry(host: CaptureHost) {
  const path = tuiConfigPath(host);
  const file = tuiPluginPath(host);
  const current = readPluginConfig(path, "plugin");
  const listed = !("problem" in current) && current.plugins.some((e) => isOurEntry(e, file));
  return { path, file, current, listed };
}

/** `cli.json` (2.x), the TUI plugin's folder, whether the list names it, and whether it still
 * names the file (copied over from `tui.json`), which 2.x cannot load. */
function cliEntry(host: CaptureHost) {
  const path = cliConfigPath(host);
  const folder = dirname(tuiPluginPath(host));
  const file = tuiPluginPath(host);
  const current = readPluginConfig(path, "plugins");
  const ok = !("problem" in current);
  const listed = ok && current.plugins.some((e) => isOurEntry(e, folder));
  const stale = ok && current.plugins.some((e) => isOurEntry(e, file));
  return { path, folder, file, current, listed, stale };
}

/** OpenCode's state folder: `$XDG_STATE_HOME/opencode`, else `~/.local/state/opencode`. */
function opencodeStateDir(host: CaptureHost): string {
  const configured = host.env.XDG_STATE_HOME;
  return join(
    configured ? expandTilde(configured, host.home) : join(host.home, ".local", "state"),
    "opencode",
  );
}

/** Run `change` holding the lock OpenCode 2.x holds while it reads or rewrites `cli.json` (its
 * `Flock`: a folder `<state>/locks/<sha1 of the file's path>.lock` with `heartbeat` and
 * `meta.json` in it), so neither overwrites the other's change. Waits up to `waitMs` for
 * OpenCode to let go; false, with nothing changed, if it did not. A lock OpenCode left behind
 * when it crashed is OpenCode's to clear (it does when it next starts). */
export async function withCliConfigLock(
  host: CaptureHost,
  change: () => void,
  waitMs = 5000,
): Promise<boolean> {
  const locks = join(opencodeStateDir(host), "locks");
  const lock = join(locks, `${createHash("sha1").update(cliConfigPath(host)).digest("hex")}.lock`);
  mkdirSync(locks, { recursive: true });
  const until = Date.now() + waitMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  try {
    writeFileSync(join(lock, "heartbeat"), "", { flag: "wx" });
    const meta = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(lock, "meta.json"), JSON.stringify(meta, null, 2), { flag: "wx" });
    change();
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const cliBusy = (path: string, command: "install" | "uninstall") =>
  `${path} is being changed by OpenCode: left alone; run seshi capture ${command} opencode again`;

const byHand = (path: string, file: string, problem: string, key = "plugin") =>
  `${path} ${problem}: left alone, so OpenCode shows no Session Capture status; add "${file}" to its "${key}" list`;

export const opencodeInstaller: Installer = {
  detect: (host) => existsSync(opencodeConfigDir(host)) || existsSync(opencodeDataDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const { changed, foreign, notes } = installOwnedFiles(owned(context), "OpenCode");
    if (foreign.length > 0) return { changed, notes };
    notes.push(...removeOldCommand(context).map((p) => `removed ${p}, the command's old name`));
    const { path, file: tui, current, listed } = tuiEntry(context);
    if ("problem" in current) notes.push(byHand(path, tui, current.problem));
    else if (!listed) {
      const config: Record<string, unknown> = current.present
        ? { ...current.config }
        : { $schema: TUI_SCHEMA };
      config.plugin = [...current.plugins, tui];
      writeJsonConfig(path, config);
      changed.push(path);
    }
    // OpenCode 2.x's cli.json, once 2.x has written it: read and changed under OpenCode's lock.
    if (existsSync(cliConfigPath(context))) {
      const locked = await withCliConfigLock(context, () => {
        const cli = cliEntry(context);
        if ("problem" in cli.current)
          notes.push(byHand(cli.path, cli.folder, cli.current.problem, "plugins"));
        else if (cli.current.present && (!cli.listed || cli.stale)) {
          const plugins = cli.current.plugins.filter((entry) => !isOurEntry(entry, cli.file));
          if (!cli.listed) plugins.push(cli.folder);
          writeJsonConfig(cli.path, { ...cli.current.config, plugins });
          changed.push(cli.path);
        }
      });
      if (!locked) notes.push(cliBusy(cliConfigPath(context), "install"));
    }
    if (changed.length > 0)
      notes.push("OpenCode loads the plugin when it starts: restart OpenCode");
    return { changed, notes };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const changed = [...removeOwnedFiles(owned(context)), ...removeOldCommand(context)];
    const { path, file: tui, current, listed } = tuiEntry(context);
    if (changed.includes(tui)) {
      try {
        // seshi's own folder, once empty.
        rmdirSync(dirname(tui));
      } catch {}
    }
    if (!("problem" in current) && listed) {
      const config = { ...current.config };
      const plugins = current.plugins.filter((entry) => !isOurEntry(entry, tui));
      if (plugins.length > 0) config.plugin = plugins;
      else delete config.plugin;
      // Nothing left but the schema line seshi wrote: the file goes too.
      const rest = Object.keys(config).filter((key) => key !== "$schema");
      if (rest.length === 0 && (config.$schema ?? TUI_SCHEMA) === TUI_SCHEMA) {
        rmSync(path, { force: true });
      } else writeJsonConfig(path, config);
      changed.push(path);
    }
    const notes: string[] = [];
    if (existsSync(cliConfigPath(context))) {
      const locked = await withCliConfigLock(context, () => {
        const cli = cliEntry(context);
        if ("problem" in cli.current || !(cli.listed || cli.stale)) return;
        const config = { ...cli.current.config };
        const plugins = cli.current.plugins.filter(
          (entry) => !isOurEntry(entry, cli.folder) && !isOurEntry(entry, cli.file),
        );
        if (plugins.length > 0) config.plugins = plugins;
        else delete config.plugins;
        // OpenCode's own file, with its other settings: it stays.
        writeJsonConfig(cli.path, config);
        changed.push(cli.path);
      });
      if (!locked) notes.push(cliBusy(cliConfigPath(context), "uninstall"));
    }
    return { changed, notes };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const states = owned(context).map(ownedFileState);
    const notes = ownedFileNotes(states, AGENT);
    // Capture needs only seshi's own files; tui.json's entry (the status and /session-capture in the TUI)
    // is reported, not required.
    const { path, file: tui, current, listed } = tuiEntry(context);
    if ("problem" in current) notes.push(byHand(path, tui, current.problem));
    else if (!listed && states.some((s) => s.ours)) {
      notes.push(`${path} does not list seshi's TUI plugin: run seshi capture install opencode`);
    }
    // OpenCode 2.x's TUI config, once 2.x has written it.
    const cli = cliEntry(context);
    if ("problem" in cli.current)
      notes.push(byHand(cli.path, cli.folder, cli.current.problem, "plugins"));
    else if (cli.current.present && (!cli.listed || cli.stale) && states.some((s) => s.ours)) {
      notes.push(
        `${cli.path} (OpenCode 2.x) does not list seshi's TUI plugin folder: run seshi capture install opencode`,
      );
    }
    return {
      installed: states.every((s) => s.ours),
      files: [
        ...states.map(({ path, present, ours }) => ({ path, present, ours })),
        { path, present: current.present, ours: listed },
        ...(cli.current.present
          ? [{ path: cli.path, present: true, ours: cli.listed && !cli.stale }]
          : []),
      ],
      notes,
    };
  },
};

export const OPENCODE_CAPTURE: CaptureAgent = {
  name: AGENT,
  format: AGENT,
  encoding: "json",
  chunkable: false,
  hooks: OPENCODE_HOOKS,
  sweep: [
    {
      root: "~/.local/state/seshi/transcripts/opencode",
      resolve: (host) => handedTranscriptDir(host, AGENT),
      depths: [1],
      match: (relative) => /^[\w-]+\.json$/.test(relative),
    },
  ],
  identify: identifyOpencodeExport,
  locate: locateOpencodeExport,
  // Sessions the plugin never handed over, read from OpenCode's database. Imported here, not at
  // the top: `seshi hook` loads this module and never sweeps.
  stored: async (host, sinceMs) => (await import("./db")).storedOpencodeSessions(host, sinceMs),
  installer: opencodeInstaller,
  redactToolCalls: redactOpencodeToolCalls,
};
