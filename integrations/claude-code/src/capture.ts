/** Capturing Claude Code sessions (F9): its hook payloads, where its transcripts are, and the
 * installer that merges seshi's hooks, status line and `/seshi` skill into Claude Code's
 * settings. Loaded alone by `seshi hook claude-code <event>`, so it imports only `@seshi/kit`
 * and `node:` modules (X3.3), never the transcript adapter.
 *
 * Claude Code keeps its files in `~/.claude` (`CLAUDE_CONFIG_DIR` moves it): transcripts in
 * `projects/<project>/<session>.jsonl`, a subagent's in
 * `projects/<project>/<session>/subagents/agent-<id>.jsonl`, settings in `settings.json`. Every
 * hook gets a JSON object on stdin with `session_id`, `transcript_path`, `cwd` and
 * `hook_event_name`; SubagentStop adds `agent_id` and `agent_transcript_path` in recent
 * versions. A SessionStart hook may append `export` lines to the file `CLAUDE_ENV_FILE` names,
 * and Claude Code sets them for every command it runs afterwards in that session: that is how
 * `seshi capture off --session` (the `/seshi` skill) knows which session it is in. */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  commandLine,
  expandTilde,
  type HookCapture,
  type HookHandler,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  isSeshiHook,
  isSeshiStatusline,
  payloadObject,
  readJsonConfig,
  readTextFile,
  stringField,
  type TranscriptInfo,
  writeFileAtomic,
  writeJsonConfig,
} from "@seshi/kit";

export const AGENT = "claude-code";

export const CLAUDE_CODE_EVENTS = [
  "SessionStart",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

export function claudeDir(host: CaptureHost): string {
  const configured = host.env.CLAUDE_CONFIG_DIR;
  return configured ? expandTilde(configured, host.home) : join(host.home, ".claude");
}

function common(payload: unknown): { session: string; path?: string; cwd?: string } {
  const object = payloadObject(payload, AGENT);
  const session = stringField(object, "session_id");
  if (!session) throw new Error(`${AGENT}: the hook payload has no session_id`);
  const path = stringField(object, "transcript_path");
  const cwd = stringField(object, "cwd");
  return { session, ...(path ? { path } : {}), ...(cwd ? { cwd } : {}) };
}

function capture(payload: unknown, final = false): HookCapture {
  const { session, path, cwd } = common(payload);
  return {
    session_id: session,
    ...(path ? { transcript_path: path } : {}),
    ...(cwd ? { cwd } : {}),
    ...(final ? { final } : {}),
  };
}

const turn = (event: string, final = false): HookHandler => ({
  event,
  parse: (payload) => ({ captures: [capture(payload, final)] }),
});

export function subagentSessionId(agentId: string): string {
  return agentId.startsWith("agent-") ? agentId : `agent-${agentId}`;
}

export const CLAUDE_CODE_HOOKS: readonly HookHandler[] = [
  {
    event: "SessionStart",
    parse(payload, host) {
      const { session } = common(payload);
      const file = host.env.CLAUDE_ENV_FILE;
      return {
        captures: [],
        ...(file
          ? { exportEnv: { file, vars: { SESHI_SESSION_ID: session, SESHI_AGENT: AGENT } } }
          : {}),
      };
    },
  },
  turn("Stop"),
  {
    event: "SubagentStop",
    parse(payload) {
      const main = capture(payload);
      const object = payloadObject(payload, AGENT);
      const agentId = stringField(object, "agent_id");
      const agentPath = stringField(object, "agent_transcript_path");
      if (!agentId || !agentPath) return { captures: [main] };
      return {
        captures: [
          main,
          {
            session_id: subagentSessionId(agentId),
            transcript_path: agentPath,
            ...(main.cwd ? { cwd: main.cwd } : {}),
            parent_session_id: main.session_id,
            final: true,
          },
        ],
      };
    },
  },
  turn("PreCompact"),
  turn("SessionEnd", true),
];

function headRecords(head: string, max = 50): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of head.split("\n").slice(0, max)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) out.push(value);
    } catch {}
  }
  return out;
}

/** Which session a Claude Code transcript is: the file's name (the session id, or `agent-<id>`
 * for a subagent), where it ran and when it started, from its first records. */
