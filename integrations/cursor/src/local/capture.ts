/** Capturing Cursor's local agent sessions, from the IDE and the CLI (F9): its hook payloads,
 * where its agent transcripts are, and the installer that merges seshi's hooks into
 * `~/.cursor/hooks.json`. Loaded alone by `seshi hook cursor <event>`, so it imports only
 * `@seshi/kit` and `node:` modules (X3.3).
 *
 * Cursor runs each hook in `hooks.json` (`{"version": 1, "hooks": {"<event>": [{"command"}]}}`)
 * with a JSON object on stdin: `conversation_id`, `generation_id`, `hook_event_name`,
 * `workspace_roots` and, in recent versions, `transcript_path`, which can be empty on a
 * conversation's first prompt (F9.2). So a session is keyed by its conversation id, and the
 * uploader finds its transcript, `~/.cursor/projects/<project>/agent-transcripts/<id>.jsonl`
 * (`<id>/<id>.jsonl` from Cursor 3), when the hook did not say. The transcript does not say where the agent ran, so the sweep
 * captures only conversations a hook has seen (the capture rules need the folder). */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  attachStatusLine,
  type CaptureAgent,
  type CaptureHost,
  type CloudMarker,
  captureCommandPrompt,
  captureDir,
  commandLine,
  detachStatusLine,
  type HookCapture,
  type HookHandler,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  installOwnedFiles,
  installSkill,
  isOurSkill,
  isSeshiHook,
  type OwnedFile,
  ownedFileNotes,
  ownedFileState,
  type ProjectContext,
  type ProjectInstaller,
  payloadObject,
  readJsonConfig,
  removeOwnedFiles,
  removeSkill,
  type StatusLineTarget,
  skillFile,
  statusLineNotes,
  stringField,
  type TranscriptInfo,
  writeFileAtomic,
  writeJsonConfig,
} from "@seshi/kit";

export const AGENT = "cursor";

export const CURSOR_EVENTS = ["stop", "sessionEnd", "beforeSubmitPrompt"] as const;

export function cursorDir(host: CaptureHost): string {
  return join(host.home, ".cursor");
}

