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
 * `SessionEnd` when the session ends, and `Command` for `/seshi`. */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  expandTilde,
  type HookCapture,
  type HookHandler,
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
} from "@seshi/kit";
import { EXTENSION_MARKER, piExtension } from "./extension";

export const AGENT = "pi";

export function piAgentDir(host: CaptureHost): string {
  const configured = host.env.PI_CODING_AGENT_DIR;
  return configured ? expandTilde(configured, host.home) : join(host.home, ".pi", "agent");
}

export function piSessionsDir(host: CaptureHost): string {
  const configured = host.env.PI_CODING_AGENT_SESSION_DIR;
  return configured ? expandTilde(configured, host.home) : join(piAgentDir(host), "sessions");
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

/** What the extension prints for a message seshi has for the person: it shows `message`. */
const reply = (message: string) => ({ message });

export const PI_HOOKS: readonly HookHandler[] = [
  { event: "Stop", reply, parse: (payload) => ({ captures: [capture(payload, false)] }) },
  { event: "SessionEnd", reply, parse: (payload) => ({ captures: [capture(payload, true)] }) },
  {
    // `/seshi off|on|status`, a command the extension registers: pi never sends it to the model.
    event: "Command",
    reply,
    parse(payload) {
      const asked = seshiPrompt(stringField(payloadObject(payload, AGENT), "prompt") ?? "/seshi");
      const { session_id, cwd } = capture(payload, false);
      const which = { session_id, ...(cwd ? { cwd } : {}) };
      if (!asked || asked === "status") return { captures: [], announce: which };
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
  let folders: string[] = [];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
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

function isOurs(text: string | undefined): boolean {
  return text?.startsWith(`// ${EXTENSION_MARKER}`) === true;
}

export const piInstaller: Installer = {
  detect: (host) => existsSync(piAgentDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const path = extensionPath(context);
    const existing = readTextFile(path);
    if (existing !== undefined && !isOurs(existing)) {
      return { changed: [], notes: [`${path} is not seshi's: left alone, so pi is not captured`] };
    }
    const text = piExtension(context.command);
    if (existing === text) return { changed: [], notes: [] };
    writeFileAtomic(path, text);
    return {
      changed: [path],
      notes: ["pi loads it when it starts: restart pi, or run /reload in a running session"],
    };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const path = extensionPath(context);
    if (!isOurs(readTextFile(path))) return { changed: [], notes: [] };
    rmSync(path, { force: true });
    return { changed: [path], notes: [] };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const path = extensionPath(context);
    const text = readTextFile(path);
    const ours = isOurs(text);
    const notes: string[] = [];
    if (text !== undefined && !ours) notes.push(`${path} is not seshi's`);
    else if (ours && text !== piExtension(context.command)) {
      notes.push("the pi extension is out of date: run seshi capture install pi");
    }
    return {
      installed: ours,
      files: [{ path, present: text !== undefined, ours }],
      notes,
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
      depths: [2],
      match: (relative) => /^[^/]+\/[^/]+_[\w-]+\.jsonl$/.test(relative),
    },
  ],
  identify: identifyPiSession,
  locate: locatePiSession,
  installer: piInstaller,
};
