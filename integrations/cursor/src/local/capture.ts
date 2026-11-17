/** Capturing Cursor's local agent sessions, from the IDE and the CLI (F9): its hook payloads,
 * where its agent transcripts are, and the installer that merges seshi's hooks into
 * `~/.cursor/hooks.json`. Loaded alone by `seshi hook cursor <event>`, so it imports only
 * `@seshi/kit` and `node:` modules (X3.3).
 *
 * Cursor runs each hook in `hooks.json` (`{"version": 1, "hooks": {"<event>": [{"command"}]}}`)
 * with a JSON object on stdin: `conversation_id`, `generation_id`, `hook_event_name`,
 * `workspace_roots` and, in recent versions, `transcript_path`, which can be empty on a
 * conversation's first prompt (F9.2). So a session is keyed by its conversation id, and the
 * uploader finds its transcript, `~/.cursor/projects/<project>/agent-transcripts/<id>.jsonl`,
 * when the hook did not say. The transcript does not say where the agent ran, so the sweep
 * captures only conversations a hook has seen (the capture rules need the folder). */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  commandLine,
  type HookCapture,
  type HookHandler,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  installSkill,
  isOurSkill,
  isSeshiHook,
  payloadObject,
  readJsonConfig,
  removeSkill,
  seshiPrompt,
  stringField,
  type TranscriptInfo,
  writeJsonConfig,
} from "@seshi/kit";

export const AGENT = "cursor";

export const CURSOR_EVENTS = ["stop", "sessionEnd", "beforeSubmitPrompt"] as const;

export function cursorDir(host: CaptureHost): string {
  return join(host.home, ".cursor");
}

function capture(payload: unknown, final: boolean): HookCapture {
  const object = payloadObject(payload, AGENT);
  const conversation = stringField(object, "conversation_id") ?? stringField(object, "session_id");
  if (!conversation) throw new Error(`${AGENT}: the hook payload has no conversation_id`);
  const path = stringField(object, "transcript_path");
  const roots = object.workspace_roots;
  const cwd =
    Array.isArray(roots) && typeof roots[0] === "string" && roots[0] !== ""
      ? (roots[0] as string)
      : stringField(object, "cwd");
  return {
    session_id: conversation,
    ...(path ? { transcript_path: path } : {}),
    ...(cwd ? { cwd } : {}),
    ...(final ? { final } : {}),
  };
}

export const CURSOR_HOOKS: readonly HookHandler[] = [
  { event: "stop", parse: (payload) => ({ captures: [capture(payload, false)] }) },
  { event: "sessionEnd", parse: (payload) => ({ captures: [capture(payload, true)] }) },
  {
    // `/seshi off|on|status` typed as a message of its own: the hook does it, outside the
    // agent's sandbox, and stops the message there. Cursor shows a hook's `user_message` only
    // when the hook blocks the prompt, and the model has nothing to do.
    event: "beforeSubmitPrompt",
    reply: (message) => ({ continue: false, user_message: message }),
    parse(payload) {
      const asked = seshiPrompt(stringField(payloadObject(payload, AGENT), "prompt") ?? "");
      if (!asked) return { captures: [] };
      const { session_id, cwd } = capture(payload, false);
      const which = { session_id, ...(cwd ? { cwd } : {}) };
      return asked === "status"
        ? { captures: [], announce: which }
        : { captures: [], request: { action: asked, session: which } };
    },
  },
];

/** Which conversation an agent transcript is: its file name. The first records must look like
 * Cursor's (`{role, message}`). */
export function identifyCursorTranscript(path: string, head: string): TranscriptInfo | null {
  if (!path.endsWith(".jsonl")) return null;
  const line = head.split("\n").find((l) => l.trim() !== "");
  if (!line) return null;
  try {
    const row = JSON.parse(line) as { role?: unknown; message?: unknown };
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.message !== "object") {
      return null;
    }
  } catch {
    return null;
  }
  return { session_id: basename(path, ".jsonl") };
}