function capture(payload: unknown, final: boolean, host?: CaptureHost): HookCapture {
  const object = payloadObject(payload, AGENT);
  const conversation = stringField(object, "conversation_id") ?? stringField(object, "session_id");
  if (!conversation) throw new Error(`${AGENT}: the hook payload has no conversation_id`);
  // Cursor Cloud has sent a null `transcript_path`; Cursor also names the transcript in the
  // hook's environment.
  const path =
    stringField(object, "transcript_path") ?? (host?.env.CURSOR_TRANSCRIPT_PATH || undefined);
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
  { event: "stop", parse: (payload, host) => ({ captures: [capture(payload, false, host)] }) },
  { event: "sessionEnd", parse: (payload, host) => ({ captures: [capture(payload, true, host)] }) },
  {
    // `/session-capture off|on|status` typed as a message of its own: the hook does it, outside the
    // agent's sandbox, and stops the message there. Cursor shows a hook's `user_message` only
    // when the hook blocks the prompt, and the model has nothing to do.
    event: "beforeSubmitPrompt",
    reply: (message) => ({ continue: false, user_message: message }),
    parse(payload) {
      const asked = captureCommandPrompt(
        stringField(payloadObject(payload, AGENT), "prompt") ?? "",
      );
      const { session_id, cwd } = capture(payload, false);
      const which = { session_id, ...(cwd ? { cwd } : {}) };
      if (!asked) return { captures: [], active: which };
      return asked === "status"
        ? { captures: [], active: which, announce: which }
        : { captures: [], active: which, request: { action: asked, session: which } };
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
    const dir = join(projects, project, "agent-transcripts");
    for (const file of [
      join(dir, sessionId, `${sessionId}.jsonl`),
      join(dir, `${sessionId}.jsonl`),
    ]) {
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

/** A transcript under a project's `agent-transcripts`: `<id>.jsonl`, or, from Cursor 3,
 * `<id>/<id>.jsonl`. */
export function isCursorTranscript(relative: string): boolean {
  const nested = /^[^/]+\/agent-transcripts\/([^/]+)\/([^/]+)\.jsonl$/.exec(relative);
  if (nested) return nested[1] === nested[2];
  return /^[^/]+\/agent-transcripts\/[^/]+\.jsonl$/.test(relative);
}

interface CursorHook {
  command?: unknown;
  [key: string]: unknown;
}

/** The Cursor CLI's config, whose `statusLine` takes the same shape as Claude Code's. */
function cliConfigPath(host: CaptureHost): string {
  return join(cursorDir(host), "cli-config.json");
}

function statusTarget(host: CaptureHost): StatusLineTarget {
  return {
    label: "The Cursor CLI",
    chain: join(cursorDir(host), "seshi-statusline.json"),
    args: ["--agent", AGENT],
  };
}

function installStatusLine(context: InstallContext): { changed: string[]; notes: string[] } {
  const path = cliConfigPath(context);
  const config = readJsonConfig(path);
  const status = attachStatusLine(config, context.command, statusTarget(context));
  writeJsonConfig(path, config);
  return { changed: [path, ...status.changed], notes: status.notes };
}

function removeStatusLine(context: InstallContext): string[] {
  const path = cliConfigPath(context);
  if (!existsSync(path)) return [];
  const config = readJsonConfig(path);
  const status = detachStatusLine(config, statusTarget(context));
  if (!status.touched) return status.removed;
  writeJsonConfig(path, config);
  return [path, ...status.removed];
}

export const EXTENSION_ID = "dosu.seshi-cursor";

/** Whether the status bar extension is installed: Cursor keeps each extension in
 * `~/.cursor/extensions/<publisher>.<name>-<version>`. */
function hasExtension(host: CaptureHost): boolean {
  try {
    return readdirSync(join(cursorDir(host), "extensions")).some((n) =>
      n.toLowerCase().startsWith(`${EXTENSION_ID}-`),
    );
  } catch {
    return false;
  }
}

const EXTENSION_NOTE = `for Session Capture in Cursor's status bar, install the "seshi Session Capture" extension (${EXTENSION_ID}) from the Extensions view`;

function skillsDir(host: CaptureHost): string {
  return join(cursorDir(host), "skills");
}

function hooksPath(host: CaptureHost): string {
  return join(cursorDir(host), "hooks.json");
}

function hooksTable(config: Record<string, unknown>, path: string): Record<string, CursorHook[]> {
  const hooks = config.hooks;
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error(`${path} has a 'hooks' that is not an object`);
  }
  return hooks as Record<string, CursorHook[]>;
}

const list = (value: unknown): CursorHook[] => (Array.isArray(value) ? value : []);

/* Cursor Cloud agents run in a VM Cursor builds from the repository, and run only the
 * repository's hooks (`<repo>/.cursor/hooks.json`), never `~/.cursor/hooks.json`. So for them
 * seshi's hooks are committed to the repository, and the repository's environment setup
 * (`.cursor/environment.json`) installs seshi on the VM and signs it in.
 *
 * Every teammate's Cursor runs those committed hooks too, beside their own. They must do nothing
 * there: Cursor documents no hook payload field or environment variable that says a hook runs
 * in a cloud agent (`is_background_agent` comes only with `sessionStart` and `sessionEnd`,
 * which cloud agents never fire), so the VM's setup step marks the machine
 * (`seshi capture install cursor --cloud` writes `cursor-cloud` in seshi's state folder) and the
 * committed hooks act only on a marked machine. The marker is seshi's own, written only by a
 * step that runs only on the VM, and costs one file check. The user-level hooks stand aside on a
 * marked machine, so the two never both upload a conversation. */

/** The flag the committed hooks pass: act only on a Cursor Cloud VM. */
export const CLOUD_FLAG = "--cloud";

/** Seconds Cursor gives each committed hook: `stop` uploads before it returns. */
export const PROJECT_TIMEOUTS: Readonly<Record<(typeof CURSOR_EVENTS)[number], number>> = {
  stop: 60,
  sessionEnd: 60,
  beforeSubmitPrompt: 30,
};

/** The setup script, beside the hooks; `.cursor/environment.json` runs it. */
export const SETUP_SCRIPT = "seshi-cloud.sh";
const SETUP_MARKER = "seshi-cursor-cloud-setup";

/** A committed hook's command: `seshi` from the PATH (or where the setup script puts it), never
 * this machine's path; without seshi, it exits 0 with nothing said. POSIX sh: Cursor runs hooks
 * through PowerShell on Windows, where it fails open. */
export function projectHookCommand(event: string): string {
  return `s=$(command -v seshi || echo "$HOME/.local/bin/seshi"); [ -x "$s" ] || exit 0; exec "$s" hook ${AGENT} ${event} ${CLOUD_FLAG}`;
}

export function cloudMarkerPath(host: CaptureHost): string {
  return join(captureDir(host), "cursor-cloud");
}

export const cursorCloud: CloudMarker = {
  is: (host) => existsSync(cloudMarkerPath(host)),
  mark(host) {
    const path = cloudMarkerPath(host);
    if (existsSync(path)) return { changed: [], notes: [] };
    writeFileAtomic(
      path,
      "This machine is a Cursor Cloud agent VM: seshi's hooks committed to the repository capture here, and seshi's user-level Cursor hooks stand aside (seshi capture install cursor --cloud).\n",
    );
    return { changed: [path], notes: [] };
  },
  unmark(host) {
    const path = cloudMarkerPath(host);
    if (!existsSync(path)) return { changed: [], notes: [] };
    rmSync(path, { force: true });
    return { changed: [path], notes: [] };
  },
};

export function setupScript(version: string): string {
  return `#!/bin/sh
# ${SETUP_MARKER}: Session Capture for Cursor Cloud agents.
# Written by \`seshi capture install cursor --project\`, which rewrites it: change the version there.
#
# .cursor/environment.json runs it:
#   "install": "sh .cursor/${SETUP_SCRIPT} install"   puts seshi ${version} on the VM (in the build)
#   "start":   "sh .cursor/${SETUP_SCRIPT} start"     marks the VM and signs seshi in, every run
#
# It reads two Cursor secrets, SESHI_SERVER (the seshi server's URL) and SESHI_TOKEN (a device
# token for the cloud owner, cursor-cloud), and writes neither anywhere in the repository. Cursor
# adds secrets only when an agent starts, so signing in is the start step's. It never fails the
# environment: without seshi or the secrets, cloud sessions are just not captured.
set -u
version="${version}"
dir=/usr/local/bin
[ -w "$dir" ] || dir="$HOME/.local/bin"
PATH="$dir:$PATH"

say() {
  printf 'seshi (Cursor Cloud): %s\\n' "$*" >&2
}

ensure() {
  [ "$(seshi --version 2>/dev/null)" = "seshi $version" ] && return 0
  mkdir -p "$dir"
  curl -fsSL https://github.com/dosu-ai/sessiondb/releases/latest/download/install.sh |
    sh -s -- --version "$version" --dir "$dir" --no-modify-path >&2
  [ "$(seshi --version 2>/dev/null)" = "seshi $version" ] && return 0
  say "could not install seshi $version; cloud sessions are not captured"
  return 1
}

case "\${1:-}" in
  install)
    ensure || true
    ;;
  start)
    ensure || exit 0
    seshi capture install cursor --cloud >&2 || exit 0
    if [ -z "\${SESHI_SERVER:-}" ] || [ -z "\${SESHI_TOKEN:-}" ]; then
      say "the SESHI_SERVER and SESHI_TOKEN secrets are not set; cloud sessions are not uploaded"
      exit 0
    fi
    printf %s "$SESHI_TOKEN" | seshi login --server "$SESHI_SERVER" --token - >&2 ||
      say "could not sign in to $SESHI_SERVER; cloud sessions are not uploaded (seshi doctor says why)"
    ;;
  *)
    say "usage: sh .cursor/${SETUP_SCRIPT} install|start"
    exit 2
    ;;
esac
exit 0
`;
}

function projectFiles(dir: string) {
  const cursor = join(dir, ".cursor");
  return { hooks: join(cursor, "hooks.json"), script: join(cursor, SETUP_SCRIPT) };
}

function setupFile(context: ProjectContext): OwnedFile {
  return {
    path: projectFiles(context.dir).script,
    text: setupScript(context.version),
    marker: SETUP_MARKER,
  };
}

/** Whether a committed hook is seshi's: its command runs `seshi hook cursor <event> --cloud`. */
function isProjectHook(command: unknown): boolean {
  return (
    isSeshiHook(command, AGENT) ||
    (typeof command === "string" &&
      command.includes(` hook ${AGENT} `) &&
      command.includes(CLOUD_FLAG))
  );
}

/** What to add to `.cursor/environment.json` (or the Environments page's setup): seshi never
 * edits that file, which decides how the whole VM is built. */
export function environmentNote(): string {
  return `add to .cursor/environment.json (or your Cursor environment's setup): "install": "sh .cursor/${SETUP_SCRIPT} install" and "start": "sh .cursor/${SETUP_SCRIPT} start", run after your own; add the Cursor secrets SESHI_SERVER and SESHI_TOKEN (docs/capture.md#cursor-cloud-agents)`;
}

export const cursorProjectInstaller: ProjectInstaller = {
  async install(context) {
    const { hooks: path } = projectFiles(context.dir);
    const config = readJsonConfig(path);
    const before = existsSync(path) ? JSON.stringify(config) : undefined;
    const table = hooksTable(config, path);
    for (const event of CURSOR_EVENTS) {
      const entry = { command: projectHookCommand(event), timeout: PROJECT_TIMEOUTS[event] };
      const hooks = list(table[event]);
      const at = hooks.findIndex((h) => isProjectHook(h.command));
      if (at === -1) hooks.push(entry);
      else {
        hooks[at] = { ...hooks[at], ...entry };
        table[event] = hooks.filter((h, i) => i <= at || !isProjectHook(h.command));
        continue;
      }
      table[event] = hooks;
    }
    const next = { version: config.version ?? 1, ...config, hooks: table };
    const changed: string[] = [];
    if (before !== JSON.stringify(next)) {
      writeJsonConfig(path, next);
      changed.push(path);
    }
    const script = installOwnedFiles([setupFile(context)], `${AGENT} (cloud)`);
    return {
      changed: [...changed, ...script.changed],
      notes: [...script.notes, environmentNote()],
    };
  },

  async uninstall(context) {
    const { hooks: path } = projectFiles(context.dir);
    const removed = removeOwnedFiles([setupFile(context)]);
    if (!existsSync(path)) return { changed: removed, notes: [] };
    const config = readJsonConfig(path);
    const table = hooksTable(config, path);
    let touched = false;
    for (const event of Object.keys(table)) {
      const hooks = list(table[event]);
      const kept = hooks.filter((h) => !isProjectHook(h.command));
      if (kept.length === hooks.length) continue;
      touched = true;
      if (kept.length > 0) table[event] = kept;
      else delete table[event];
    }
    if (!touched) return { changed: removed, notes: [] };
    writeJsonConfig(path, { ...config, hooks: table });
    return {
      changed: [path, ...removed],
      notes: [`take seshi's install and start steps out of .cursor/environment.json`],
    };
  },

  async status(context) {
    const { hooks: path } = projectFiles(context.dir);
    const present = existsSync(path);
    const table = present ? hooksTable(readJsonConfig(path), path) : {};
    const missing = CURSOR_EVENTS.filter(
      (e) => !list(table[e]).some((h) => isProjectHook(h.command)),
    );
    const script = ownedFileState(setupFile(context));
    return {
      installed: present && missing.length === 0 && script.ours,
      files: [
        { path, present, ours: present && missing.length < CURSOR_EVENTS.length },
        { path: script.path, present: script.present, ours: script.ours },
      ],
      notes: [
        ...(present && missing.length > 0 && missing.length < CURSOR_EVENTS.length
          ? [`hooks missing for ${missing.join(", ")}: run seshi capture install cursor --project`]
          : []),
        ...ownedFileNotes([script], `${AGENT} --project`),
      ],
    };
  },
};

export const cursorInstaller: Installer = {
  detect: (host) => existsSync(cursorDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const path = hooksPath(context);
    const config = readJsonConfig(path);
    const table = hooksTable(config, path);
    for (const event of CURSOR_EVENTS) {
      const command = `${commandLine(context.command)} hook ${AGENT} ${event}`;
      const hooks = list(table[event]);
      const ours = hooks.filter((h) => isSeshiHook(h.command, AGENT, commandLine(context.command)));
      if (ours.length > 0) for (const hook of ours) hook.command = command;
      else hooks.push({ command });
      table[event] = hooks;
    }
    writeJsonConfig(path, { version: config.version ?? 1, ...config, hooks: table });
    const status = installStatusLine(context);
    const skill = installSkill(skillsDir(context), context.command);
    return {
      changed: [path, ...status.changed, ...skill.changed],
      notes: [...status.notes, ...skill.notes, ...(hasExtension(context) ? [] : [EXTENSION_NOTE])],
    };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const path = hooksPath(context);
    const skill = [...removeStatusLine(context), ...removeSkill(skillsDir(context))];
    if (!existsSync(path)) return { changed: skill, notes: [] };
    const config = readJsonConfig(path);
    const table = hooksTable(config, path);
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
    const table = present ? hooksTable(readJsonConfig(path), path) : {};
    const missing = CURSOR_EVENTS.filter(
      (e) =>
        !list(table[e]).some((h) => isSeshiHook(h.command, AGENT, commandLine(context.command))),
    );
    return {
      installed: present && missing.length === 0,
      files: [
        { path, present, ours: present && missing.length < CURSOR_EVENTS.length },
        {
          path: skillFile(skillsDir(context)),
          present: existsSync(skillFile(skillsDir(context))),
          ours: isOurSkill(skillFile(skillsDir(context))),
        },
      ],
      notes: [
        ...(present && missing.length > 0 && missing.length < CURSOR_EVENTS.length
          ? [`hooks missing for ${missing.join(", ")}: run seshi capture install cursor`]
          : []),
        ...(existsSync(cliConfigPath(context))
          ? statusLineNotes(readJsonConfig(cliConfigPath(context)), statusTarget(context), AGENT)
          : []),
      ],
    };
  },

  project: cursorProjectInstaller,
  cloud: cursorCloud,
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
      depths: [3, 4],
      match: isCursorTranscript,
    },
  ],
  identify: identifyCursorTranscript,
  locate: locateCursorTranscript,
  installer: cursorInstaller,
};