export function identifyClaudeTranscript(path: string, head: string): TranscriptInfo | null {
  if (!path.endsWith(".jsonl")) return null;
  const records = headRecords(head);
  const turn = records.find(
    (r) =>
      (r.type === "user" || r.type === "assistant") &&
      typeof r.sessionId === "string" &&
      typeof r.message === "object",
  );
  if (!turn) return null;
  const stem = basename(path, ".jsonl");
  const sidechain = basename(dirname(path)) === "subagents";
  const cwd = records.find((r) => typeof r.cwd === "string")?.cwd as string | undefined;
  const started = records.find((r) => typeof r.timestamp === "string")?.timestamp as
    | string
    | undefined;
  return {
    session_id: stem,
    ...(cwd ? { cwd } : {}),
    ...(started ? { started_at: started } : {}),
    ...(sidechain ? { parent_session_id: turn.sessionId as string } : {}),
  };
}

function safeDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function locateClaudeTranscript(sessionId: string, host: CaptureHost): string | undefined {
  if (!/^[\w.-]+$/.test(sessionId)) return undefined;
  const projects = join(claudeDir(host), "projects");
  for (const project of safeDirs(projects)) {
    const file = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
    if (sessionId.startsWith("agent-")) {
      for (const session of safeDirs(join(projects, project))) {
        const sub = join(projects, project, session, "subagents", `${sessionId}.jsonl`);
        if (existsSync(sub)) return sub;
      }
    }
  }
  return undefined;
}

/** The account Claude Code is signed in with, from `~/.claude.json`: its id only. */
export function claudeAccountIds(host: CaptureHost): Record<string, string> {
  const configured = host.env.CLAUDE_CONFIG_DIR;
  const file = configured
    ? join(expandTilde(configured, host.home), ".claude.json")
    : join(host.home, ".claude.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      oauthAccount?: { accountUuid?: unknown };
    };
    const id = parsed.oauthAccount?.accountUuid;
    return typeof id === "string" && id !== "" ? { anthropic: id } : {};
  } catch {
    return {};
  }
}

export const SKILL_MARKER =
  "<!-- written by seshi capture install; seshi capture uninstall removes it -->";

export function seshiSkill(command: readonly string[]): string {
  const seshi = commandLine(command);
  return `---
name: seshi
description: Turn Session Capture off or on for this Claude Code session, or show whether it is being captured. Use when the user runs /seshi, or asks to stop, pause, resume or check session capture or seshi.
---
${SKILL_MARKER}

# Session Capture

seshi uploads this session to the team's session store as it happens. The user controls it:

- \`/seshi capture off\`: run \`${seshi} capture off --session\`. Nothing more of this session is
  uploaded, and what was already uploaded is retracted from the server.
- \`/seshi capture on\`: run \`${seshi} capture on --session\`. The session is uploaded again
  from its start.
- \`/seshi capture status\` or \`/seshi\`: run \`${seshi} capture status --session\` and tell the
  user what it says.

\`--session\` with no id means this session: seshi reads it from \`SESHI_SESSION_ID\`, which its
SessionStart hook sets. Report the command's output to the user in one or two sentences. Do not
run any other seshi command unless the user asks for it.
`;
}

function settingsPath(host: CaptureHost): string {
  return join(claudeDir(host), "settings.json");
}

function skillPath(host: CaptureHost): string {
  return join(claudeDir(host), "skills", "seshi", "SKILL.md");
}

interface HookEntry {
  type?: string;
  command?: unknown;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}

type HooksTable = Record<string, HookGroup[]>;

function hooksOf(settings: Record<string, unknown>): HooksTable {
  const hooks = settings.hooks;
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("Claude Code's settings.json has a 'hooks' that is not an object");
  }
  return hooks as HooksTable;
}

function groupsOf(table: HooksTable, event: string): HookGroup[] {
  const groups = table[event];
  return Array.isArray(groups) ? groups : [];
}

function hasOurs(groups: HookGroup[], own: string): boolean {
  return groups.some((g) => (g.hooks ?? []).some((h) => isSeshiHook(h.command, AGENT, own)));
}

const STATUSLINE_NOTE =
  "Claude Code already has a status line, so it was kept; add `seshi statusline` to it to show Session Capture";

