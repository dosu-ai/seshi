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

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
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
  installOwnedFiles,
  type OwnedFile,
  ownedFileNotes,
  ownedFileState,
  payloadObject,
  removeOwnedFiles,
  seshiPrompt,
  stringField,
  type TranscriptInfo,
} from "@seshi/kit";
import { COMMAND_MARKER, opencodeCommand, opencodePlugin, PLUGIN_MARKER } from "./plugin";

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

export const UNKNOWN_SESHI =
  "Session Capture: /seshi takes off, on or status; nothing was changed. For a pause, run seshi capture pause in a terminal.";

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
      // `info` first, whatever order it came in: `identify` reads it from the file's head.
      const transcript = JSON.stringify({ info: exported.info, messages: exported.messages });
      return { captures: [{ ...which(payload), transcript }] };
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
      if (!asked) return { captures: [], say: UNKNOWN_SESHI };
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
  return join(opencodeConfigDir(host), "command", "seshi.md");
}

function owned(context: InstallContext): OwnedFile[] {
  return [
    { path: pluginPath(context), text: opencodePlugin(context.command), marker: PLUGIN_MARKER },
    { path: commandPath(context), text: opencodeCommand(), marker: COMMAND_MARKER },
  ];
}

export const opencodeInstaller: Installer = {
  detect: (host) => existsSync(opencodeConfigDir(host)) || existsSync(opencodeDataDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const { changed, notes } = installOwnedFiles(owned(context), "OpenCode");
    if (changed.length > 0)
      notes.push("OpenCode loads the plugin when it starts: restart OpenCode");
    return { changed, notes };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    return { changed: removeOwnedFiles(owned(context)), notes: [] };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const states = owned(context).map(ownedFileState);
    return {
      installed: states.every((s) => s.ours),
      files: states.map(({ path, present, ours }) => ({ path, present, ours })),
      notes: ownedFileNotes(states, AGENT),
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
  installer: opencodeInstaller,
};
