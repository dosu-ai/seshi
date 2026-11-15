/** Helpers the release tests share: a stand-in for Bun's compiler, and a temporary
 * node_modules laid out the way npm installs the release's packages. */

import { chmodSync, cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, repositoryVersion } from "./build";
import type { Target } from "./targets";

/** Writes a shell script where a binary would go. It prints the repository's version, so the
 * host target passes the build's `--version` check, and `# <id>` so tests can tell them
 * apart. `body` replaces what it does when given. */
export function standInCompile(version = repositoryVersion(), body?: string) {
  const compiled: string[] = [];
  const compile = async (target: Target, outfile: string) => {
    compiled.push(target.id);
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(outfile, `#!/bin/sh\n${body ?? `echo "seshi ${version}"`}\n# ${target.id}\n`);
    chmodSync(outfile, 0o755);
  };
  return { compile, compiled };
}

/** Copies built npm package folders into `<dir>/node_modules/<name>`, as npm would install
 * them, and links `@letta-ai/trajectory` (the model's one dependency) from the workspace. */
export function installPackages(dir: string, packages: { name: string; dir: string }[]): string {
  const modules = join(dir, "node_modules");
  for (const p of packages) {
    const to = join(modules, p.name);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(p.dir, to, { recursive: true });
  }
  const trajectory = join(modules, "@letta-ai/trajectory");
  mkdirSync(dirname(trajectory), { recursive: true });
  symlinkSync(
    realpathSync(join(ROOT, "packages/ts/model/node_modules/@letta-ai/trajectory")),
    trajectory,
    "dir",
  );
  return modules;
}

export async function exec(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
) {
  const proc = Bun.spawn(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err, signal: proc.signalCode };
}
