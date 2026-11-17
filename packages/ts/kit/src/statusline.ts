import { existsSync, rmSync } from "node:fs";
import { commandLine, isSeshiStatusline, readTextFile, writeJsonConfig } from "./files";

/** Where an agent's status line setting lives (`settings.statusLine`), and where install keeps a
 * status line someone else set up, which seshi's runs first (`seshi statusline --chain <file>`);
 * uninstall puts it back. Claude Code and the Cursor CLI read the same shape. */
export interface StatusLineTarget {
  /** The agent's name, for the notes. */
  label: string;
  /** The file holding the status line seshi's replaced. */
  chain: string;
  /** Words after `statusline`, such as `--agent cursor`. */
  args: readonly string[];
}

export function savedStatusLine(file: string): Record<string, unknown> | undefined {
  try {
    const saved = (JSON.parse(readTextFile(file) ?? "") as { statusLine?: unknown }).statusLine;
    return typeof saved === "object" && saved !== null && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function chainedNote(target: StatusLineTarget): string {
  return `${target.label} already had a status line: seshi's now shows after it (yours is kept in ${target.chain}, and seshi capture uninstall puts it back)`;
}

/** Point `settings.statusLine` at seshi's, keeping one someone else set up to run first. Returns
 * the files it wrote besides the settings, and its notes. */
export function attachStatusLine(
  settings: Record<string, unknown>,
  command: readonly string[],
  target: StatusLineTarget,
): { changed: string[]; notes: string[] } {
  const status = settings.statusLine as { command?: unknown; padding?: unknown } | undefined;
  const ours = (chained: boolean) =>
    commandLine([
      ...command,
      "statusline",
      ...target.args,
      ...(chained ? ["--chain", target.chain] : []),
    ]);
  if (status === undefined) {
    settings.statusLine = { type: "command", command: ours(false), padding: 0 };
    return { changed: [], notes: [] };
  }
  if (isSeshiStatusline(status.command)) {
    settings.statusLine = { ...status, command: ours(savedStatusLine(target.chain) !== undefined) };
    return { changed: [], notes: [] };
  }
  writeJsonConfig(target.chain, { statusLine: status });
  settings.statusLine = {
    type: "command",
    command: ours(true),
    padding: typeof status.padding === "number" ? status.padding : 0,
  };
  return { changed: [target.chain], notes: [chainedNote(target)] };
}

/** Take seshi's status line out of `settings`, putting back one it chained. Returns whether the
 * settings changed, and the files it removed. */
export function detachStatusLine(
  settings: Record<string, unknown>,
  target: StatusLineTarget,
): { touched: boolean; removed: string[] } {
  const status = settings.statusLine as { command?: unknown } | undefined;
  if (!status || !isSeshiStatusline(status.command)) return { touched: false, removed: [] };
  const saved = savedStatusLine(target.chain);
  if (saved) settings.statusLine = saved;
  else delete settings.statusLine;
  if (!existsSync(target.chain)) return { touched: true, removed: [] };
  rmSync(target.chain, { force: true });
  return { touched: true, removed: [target.chain] };
}

/** What `status` says about the status line. */
export function statusLineNotes(
  settings: Record<string, unknown>,
  target: StatusLineTarget,
  installAgent: string,
): string[] {
  const status = settings.statusLine as { command?: unknown } | undefined;
  if (status && !isSeshiStatusline(status.command)) {
    return [
      `${target.label}'s status line is someone else's: run seshi capture install ${installAgent} to show Session Capture after it`,
    ];
  }
  return savedStatusLine(target.chain) ? [chainedNote(target)] : [];
}