export function locateCursorTranscript(sessionId: string, host: CaptureHost): string | undefined {
  if (!/^[\w.-]+$/.test(sessionId)) return undefined;
  const projects = join(cursorDir(host), "projects");
  let names: string[] = [];
  try {
    names = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const project of names) {
    const file = join(projects, project, "agent-transcripts", `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

interface CursorHook {
  command?: unknown;
  [key: string]: unknown;
}

function skillPath(host: CaptureHost): string {
  return join(cursorDir(host), "skills", "seshi", "SKILL.md");
}

function hooksPath(host: CaptureHost): string {
  return join(cursorDir(host), "hooks.json");
}

function hooksTable(config: Record<string, unknown>): Record<string, CursorHook[]> {
  const hooks = config.hooks;
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("~/.cursor/hooks.json has a 'hooks' that is not an object");
  }
  return hooks as Record<string, CursorHook[]>;
}

const list = (value: unknown): CursorHook[] => (Array.isArray(value) ? value : []);

export const cursorInstaller: Installer = {
  detect: (host) => existsSync(cursorDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const path = hooksPath(context);
    const config = readJsonConfig(path);
    const table = hooksTable(config);
    for (const event of CURSOR_EVENTS) {
      const command = `${commandLine(context.command)} hook ${AGENT} ${event}`;
      const hooks = list(table[event]);
      const ours = hooks.filter((h) => isSeshiHook(h.command, AGENT, commandLine(context.command)));
      if (ours.length > 0) for (const hook of ours) hook.command = command;
      else hooks.push({ command });
      table[event] = hooks;
    }
    writeJsonConfig(path, { version: config.version ?? 1, ...config, hooks: table });
    const skill = installSkill(skillPath(context), context.command);
    return { changed: [path, ...skill.changed], notes: skill.notes };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const path = hooksPath(context);
    const skill = removeSkill(skillPath(context));
    if (!existsSync(path)) return { changed: skill, notes: [] };
    const config = readJsonConfig(path);
    const table = hooksTable(config);
    let touched = false;
    for (const event of Object.keys(table)) {
      const hooks = list(table[event]);
      const kept = hooks.filter(
        (h) => !isSeshiHook(h.command, AGENT, commandLine(context.command)),
      );
      if (kept.length === hooks.length) continue;
      touched = true;
      if (kept.length > 0) table[event] = kept;
      else delete table[event];
    }
    if (!touched) return { changed: skill, notes: [] };
    writeJsonConfig(path, { ...config, hooks: table });
    return { changed: [path, ...skill], notes: [] };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const path = hooksPath(context);
    const present = existsSync(path);
    const table = present ? hooksTable(readJsonConfig(path)) : {};
    const missing = CURSOR_EVENTS.filter(
      (e) =>
        !list(table[e]).some((h) => isSeshiHook(h.command, AGENT, commandLine(context.command))),
    );
    return {
      installed: present && missing.length === 0,
      files: [
        { path, present, ours: present && missing.length < CURSOR_EVENTS.length },
        {
          path: skillPath(context),
          present: existsSync(skillPath(context)),
          ours: isOurSkill(skillPath(context)),
        },
      ],
      notes:
        present && missing.length > 0 && missing.length < CURSOR_EVENTS.length
          ? [`hooks missing for ${missing.join(", ")}: run seshi capture install cursor`]
          : [],
    };
  },
};

export const CURSOR_CAPTURE: CaptureAgent = {
  name: AGENT,
  format: AGENT,
  encoding: "jsonl",
  chunkable: true,
  hooks: CURSOR_HOOKS,
  sweep: [
    {
      root: "~/.cursor/projects",
      resolve: (host) => join(cursorDir(host), "projects"),
      depths: [3],
      match: (relative) => /^[^/]+\/agent-transcripts\/[^/]+\.jsonl$/.test(relative),
    },
  ],
  identify: identifyCursorTranscript,
  locate: locateCursorTranscript,
  installer: cursorInstaller,
};
