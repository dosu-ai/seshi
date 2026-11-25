import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface BuildOptions {
  root: string;
  target?: string;
  outfile?: string;
  /** The server build: `main-server.ts`, which carries the LanceDB search backend (F10.6). */
  server?: boolean;
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
    join(options.root, "apps/seshi/src", options.server ? "main-server.ts" : "main.ts"),
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
    // The server build ships for glibc (the image is Debian, the release's Linux targets are
    // glibc). LanceDB picks its native library by libc at run time, which the bundler cannot
    // decide, so it would carry the musl one too (172 MB more): leave it out.
    ...(options.server ? ["--external", "@lancedb/lancedb-*-musl"] : []),
    "--outfile",
    outfile,
  ];
  return { argv, outfile };
}

/** The LanceDB native package a server build for `target` (a Bun target; this machine's when
 * omitted) carries: `@lancedb/lancedb-linux-x64-gnu`, `@lancedb/lancedb-darwin-arm64`. */
export function lanceNativePackage(
  target: string | undefined,
  host: { platform: string; arch: string } = process,
): string {
  const match = target?.match(/^bun-(linux|darwin|windows)-(x64|arm64)/);
  const os = match ? match[1] : host.platform === "win32" ? "windows" : host.platform;
  const cpu = match ? match[2] : host.arch;
  if (os === "linux") return `@lancedb/lancedb-linux-${cpu}-gnu`;
  if (os === "darwin") return `@lancedb/lancedb-darwin-${cpu}`;
  throw new Error(`the server build is for Linux and macOS, not ${target ?? os}`);
}

/** A server build bundles the LanceDB native package that `bun install` put in node_modules;
 * one for another platform is not there unless the install asked for it, and the binary would
 * fail at its first search. Refuse to build instead. */
export function checkLanceNative(root: string, target: string | undefined): void {
  const name = lanceNativePackage(target);
  let lancedb: string;
  try {
    lancedb = dirname(
      Bun.resolveSync("@lancedb/lancedb/package.json", join(root, "packages/ts/search/lance")),
    );
    Bun.resolveSync(`${name}/package.json`, lancedb);
  } catch {
    const [, os, cpu] = name.match(/lancedb-(linux|darwin)-(x64|arm64)/) ?? [];
    throw new Error(
      `${name} is not installed, so a server build for ${target ?? "this machine"} would have no LanceDB: run bun install --frozen-lockfile --os=${os} --cpu=${cpu} first`,
    );
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      target: { type: "string" },
      outfile: { type: "string" },
      server: { type: "boolean" },
    },
    strict: true,
  });
  const root = resolve(import.meta.dir, "..");
  if (values.server) checkLanceNative(root, values.target);
  const { argv, outfile } = buildCommand({
    root,
    ...(values.target ? { target: values.target } : {}),
    ...(values.outfile ? { outfile: values.outfile } : {}),
    ...(values.server ? { server: true } : {}),
  });
  mkdirSync(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
  console.log(`build: ${outfile}`);
}
