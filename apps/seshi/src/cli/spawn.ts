import { spawn } from "node:child_process";

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

export function selfCommand(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): string[] {
  return isCompiled(argv, execPath) ? [execPath] : [execPath, argv[1] as string];
}

export function hookCommand(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): string[] {
  return isCompiled(argv, execPath) && /(^|[\\/])seshi(\.exe)?$/i.test(execPath)
    ? [execPath]
    : ["seshi"];
}

/** Whether `program` lives in npx's cache (`…/_npx/<hash>/node_modules/…`): `npx seshi` runs
 * the binary from there, and npx may delete it at any time, taking every hook naming it along. */
export function inNpxCache(program: string): boolean {
  return /[\\/]_npx[\\/]/.test(program);
}

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
