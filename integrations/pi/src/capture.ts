/** Capturing pi sessions (F9): the payloads its extension sends, where its session files are, and
 * the installer that writes that extension. Loaded alone by `seshi hook pi <event>`, so it
 * imports only `@seshi/kit` and `node:` modules (X3.3), never the transcript adapter.
 *
 * pi keeps its files in `~/.pi/agent` (`PI_CODING_AGENT_DIR` moves it): sessions in
 * `sessions/--<cwd>--/<timestamp>_<id>.jsonl` (`PI_CODING_AGENT_SESSION_DIR` moves them),
 * append-only JSONL whose first line is the header, `{"type":"session","version":3,"id",
 * "timestamp","cwd","parentSession"?}`; a fork's `parentSession` is its parent's file. pi writes
 * the file once the session has its first message. It runs no shell hooks, so seshi installs an
 * extension (`extensions/seshi.ts`, `./extension.ts`) that runs `seshi hook pi <event>` with
 * `{session_id, transcript_path, cwd, parent_session?}` on stdin: `Stop` after each agent run,
 * `SessionEnd` when the session ends, and `Command` for `/session-capture`. */

import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  CAPTURE_COMMAND,
  type CaptureAgent,
  type CaptureHost,
  captureCommandPrompt,
  expandTilde,
  type HookCapture,
  type HookHandler,
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
} from "@seshi/kit";
import { EXTENSION_MARKER, piExtension } from "./extension";
import { redactPiToolCalls } from "./tool-calls";

export const AGENT = "pi";

export function piAgentDir(host: CaptureHost): string {
  const configured = host.env.PI_CODING_AGENT_DIR;
  return configured ? expandTilde(configured, host.home) : join(host.home, ".pi", "agent");
}

/** A session folder set in pi's `settings.json` (`sessionDir`), when it is one place for every
 * project: a relative one is resolved from each session's working directory. */
function settingsSessionDir(host: CaptureHost): string | undefined {
  try {
    const settings = JSON.parse(readTextFile(join(piAgentDir(host), "settings.json")) ?? "{}") as {
      sessionDir?: unknown;
    };
    if (typeof settings.sessionDir !== "string" || settings.sessionDir === "") return undefined;
    const dir = expandTilde(settings.sessionDir, host.home);
    return isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Where pi keeps sessions: `PI_CODING_AGENT_SESSION_DIR`, else `sessionDir` in its settings,
 * else `sessions/` in its agent folder. Only the last has a folder per working directory; pi
 * writes the files straight into a folder set either way. */
export function piSessionsDir(host: CaptureHost): string {
  const configured = host.env.PI_CODING_AGENT_SESSION_DIR;
  if (configured) return expandTilde(configured, host.home);
  return settingsSessionDir(host) ?? join(piAgentDir(host), "sessions");
}

/** The session id in a session file's name, `<timestamp>_<id>.jsonl`. */
export function sessionIdOfFile(path: string): string | undefined {
  return /_([\w-]+)\.jsonl$/.exec(basename(path))?.[1];
}

function capture(payload: unknown, final: boolean): HookCapture {
  const object = payloadObject(payload, AGENT);
  const session = stringField(object, "session_id");
  if (!session) throw new Error(`${AGENT}: the hook payload has no session_id`);
  const path = stringField(object, "transcript_path");
  const cwd = stringField(object, "cwd");
  const parentFile = stringField(object, "parent_session");
  const parent = parentFile ? sessionIdOfFile(parentFile) : undefined;
  return {
    session_id: session,
    ...(path ? { transcript_path: path } : {}),
    ...(cwd ? { cwd } : {}),
    ...(parent ? { parent_session_id: parent } : {}),
    ...(final ? { final } : {}),
  };
}

export const UNKNOWN_COMMAND = `Session Capture: /${CAPTURE_COMMAND} takes off, on or status; nothing was changed. For a pause, run seshi capture pause in a terminal.`;

/** What the extension prints for a message seshi has for the person: it shows `message`. */
const reply = (message: string) => ({ message });

export const PI_HOOKS: readonly HookHandler[] = [
  { event: "Stop", reply, parse: (payload) => ({ captures: [capture(payload, false)] }) },
  { event: "SessionEnd", reply, parse: (payload) => ({ captures: [capture(payload, true)] }) },
  {
    // `/session-capture off|on|status`, a command the extension registers: pi never sends it to the model.
    event: "Command",
    reply,
    parse(payload) {
      // Only seshi's own command sends this event, so its name (which an extension written
      // before a rename still sends) is dropped and only the words after it are read.
      const prompt = stringField(payloadObject(payload, AGENT), "prompt") ?? "";
      const args = prompt.replace(/^\s*[$/]\S*/, "");
      const asked = captureCommandPrompt(`/${CAPTURE_COMMAND} ${args}`);
      const { session_id, cwd } = capture(payload, false);
      const which = { session_id, ...(cwd ? { cwd } : {}) };
      if (!asked) return { captures: [], say: UNKNOWN_COMMAND };
      if (asked === "status") return { captures: [], announce: which };
      return { captures: [], request: { action: asked, session: which } };
    },
  },
];

/** Which session a pi session file is, from its header line. */
export function identifyPiSession(path: string, head: string): TranscriptInfo | null {
  if (!path.endsWith(".jsonl")) return null;
  const line = head.split("\n", 1)[0] ?? "";
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.type !== "session" || typeof header.id !== "string" || header.id === "") return null;
  const parent =
    typeof header.parentSession === "string" ? sessionIdOfFile(header.parentSession) : undefined;
  return {
    session_id: header.id,
    ...(typeof header.cwd === "string" && header.cwd !== "" ? { cwd: header.cwd } : {}),
    ...(typeof header.timestamp === "string" ? { started_at: header.timestamp } : {}),
    ...(parent ? { parent_session_id: parent } : {}),
  };
}

export function locatePiSession(sessionId: string, host: CaptureHost): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const root = piSessionsDir(host);
  const suffix = `_${sessionId}.jsonl`;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const flat = entries.find((d) => d.isFile() && d.name.endsWith(suffix));
  if (flat) return join(root, flat.name);
  const folders = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  for (const folder of folders) {
    try {
      const name = readdirSync(join(root, folder)).find((n) => n.endsWith(suffix));
      if (name) return join(root, folder, name);
    } catch {}
  }
  return undefined;
}

export function extensionPath(host: CaptureHost): string {
  return join(piAgentDir(host), "extensions", "seshi.ts");
}

function owned(context: InstallContext): OwnedFile[] {
  return [
    { path: extensionPath(context), text: piExtension(context.command), marker: EXTENSION_MARKER },
  ];
}

export const piInstaller: Installer = {
  detect: (host) => existsSync(piAgentDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const { changed, notes } = installOwnedFiles(owned(context), AGENT);
    if (changed.length > 0) {
      notes.push("pi loads it when it starts: restart pi, or run /reload in a running session");
    }
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

export const PI_CAPTURE: CaptureAgent = {
  name: AGENT,
  format: AGENT,
  encoding: "jsonl",
  chunkable: true,
  hooks: PI_HOOKS,
  sweep: [
    {
      root: "~/.pi/agent/sessions",
      resolve: piSessionsDir,
      // A folder per working directory, or (a session folder set) the files themselves.
      depths: [1, 2],
      match: (relative) => /^(?:[^/]+\/)?[^/]+_[\w-]+\.jsonl$/.test(relative),
    },
  ],
  identify: identifyPiSession,
  locate: locatePiSession,
  installer: piInstaller,
  redactToolCalls: redactPiToolCalls,
};
