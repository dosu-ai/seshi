/** Capturing Codex sessions (F9): its `notify` program, where its rollouts are, and the installer
 * that points Codex's `notify` at seshi. Loaded alone by `seshi hook codex notify`, so it
 * imports only `@seshi/kit` and `node:` modules (X3.3), never the rollout adapter.
 *
 * Codex keeps its files in `~/.codex` (`CODEX_HOME` moves it): rollouts in
 * `sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl`, settings in `config.toml`. Codex
 * has one `notify` program, which it runs after every turn with a JSON argument
 * (`{"type": "agent-turn-complete", "thread-id", "turn-id", "cwd", …}`), not on stdin. Since
 * there is only one, the installer keeps whatever program was there by running it after seshi:
 * `notify = ["seshi", "hook", "codex", "notify", "--", <the old program>…]`. The rollouts are
 * also swept (F9.2), which catches turns that end without a notification. */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  commandLine,
  expandTilde,
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
  readTextFile,
  removeSkill,
  seshiPrompt,
  stringField,
  type TranscriptInfo,
  writeFileAtomic,
  writeJsonConfig,
} from "@seshi/kit";

export const AGENT = "codex";

export function codexDir(host: CaptureHost): string {
  const configured = host.env.CODEX_HOME;
  return configured ? expandTilde(configured, host.home) : join(host.home, ".codex");
}

export const CODEX_HOOKS: readonly HookHandler[] = [
  {
    event: "notify",
    parse(payload) {
      const object = payloadObject(payload, AGENT);
      // Codex sends other kinds of notification too; only a finished turn has new content.
      if (object.type !== "agent-turn-complete") return { captures: [] };
      const thread = stringField(object, "thread-id");
      if (!thread) throw new Error(`${AGENT}: the notification has no thread-id`);
      const cwd = stringField(object, "cwd");
      return { captures: [{ session_id: thread, ...(cwd ? { cwd } : {}) }] };
    },
  },
  {
    // Codex's lifecycle hook (hooks.json): nothing to upload yet, but the notice of whether
    // the session is captured.
    event: "SessionStart",
    reply: (message) => ({ systemMessage: message }),
    parse(payload) {
      const object = payloadObject(payload, AGENT);
      const session = stringField(object, "session_id");
      if (!session) throw new Error(`${AGENT}: SessionStart has no session_id`);
      const cwd = stringField(object, "cwd");
      return { captures: [], announce: { session_id: session, ...(cwd ? { cwd } : {}) } };
    },
  },
  {
    // Codex's sandbox keeps the agent's commands from writing seshi's state, so `$seshi off|on`
    // typed by the person is done here, by the hook, before the model sees the prompt.
    event: "UserPromptSubmit",
    reply: (message) => ({ systemMessage: message }),
    parse(payload) {
      const object = payloadObject(payload, AGENT);
      const asked = seshiPrompt(stringField(object, "prompt") ?? "");
      if (!asked) return { captures: [] };
      const session = stringField(object, "session_id");
      if (!session) throw new Error(`${AGENT}: UserPromptSubmit has no session_id`);
      const cwd = stringField(object, "cwd");
      const which = { session_id: session, ...(cwd ? { cwd } : {}) };
      return asked === "status"
        ? { captures: [], announce: which }
        : { captures: [], request: { action: asked, session: which } };
    },
  },
];

export { seshiPrompt };

/** Which session a rollout is: its own `session_meta` (the first; a forked rollout repeats its
 * parent's after it). */
export function identifyRollout(path: string, head: string): TranscriptInfo | null {
  if (!basename(path).startsWith("rollout-") || !path.endsWith(".jsonl")) return null;
  for (const line of head.split("\n").slice(0, 20)) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const record = row as {
      type?: unknown;
      payload?: Record<string, unknown>;
      timestamp?: unknown;
    };
    if (record.type !== "session_meta" || typeof record.payload !== "object") continue;
    const meta = record.payload ?? {};
    const id = typeof meta.id === "string" ? meta.id : undefined;
    if (!id) return null;
    const cwd = typeof meta.cwd === "string" ? meta.cwd : undefined;
    const started =
      typeof meta.timestamp === "string"
        ? meta.timestamp
        : typeof record.timestamp === "string"
          ? record.timestamp
          : undefined;
    const parent =
      typeof meta.forked_from_id === "string"
        ? meta.forked_from_id
        : typeof meta.parent_thread_id === "string"
          ? meta.parent_thread_id
          : undefined;
    return {
      session_id: id,
      ...(cwd ? { cwd } : {}),
      ...(started ? { started_at: started } : {}),
      ...(parent ? { parent_session_id: parent } : {}),
    };
  }
  return null;
}

function sortedDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** A thread's rollout, newest day first: its name ends with the thread id. */
export function locateRollout(sessionId: string, host: CaptureHost): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const sessions = join(codexDir(host), "sessions");
  const suffix = `-${sessionId}.jsonl`;
  for (const year of sortedDirs(sessions)) {
    for (const month of sortedDirs(join(sessions, year))) {
      for (const day of sortedDirs(join(sessions, year, month))) {
        const dir = join(sessions, year, month, day);
        let files: string[] = [];
        try {
          files = readdirSync(dir);
        } catch {}
        const found = files.find((f) => f.startsWith("rollout-") && f.endsWith(suffix));
        if (found) return join(dir, found);
      }
    }
  }
  return undefined;
}

const HOOK_WORDS = ["hook", AGENT, "notify"];

/** Whether a `notify` value is seshi's: `<command…> hook codex notify [-- <old program>…]`,
 * where the command is one or more words (`seshi`, `npx seshi`, a path) and one of them is a
 * `seshi` binary, or the command is `own` (the `--command` an install was given, a wrapper
 * named anything). */
export function isSeshiNotify(notify: unknown, own?: readonly string[]): notify is string[] {
  if (!Array.isArray(notify) || !notify.every((w) => typeof w === "string")) return false;
  const words = notify as string[];
  const end = words.indexOf("--");
  const head = end === -1 ? words : words.slice(0, end);
  const at = head.length - HOOK_WORDS.length;
  if (at < 1 || !HOOK_WORDS.every((w, i) => head[at + i] === w)) return false;
  const command = head.slice(0, at);
  if (own && own.length === command.length && own.every((w, i) => command[i] === w)) return true;
  return command.some((w) => basename(w.replace(/\\/g, "/")).replace(/\.exe$/i, "") === "seshi");
}

export function unwrapNestedSeshiNotify(
  notify: readonly string[],
  own?: readonly string[],
): string[] {
  let chain = [...notify];
  for (;;) {
    const at = chain.indexOf("--");
    chain = at === -1 ? [] : chain.slice(at + 1);
    if (!isSeshiNotify(chain, own)) return chain;
  }
}

/** Where a top-level `key = …` assignment is in TOML text (start and end offsets, the end after
 * its line), before the first table; null when there is none. Arrays may span lines. */
