import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The seshi program to run: the `seshi.command` setting; else the program seshi's own hook in
 * `~/.cursor/hooks.json` runs (what `seshi capture install cursor` wrote, by its absolute path,
 * so it works when the app does not see the shell's PATH); else `seshi`. */
export function seshiProgram(setting: string | undefined, hooksJson?: string): string {
  if (setting?.trim()) return setting.trim();
  const fromHooks = hooksJson === undefined ? undefined : programFromHooks(hooksJson);
  return fromHooks ?? "seshi";
}

export function readCursorHooks(home: string = homedir()): string | undefined {
  try {
    return readFileSync(join(home, ".cursor", "hooks.json"), "utf8");
  } catch {
    return undefined;
  }
}

/** The program in seshi's hook command (`<program> hook cursor <event>`); a program with a
 * space in it is double-quoted there. */
export function programFromHooks(text: string): string | undefined {
  let config: { hooks?: Record<string, { command?: unknown }[]> };
  try {
    config = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const hooks of Object.values(config.hooks ?? {})) {
    for (const hook of Array.isArray(hooks) ? hooks : []) {
      if (typeof hook.command !== "string") continue;
      const at = hook.command.indexOf(" hook cursor ");
      if (at <= 0) continue;
      const program = hook.command.slice(0, at).trim();
      if (program.startsWith('"') && program.endsWith('"') && program.length > 1) {
        return program.slice(1, -1).replace(/\\"/g, '"');
      }
      // A command of several words (`npx seshi`) cannot be run as one program.
      if (/\s/.test(program)) return undefined;
      return program;
    }
  }
  return undefined;
}
