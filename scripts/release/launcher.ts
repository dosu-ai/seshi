/** The `seshi` npm package's `bin` (F8.4): `npm i -g seshi` and `npx seshi` install it with the
 * one optional dependency npm picks for this machine (`@seshi/cli-darwin-arm64`…, by their `os`,
 * `cpu` and `libc` fields), and this launcher runs that package's binary with the same
 * arguments, standard streams and exit status. The binary itself needs neither Node nor Bun.
 *
 * Built into `bin/seshi.js` (CommonJS, for every Node npm supports) by scripts/release/npm.ts.
 * It is a thin wrapper: hook commands written by `seshi capture install` name the binary's own
 * path (`process.execPath` inside it), so agents never pay for Node on every turn. */

import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { TARGETS, type Target } from "./targets";

export type Resolve = (request: string) => string;

export type Libc = "glibc" | "musl";

/** The C library of this Linux process: glibc when Node reports a glibc version, else musl. */
export function detectLibc(
  report: { header?: { glibcVersionRuntime?: string } } | undefined,
): Libc {
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

export type Choice = { target: Target } | { error: string };

/** The release target for this platform, or why there is none. */
export function chooseTarget(platform: string, arch: string, libc?: Libc): Choice {
  const target = TARGETS.find((t) => t.nodePlatform === platform && t.cpu === arch);
  const supported = TARGETS.map((t) => t.id).join(", ");
  if (!target) {
    return { error: `seshi has no binary for ${platform}-${arch} (there are: ${supported})` };
  }
  if (target.libc && libc && libc !== target.libc) {
    return {
      error: `seshi's Linux binaries need glibc, and this system uses ${libc} (Alpine, for example); run seshi in a glibc-based image, or use the Docker image`,
    };
  }
  return { target };
}

/** The binary inside `target`'s npm package, resolved from the launcher's own location. */
export function binaryPath(target: Target, resolve: Resolve): { path: string } | { error: string } {
  try {
    const manifest = resolve(`${target.npm}/package.json`);
    return { path: join(dirname(manifest), "bin", target.binary) };
  } catch {
    return {
      error: `the package ${target.npm}, which holds seshi's binary for this machine, is not installed. npm skips it when optional dependencies are omitted (--omit=optional, --no-optional) or when the lock file was made on another platform. Reinstall seshi with optional dependencies, or install the binary with the install script (docs/install.md).`,
    };
  }
}

export interface LaunchEnv {
  platform: string;
  arch: string;
  libc?: Libc;
  resolve: Resolve;
}

/** Where the binary for this machine is, or a message saying why there is none. */
export function locate(env: LaunchEnv): { path: string } | { error: string } {
  const choice = chooseTarget(env.platform, env.arch, env.libc);
  if ("error" in choice) return choice;
  return binaryPath(choice.target, env.resolve);
}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGBREAK"] as const;

/** Runs the binary and leaves with its status. A signal meant for the whole terminal (Ctrl-C)
 * reaches the binary directly; one sent to this process alone is passed on. When the binary
 * is ended by a signal, so is this process, so a caller sees the same outcome. */
export function launch(path: string, args: readonly string[]): void {
  const child = spawn(path, args, { stdio: "inherit", windowsHide: false });
  const handlers = new Map<string, () => void>();
  for (const signal of FORWARDED) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    try {
      process.on(signal, handler);
      handlers.set(signal, handler);
    } catch {
      // Not a signal on this platform (SIGBREAK off Windows).
    }
  }
  child.on("error", (err) => {
    console.error(`seshi: could not run ${path}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal) {
      process.kill(process.pid, signal);
      // Signals that do not end Node by default still must not report success.
      setTimeout(() => process.exit(1), 100).unref();
      return;
    }
    process.exit(code ?? 1);
  });
}

/** Makes sure the binary can be run: a package manager that dropped the executable bit (some
 * do when unpacking) is put right when the files are ours to change. */
export function ensureExecutable(path: string, platform: string = process.platform): void {
  if (platform === "win32") return;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    try {
      chmodSync(path, 0o755);
    } catch {
      // Not ours to change (a root-owned global install); spawn reports the failure.
    }
  }
}

/** The launcher's entry point. */
export function main(): void {
  // The report is read only for its glibc version; its network section (interfaces, and DNS
  // lookups on some Node versions) would only slow every start.
  // (Node 20.13+; bun-types does not declare it yet, and older Node ignores it.)
  if (process.platform === "linux" && process.report) {
    (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
  }
  const located = locate({
    platform: process.platform,
    arch: process.arch,
    ...(process.platform === "linux"
      ? { libc: detectLibc(process.report?.getReport() as { header?: object } | undefined) }
      : {}),
    // CommonJS `require` of bin/seshi.js itself: resolves from the installed package. (A
    // bundler inlines `__filename` with the build path, so createRequire cannot be used.)
    resolve: (request) => require.resolve(request),
  });
  if ("error" in located) {
    console.error(`seshi: ${located.error}`);
    process.exit(1);
  }
  ensureExecutable(located.path);
  launch(located.path, process.argv.slice(2));
}