export const claudeCodeInstaller: Installer = {
  detect: (host) => existsSync(claudeDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const path = settingsPath(context);
    const settings = readJsonConfig(path);
    const table = hooksOf(settings);
    const notes: string[] = [];
    for (const event of CLAUDE_CODE_EVENTS) {
      const command = `${commandLine(context.command)} hook ${AGENT} ${event}`;
      const groups = groupsOf(table, event);
      let found = false;
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          if (isSeshiHook(hook.command, AGENT, commandLine(context.command))) {
            hook.command = command;
            found = true;
          }
        }
      }
      if (!found) groups.push({ hooks: [{ type: "command", command, timeout: 30 }] });
      table[event] = groups;
    }
    settings.hooks = table;
    const statusCommand = `${commandLine(context.command)} statusline`;
    const status = settings.statusLine as { command?: unknown } | undefined;
    if (status === undefined) {
      settings.statusLine = { type: "command", command: statusCommand, padding: 0 };
    } else if (isSeshiStatusline(status.command)) {
      settings.statusLine = { ...status, command: statusCommand };
    } else {
      notes.push(STATUSLINE_NOTE);
    }
    writeJsonConfig(path, settings);
    const changed = [path];
    const skill = skillPath(context);
    const existing = readTextFile(skill);
    if (existing === undefined || existing.includes(SKILL_MARKER)) {
      writeFileAtomic(skill, seshiSkill(context.command));
      changed.push(skill);
    } else {
      notes.push(`${skill} is someone else's skill, so it was left as it is`);
    }
    return { changed, notes };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const path = settingsPath(context);
    const changed: string[] = [];
    if (existsSync(path)) {
      const settings = readJsonConfig(path);
      const table = hooksOf(settings);
      let touched = false;
      for (const event of Object.keys(table)) {
        const groups = groupsOf(table, event);
        const kept: HookGroup[] = [];
        for (const group of groups) {
          const hooks = (group.hooks ?? []).filter(
            (h) => !isSeshiHook(h.command, AGENT, commandLine(context.command)),
          );
          if (hooks.length !== (group.hooks ?? []).length) touched = true;
          if (hooks.length > 0 || group.hooks === undefined) kept.push({ ...group, hooks });
        }
        if (kept.length > 0) table[event] = kept;
        else {
          delete table[event];
          touched = true;
        }
      }
      if (Object.keys(table).length === 0) delete settings.hooks;
      else settings.hooks = table;
      const status = settings.statusLine as { command?: unknown } | undefined;
      if (status && isSeshiStatusline(status.command)) {
        delete settings.statusLine;
        touched = true;
      }
      if (touched) {
        writeJsonConfig(path, settings);
        changed.push(path);
      }
    }
    const skill = skillPath(context);
    if (readTextFile(skill)?.includes(SKILL_MARKER)) {
      rmSync(dirname(skill), { recursive: true, force: true });
      changed.push(skill);
    }
    return { changed, notes: [] };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const path = settingsPath(context);
    const present = existsSync(path);
    const settings = present ? readJsonConfig(path) : {};
    const table = present ? hooksOf(settings) : {};
    const missing = CLAUDE_CODE_EVENTS.filter(
      (e) => !hasOurs(groupsOf(table, e), commandLine(context.command)),
    );
    const status = settings.statusLine as { command?: unknown } | undefined;
    const notes: string[] = [];
    if (present && missing.length > 0 && missing.length < CLAUDE_CODE_EVENTS.length) {
      notes.push(`hooks missing for ${missing.join(", ")}: run seshi capture install claude-code`);
    }
    if (status && !isSeshiStatusline(status.command)) notes.push(STATUSLINE_NOTE);
    const skill = skillPath(context);
    return {
      installed: present && missing.length === 0,
      files: [
        { path, present, ours: present && missing.length < CLAUDE_CODE_EVENTS.length },
        {
          path: skill,
          present: existsSync(skill),
          ours: readTextFile(skill)?.includes(SKILL_MARKER) ?? false,
        },
      ],
      notes,
    };
  },
};

export const CLAUDE_CODE_CAPTURE: CaptureAgent = {
  name: AGENT,
  format: AGENT,
  encoding: "jsonl",
  chunkable: true,
  hooks: CLAUDE_CODE_HOOKS,
  sweep: [
    {
      root: "~/.claude/projects",
      resolve: (host) => join(claudeDir(host), "projects"),
      depths: [2, 4],
      match: (relative) =>
        /^[^/]+\/[^/]+\.jsonl$/.test(relative) ||
        /^[^/]+\/[^/]+\/subagents\/agent-[^/]+\.jsonl$/.test(relative),
    },
  ],
  identify: identifyClaudeTranscript,
  locate: locateClaudeTranscript,
  accountIds: claudeAccountIds,
  installer: claudeCodeInstaller,
};
