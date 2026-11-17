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

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  expandTilde,
  type HookHandler,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  installSkill,
  isOurSkill,
  payloadObject,
  readTextFile,
  removeSkill,
  stringField,
  type TranscriptInfo,
  writeFileAtomic,
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
];

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
    const skill = installSkill(skillPath(context), context.command);
    return { changed: [path, ...skill.changed], notes: [...notes, ...skill.notes] };
  },

  async uninstall(context: InstallContext): Promise<InstallReport> {
    const path = configPath(context);
    const skill = removeSkill(skillPath(context));
    if (!existsSync(path)) return { changed: skill, notes: [] };
    const { text, notify } = readNotify(path);
    if (!isSeshiNotify(notify, context.command)) return { changed: skill, notes: [] };
    const chain = unwrapNestedSeshiNotify(notify, context.command);
    writeFileAtomic(path, withNotify(text, chain.length > 0 ? chain : null));
    return {
      changed: [path, ...skill],
      notes: chain.length > 0 ? [`Codex's notify is ${chain.join(" ")} again`] : [],
    };
  },

  async status(context: InstallContext): Promise<InstallStatus> {
    const path = configPath(context);
    const present = existsSync(path);
    const ours = present && isSeshiNotify(readNotify(path).notify, context.command);
    const skill = skillPath(context);
    return {
      installed: ours,
      files: [
        { path, present, ours },
        { path: skill, present: existsSync(skill), ours: isOurSkill(skill) },
      ],
      notes: [],
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
