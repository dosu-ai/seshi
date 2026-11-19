import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface BuildOptions {
  root: string;
  target?: string;
  outfile?: string;
}

export function buildCommand(options: BuildOptions): { argv: string[]; outfile: string } {
  const windows = options.target?.includes("windows") ?? process.platform === "win32";
  const outfile = resolve(
    options.root,
    options.outfile ?? join("dist", windows ? "seshi.exe" : "seshi"),
  );
  const argv = [
    process.execPath,
    "build",
    join(options.root, "apps/seshi/src/main.ts"),
    "--compile",
    "--minify",
    // Precompiled bytecode roughly halves start-up, which `seshi hook` pays on every agent
    // turn. It needs an entry without top-level await (main.ts has none).
    "--bytecode",
    "--conditions",
    "bun",
    // `seshi hook` runs in whatever folder the agent works in. A compiled Bun binary would
    // otherwise read that folder's .env (settings the user never meant for seshi) and
    // bunfig.toml (whose `preload` runs code from the repository). Settings come from
    // SESHI_* env and the TOML files only.
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...(options.target ? ["--target", options.target] : []),
    "--outfile",
    outfile,
  ];
  return { argv, outfile };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { target: { type: "string" }, outfile: { type: "string" } },
    strict: true,
  });
  const root = resolve(import.meta.dir, "..");
  const { argv, outfile } = buildCommand({
    root,
    ...(values.target ? { target: values.target } : {}),
    ...(values.outfile ? { outfile: values.outfile } : {}),
  });
  mkdirSync(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
  console.log(`build: ${outfile}`);
}
