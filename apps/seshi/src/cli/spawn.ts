import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

/** How a `sql` worker is started: `seshi sql-worker` from a compiled binary, `main.ts
 * sql-worker` under Bun otherwise (`bun run`, tests). A process run from source that carries
 * DuckDB (`main-server-sql.ts`) passes its engine's worker `script`, which gives the worker
 * DuckDB as a compiled `-sql` binary's `seshi sql-worker` has it. */
export function sqlWorkerCommand(
  script?: string,
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): string[] {
  if (isCompiled(argv, execPath)) return [execPath, "sql-worker"];
  return script !== undefined
    ? [execPath, script]
    : [execPath, fileURLToPath(new URL("../main.ts", import.meta.url)), "sql-worker"];
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
