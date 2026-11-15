/** Small file helpers the capture modules of integrations share: reading an agent's config file,
 * writing one back without leaving it half written, and quoting the hook command. Only `node:`
 * modules, so a capture module stays fast to load (X3.3). */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The file's text, or undefined when it does not exist. Other errors are thrown. */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write `text` to `path` through a temporary file renamed into place, so a crash never leaves
 * an agent's config half written. The folder is created; an existing file keeps its mode. */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  let keep = mode;
  if (keep === undefined) {
    try {
      keep = statSync(path).mode & 0o777;
    } catch {
      keep = 0o644;
    }
  }
  const temp = `${path}.seshi-${process.pid}-${Date.now().toString(36)}.tmp`;
  writeFileSync(temp, text, { mode: keep });
  // The mode a umask took off is put back, so a 0600 config stays 0600.
  if (process.platform !== "win32") chmodSync(temp, keep);
  renameSync(temp, path);
}

/** A JSON config file as an object: `{}` when it does not exist. Text that is not a JSON object
 * is an error naming the file, so an installer never overwrites a file it could not read. */
export function readJsonConfig(path: string): Record<string, unknown> {
  const text = readTextFile(path);
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}); fix it or move it aside, then run again`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not hold a JSON object; fix it or move it aside, then run again`);
  }
  return parsed as Record<string, unknown>;
}

/** Write a JSON config file as people write them: two-space indents and a final newline. */
export function writeJsonConfig(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `words` as one command line that sh (Git Bash, which runs Claude Code's hooks and Bash tool
 * on Windows), PowerShell's call operator and cmd all split back into the same words (F8.4).
 *
 * A Windows path (`C:\…`, `\\server\…`) is written with forward slashes, which all three take
 * for a program or a file: sh would strip its backslashes unquoted, and quoting a program for
 * PowerShell needs `&` in front. Any other word with a space, a quote, a backslash or another
 * character a shell treats specially is double-quoted, the backslashes before a quote (or the
 * closing one) doubled, which sh and Windows' argument rules both read back as one. */
export function commandLine(words: readonly string[]): string {
  return words.map(commandWord).join(" ");
}

function commandWord(word: string): string {
  const w = /^(?:[A-Za-z]:\\|\\\\)/.test(word) ? word.replace(/\\/g, "/") : word;
  if (/^[\w@%+=:,./-]+$/.test(w)) return w;
  const body = w.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${body}"`;
}

/** Whether `command` is a seshi hook command for `agent`: its program is a `seshi` binary (any
 * folder, `.exe` or not) and its words are `hook <agent> …`, or it is `own` (the command line
 * an install writes, `commandLine(--command)`, a wrapper named anything) followed by those
 * words. How installers tell their own entries from everyone else's. */
export function isSeshiHook(command: unknown, agent: string, own?: string): boolean {
  if (typeof command !== "string") return false;
  if (own !== undefined && command.startsWith(`${own} hook ${agent} `)) return true;
  const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\\\/\\s"'])seshi(\\.exe)?["']?\\s+hook\\s+${escaped}(\\s|$)`).test(
    command,
  );
}

/** Whether `command` is `seshi statusline`. */
export function isSeshiStatusline(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /(^|[\\/\s"'])seshi(\.exe)?["']?\s+statusline(\s|$)/.test(command);
}
