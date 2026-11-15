/** Starting programs that outlive the command: the uploader a hook starts (F9.1), and the
 * program Codex's `notify` named before seshi (run after seshi's hook, so it keeps working).
 * They run detached, with no terminal and no input, and the command does not wait for them. */

import { spawn } from "node:child_process";
import { basename } from "node:path";

/** Whether this process is the compiled `seshi` binary rather than `bun …/main.ts`. */
export function isCompiled(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): boolean {
  const script = argv[1];
  return (
    script === undefined ||
    script.startsWith("/$bunfs/") ||
    /[\\/]~BUN[\\/]/.test(script) ||
    script === execPath
  );
}

/** The words that start this same seshi again: the binary, or bun and the entry script. */
export function selfCommand(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): string[] {
  return isCompiled(argv, execPath) ? [execPath] : [execPath, argv[1] as string];
}

/** The program hooks should run: the compiled binary's absolute path (so hooks work whatever
 * the agent's PATH is), or `seshi` from the PATH when running from source. */
export function hookCommand(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): string[] {
  return isCompiled(argv, execPath) && /^seshi(\.exe)?$/i.test(basename(execPath))
    ? [execPath]
    : ["seshi"];
}

/** Start `words` detached: no terminal, no input or output, not waited for. `cwd` is where it
 * runs; the current folder by default. */
export async function spawnDetached(
  words: readonly string[],
  env: Record<string, string | undefined>,
  cwd?: string,
): Promise<void> {
  const [program, ...args] = words;
  if (!program) return;
  const child = spawn(program, args, {
    detached: true,
    stdio: "ignore",
    env: env as NodeJS.ProcessEnv,
    windowsHide: true,
    ...(cwd ? { cwd } : {}),
  });
  await new Promise<void>((resolve) => {
    child.once("spawn", () => resolve());
    child.once("error", () => resolve());
  });
  child.unref();
}
