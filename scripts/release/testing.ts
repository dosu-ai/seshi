import { chmodSync, cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Variant } from "./build";
import { ROOT, repositoryVersion } from "./build";
import type { Target } from "./targets";

export function standInCompile(version = repositoryVersion(), body?: string) {
  const compiled: string[] = [];
  const compile = async (target: Target, outfile: string, variant: Variant = "plain") => {
    compiled.push(
      variant === "plain"
        ? target.id
        : variant === "server"
          ? `${target.id}-server`
          : `${target.id}-server-sql`,
    );
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(outfile, `#!/bin/sh\n${body ?? `echo "seshi ${version}"`}\n# ${target.id}\n`);
    chmodSync(outfile, 0o755);
  };
  return { compile, compiled };
}

/** DuckDB's files for a `-sql` build, as stand-ins: no library or extension is read or
 * fetched. */
export function standInDuckdb() {
  const asked: string[] = [];
  const duckdb = async (target: Target) => {
    asked.push(target.id);
    const platform = target.cpu === "x64" ? "linux_amd64" : "linux_arm64";
    return [
      { name: "duckdb/lib/libduckdb.so", data: new TextEncoder().encode(`lib ${target.id}`) },
      {
        name: `duckdb/v9.9.9/${platform}/lance.duckdb_extension`,
        data: new TextEncoder().encode(`lance ${platform}`),
      },
    ];
  };
  return { duckdb, asked };
}

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