export function topLevelAssignment(
  text: string,
  key: string,
): { start: number; end: number } | null {
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=`, "m");
  const table = /^[ \t]*\[/m.exec(text);
  const limit = table ? table.index : text.length;
  const match = pattern.exec(text);
  if (!match || match.index >= limit) return null;
  let i = match.index + match[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      if (depth === 0) break;
    } else if (c === "\n" && depth <= 0) break;
  }
  return { start: match.index, end: Math.min(text.length, i + 1) };
}

/** `text` with the top-level `notify` set to `value` (removed when null), checked by parsing it
 * back; anything else in the file is left as written. */
export function withNotify(text: string, value: readonly string[] | null): string {
  const found = topLevelAssignment(text, "notify");
  const line = value === null ? "" : `notify = ${JSON.stringify(value)}\n`;
  let next: string;
  if (found) next = text.slice(0, found.start) + line + text.slice(found.end);
  else if (value === null) next = text;
  else next = line + text;
  const parsed = Bun.TOML.parse(next) as { notify?: unknown };
  const ok =
    value === null
      ? parsed.notify === undefined
      : JSON.stringify(parsed.notify) === JSON.stringify(value);
  if (!ok) throw new Error("could not edit notify in Codex's config.toml safely; edit it by hand");
  return next;
}

/** Codex reads a user's skills from `~/.agents/skills` (Cursor does too). */
function skillPath(host: CaptureHost): string {
  return join(host.home, ".agents", "skills", "seshi", "SKILL.md");
}

function configPath(host: CaptureHost): string {
  return join(codexDir(host), "config.toml");
}

function readNotify(path: string): { text: string; notify: unknown } {
  const text = readTextFile(path) ?? "";
  let parsed: { notify?: unknown };
  try {
    parsed = Bun.TOML.parse(text) as { notify?: unknown };
  } catch (err) {
    throw new Error(
      `${path} is not valid TOML (${(err as Error).message}); fix it, then run again`,
    );
  }
  return { text, notify: parsed.notify };
}

interface CodexHookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: unknown; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** Codex's lifecycle hooks: seshi adds one, on SessionStart, for the notice. */
function hooksPath(host: CaptureHost): string {
  return join(codexDir(host), "hooks.json");
}

function hooksTable(
  config: Record<string, unknown>,
  path: string,
): Record<string, CodexHookGroup[]> {
  const hooks = config.hooks;
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error(`${path} has a 'hooks' that is not an object; fix it, then run again`);
  }
  return hooks as Record<string, CodexHookGroup[]>;
}

const groupsOf = (value: unknown): CodexHookGroup[] => (Array.isArray(value) ? value : []);

function ourHook(command: readonly string[]) {
  const own = commandLine(command);
  return (h: { command?: unknown }) => isSeshiHook(h.command, AGENT, own);
}

/** seshi's lifecycle hooks: the notice when a session starts, and `$seshi off|on|status`. */
const LIFECYCLE: readonly { event: string; matcher?: string }[] = [
  { event: "SessionStart", matcher: "startup|resume" },
  { event: "UserPromptSubmit" },
];

function installNotice(context: InstallContext): string {
  const path = hooksPath(context);
  const config = readJsonConfig(path);
  const table = hooksTable(config, path);
  for (const { event, matcher } of LIFECYCLE) {
    const command = `${commandLine(context.command)} hook ${AGENT} ${event}`;
    const groups = groupsOf(table[event]);
    const ours = groups.flatMap((g) => (g.hooks ?? []).filter(ourHook(context.command)));
    if (ours.length > 0) for (const hook of ours) hook.command = command;
    else
      groups.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: 5 }],
      });
    table[event] = groups;
  }
  writeJsonConfig(path, { ...config, hooks: table });
  return path;
}

function removeNotice(context: InstallContext): string[] {
  const path = hooksPath(context);
  if (!existsSync(path)) return [];
  const config = readJsonConfig(path);
  const table = hooksTable(config, path);
  let touched = false;
  for (const { event } of LIFECYCLE) {
    const kept: CodexHookGroup[] = [];
    let ours = false;
    for (const group of groupsOf(table[event])) {
      const hooks = (group.hooks ?? []).filter((h) => !ourHook(context.command)(h));
      if (hooks.length !== (group.hooks ?? []).length) ours = true;
      if (hooks.length > 0 || group.hooks === undefined) kept.push({ ...group, hooks });
    }
    if (!ours) continue;
    touched = true;
    if (kept.length > 0) table[event] = kept;
    else delete table[event];
  }
  if (!touched) return [];
  const { hooks: _hooks, ...rest } = config;
  const next = Object.keys(table).length > 0 ? { ...rest, hooks: table } : rest;
  if (Object.keys(next).length === 0) rmSync(path, { force: true });
  else writeJsonConfig(path, next);
  return [path];
}

function hasNotice(context: InstallContext): boolean {
  const path = hooksPath(context);
  if (!existsSync(path)) return false;
  const table = hooksTable(readJsonConfig(path), path);
  return LIFECYCLE.every(({ event }) =>
    groupsOf(table[event]).some((g) => (g.hooks ?? []).some(ourHook(context.command))),
  );
}

export const codexInstaller: Installer = {
  detect: (host) => existsSync(codexDir(host)),

  async install(context: InstallContext): Promise<InstallReport> {
    const path = configPath(context);
    const { text, notify } = readNotify(path);
    const notes: string[] = [];
    let chain: string[] = [];
    if (isSeshiNotify(notify, context.command)) {
      chain = unwrapNestedSeshiNotify(notify, context.command);
    } else if (Array.isArray(notify) && notify.every((w) => typeof w === "string")) {
      chain = notify as string[];
      if (chain.length > 0) {
        notes.push(`Codex's notify program (${chain.join(" ")}) still runs, after seshi's hook`);
      }
    } else if (notify !== undefined) {
      throw new Error(`${path}: notify is not a list of words; fix it, then run again`);
    }
    const value = [
      ...context.command,
      ...HOOK_WORDS,
      ...(chain.length > 0 ? ["--", ...chain] : []),
    ];
    writeFileAtomic(path, withNotify(text, value));
    const hooks = installNotice(context);
    const skill = installSkill(skillPath(context), context.command);
    return { changed: [path, hooks, ...skill.changed], notes: [...notes, ...skill.notes] };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const path = configPath(context);
    const others = [...removeNotice(context), ...removeSkill(skillPath(context))];
    if (!existsSync(path)) return { changed: others, notes: [] };
    const { text, notify } = readNotify(path);
    if (!isSeshiNotify(notify, context.command)) return { changed: others, notes: [] };
    const chain = unwrapNestedSeshiNotify(notify, context.command);
    writeFileAtomic(path, withNotify(text, chain.length > 0 ? chain : null));
    return {
      changed: [path, ...others],
      notes: chain.length > 0 ? [`Codex's notify is ${chain.join(" ")} again`] : [],
    };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const path = configPath(context);
    const present = existsSync(path);
    const ours = present && isSeshiNotify(readNotify(path).notify, context.command);
    const skill = skillPath(context);
    const notice = hasNotice(context);
    return {
      installed: ours,
      files: [
        { path, present, ours },
        { path: hooksPath(context), present: existsSync(hooksPath(context)), ours: notice },
        { path: skill, present: existsSync(skill), ours: isOurSkill(skill) },
      ],
      notes:
        ours && !notice
          ? [
              "the session-start notice or the $seshi hook is missing: run seshi capture install codex",
            ]
          : [],
    };
  },
};

export const CODEX_CAPTURE: CaptureAgent = {
  name: AGENT,
  format: AGENT,
  encoding: "jsonl",
  chunkable: true,
  hooks: CODEX_HOOKS,
  sweep: [
    {
      root: "~/.codex/sessions",
      resolve: (host) => join(codexDir(host), "sessions"),
      depths: [4],
      match: (relative) => /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relative),
    },
  ],
  identify: identifyRollout,
  locate: locateRollout,
  installer: codexInstaller,
};
