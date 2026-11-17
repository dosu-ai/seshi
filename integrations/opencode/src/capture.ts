/** Capturing OpenCode sessions (F9): the payloads its plugin sends, where seshi keeps the
 * sessions it was handed, and the installer that writes that plugin. Loaded alone by
 * `seshi hook opencode <event>`, so it imports only `@seshi/kit` and `node:` modules (X3.3),
 * never the transcript adapter.
 *
 * OpenCode keeps its sessions in a SQLite database (`~/.local/share/opencode/opencode.db`), not
 * in transcript files, and runs no shell hooks. seshi's plugin (`./plugin.ts`) reads each session
 * through OpenCode's client when a turn is over and runs `seshi hook opencode Stop` with
 * `{session_id, cwd, parent_session_id?, export: {info, messages}}` on stdin. The export is the
 * transcript: seshi writes it, for a captured session only, to
 * `<capture dir>/transcripts/opencode/<id>.json` and uploads it whole (a JSON document, never in
 * chunks). OpenCode has no end-of-session event (`session.idle` follows every turn), so a session
 * ends when the uploader finds it quiet. */

import { existsSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CaptureAgent,
  type CaptureHost,
  expandTilde,
  type HookCapture,
  type HookHandler,
  handedTranscriptDir,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  payloadObject,
  readTextFile,
  seshiPrompt,
  stringField,
  type TranscriptInfo,
  writeFileAtomic,
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

function opencodeDataDir(host: CaptureHost): string {
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
    parse(payload) {
      const exported = payloadObject(payload, AGENT).export;
      if (!isObject(exported) || !isObject(exported.info) || !Array.isArray(exported.messages)) {
        throw new Error(`${AGENT}: the Stop payload has no export ({info, messages})`);
      }
      return { captures: [{ ...which(payload), transcript: JSON.stringify(exported) }] };
    },
  },
  {
    // `/seshi off|on|status`: the plugin hands it over before OpenCode sends it to the model.
    event: "Command",
    reply,
    parse(payload) {
      const args = stringField(payloadObject(payload, AGENT), "arguments") ?? "";
      const asked = seshiPrompt(`/seshi ${args}`);
      const { session_id, cwd } = which(payload);
      const session = { session_id, ...(cwd ? { cwd } : {}) };
      if (!asked || asked === "status") return { captures: [], announce: session };
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

/** Which session an export seshi wrote is: its file name, and, from the session's `info` (the
 * document's first key, before `messages`), where it ran, when it started and its parent. */
export function identifyOpencodeExport(path: string, head: string): TranscriptInfo | null {
  if (!path.endsWith(".json") || !head.startsWith('{"info":{')) return null;
  const id = basename(path, ".json");
  const end = head.indexOf('"messages":');
  const info = end === -1 ? head : head.slice(0, end);
  if (stringAfter(info, "id") !== id) return null;
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
  return join(opencodeConfigDir(host), "command", "seshi.md");
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

interface Owned {
  path: string;
  text: string;
  marker: string;
}

function owned(context: InstallContext): Owned[] {
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

/** Whether an entry of `tui.json`'s `plugin` list (a path or URL, alone or with options) names
 * seshi's TUI plugin. */
function isOurEntry(entry: unknown, file: string): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return spec === file || spec === pathToFileURL(file).href;
}

type TuiConfig =
  | { present: boolean; config: Record<string, unknown>; plugins: unknown[] }
  | { present: true; problem: string };

/** `tui.json` as seshi may change it: plain JSON holding an object, its `plugin` a list. OpenCode
 * reads it as JSONC; one with comments is left to the person, since rewriting it would drop them. */
function readTuiConfig(path: string): TuiConfig {
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
  const plugins = config.plugin ?? [];
  if (!Array.isArray(plugins))
    return { present: true, problem: 'has a "plugin" that is not a list' };
  return { present: true, config, plugins };
}

/** `tui.json`, the TUI plugin's path, and whether the list names it. */
function tuiEntry(host: CaptureHost) {
  const path = tuiConfigPath(host);
  const file = tuiPluginPath(host);
  const current = readTuiConfig(path);
  const listed = !("problem" in current) && current.plugins.some((e) => isOurEntry(e, file));
  return { path, file, current, listed };
}

const byHand = (path: string, file: string, problem: string) =>
  `${path} ${problem}: left alone, so OpenCode shows no Session Capture status; add "${file}" to its "plugin" list`;

export const opencodeInstaller: Installer = {
  detect: (host) => existsSync(opencodeConfigDir(host)) || existsSync(opencodeDataDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const files = owned(context);
    const notes: string[] = [];
    const foreign = files.filter((f) => {
      const existing = readTextFile(f.path);
      return existing !== undefined && !existing.includes(f.marker);
    });
    if (foreign.length > 0) {
      return {
        changed: [],
        notes: foreign.map(
          (f) => `${f.path} is not seshi's: left alone, so OpenCode is not captured`,
        ),
      };
    }
    const changed: string[] = [];
    for (const file of files) {
      if (readTextFile(file.path) === file.text) continue;
      writeFileAtomic(file.path, file.text);
      changed.push(file.path);
    }
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
    if (changed.length > 0)
      notes.push("OpenCode loads the plugin when it starts: restart OpenCode");
    return { changed, notes };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const changed: string[] = [];
    for (const file of owned(context)) {
      if (!readTextFile(file.path)?.includes(file.marker)) continue;
      rmSync(file.path, { force: true });
      changed.push(file.path);
    }
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
    return { changed, notes: [] };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const notes: string[] = [];
    const files = owned(context).map((file) => {
      const text = readTextFile(file.path);
      const ours = text?.includes(file.marker) === true;
      if (text !== undefined && !ours) notes.push(`${file.path} is not seshi's`);
      else if (ours && text !== file.text) {
        notes.push(`${file.path} is out of date: run seshi capture install opencode`);
      }
      return { path: file.path, present: text !== undefined, ours };
    });
    // Capture needs only seshi's own files; tui.json's entry (the status and /seshi in the TUI)
    // is reported, not required.
    const installed = files.every((f) => f.ours);
    const { path, file: tui, current, listed } = tuiEntry(context);
    if ("problem" in current) notes.push(byHand(path, tui, current.problem));
    else if (!listed && files.some((f) => f.ours)) {
      notes.push(`${path} does not list seshi's TUI plugin: run seshi capture install opencode`);
    }
    files.push({ path, present: current.present, ours: listed });
    return { installed, files, notes };
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
  installer: opencodeInstaller,
};
