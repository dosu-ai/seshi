/** Runs a compiled `seshi` binary through what a person does first, on the machine it is
 * built for (F8.4, and 13's open item: `Bun.secrets` inside the compiled binary):
 *
 * 1. `--version`;
 * 2. `admin init` and `serve` on a temporary folder store, on 127.0.0.1;
 * 3. `login --key -` with the org key, which stores it in the OS keychain (or the 0600 file);
 * 4. `whoami`, which reads it back; `logout`, which removes it; `whoami` again, which must
 *    now say "not signed in".
 *
 *   bun run scripts/release/smoke.ts <binary> [--version <X.Y.Z>] [--keychain required|allowed|off]
 *
 * `--keychain required` fails unless the key went to the keychain (macOS, Windows);
 * `allowed` (the default) accepts the file fallback (Linux without a secret service);
 * `off` sets `keychain = false` (SESHI_KEYCHAIN), so nothing touches the real keychain: what
 * the repository's own tests use. With the keychain in play the real home folder is kept,
 * since that is where macOS looks for the login keychain; the CLI config goes to a temporary
 * folder either way. Nothing leaves 127.0.0.1. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type KeychainMode = "required" | "allowed" | "off";

export interface SmokeOptions {
  binary: string;
  version?: string;
  keychain?: KeychainMode;
  log?: (line: string) => void;
  /** Per command, in ms. */
  timeout?: number;
}

export interface SmokeResult {
  version: string;
  storedIn: string;
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** The environment the binary runs with: only what it needs, so nothing of the caller's
 * seshi setup (SESHI_* variables, its CLI config) leaks in. */
export function smokeEnv(
  base: Record<string, string | undefined>,
  dir: string,
  keychain: KeychainMode,
): Record<string, string> {
  const keep = [
    "PATH",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERNAME",
    "USER",
    // The Linux secret service is reached over D-Bus.
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
  ];
  const env: Record<string, string> = {};
  for (const name of keep) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  const home = keychain === "off" ? join(dir, "home") : (base.HOME ?? base.USERPROFILE ?? dir);
  env.HOME = home;
  if (base.USERPROFILE !== undefined || process.platform === "win32") {
    env.USERPROFILE = keychain === "off" ? home : (base.USERPROFILE ?? home);
  }
  // The CLI config folder: XDG_CONFIG_HOME on macOS and Linux, %APPDATA% on Windows.
  env.XDG_CONFIG_HOME = join(dir, "config");
  env.APPDATA = join(dir, "appdata");
  env.LOCALAPPDATA = join(dir, "localappdata");
  env.NO_COLOR = "1";
  if (keychain === "off") env.SESHI_KEYCHAIN = "false";
  return env;
}

export async function smoke(options: SmokeOptions): Promise<SmokeResult> {
  const keychain = options.keychain ?? "allowed";
  const log = options.log ?? (() => {});
  const timeout = options.timeout ?? 60_000;
  const dir = mkdtempSync(join(tmpdir(), "seshi-smoke-"));
  const env = smokeEnv(process.env, dir, keychain);
  mkdirSync(env.HOME as string, { recursive: true });
  let server: ReturnType<typeof Bun.spawn> | undefined;

  const run = async (args: string[], stdin?: string): Promise<Ran> => {
    const proc = Bun.spawn([options.binary, ...args], {
      cwd: dir,
      env,
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeout);
    try {
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, out, err };
    } finally {
      clearTimeout(timer);
    }
  };
  const expectOk = (step: string, ran: Ran): Ran => {
    if (ran.code !== 0) {
      throw new Error(`${step} exited ${ran.code}:\n${ran.out}${ran.err}`);
    }
    log(`ok: ${step}`);
    return ran;
  };

  try {
    const shown = expectOk("--version", await run(["--version"])).out.trim();
    const version = shown.replace(/^seshi /, "");
    if (!/^seshi \d+\.\d+\.\d+/.test(shown)) throw new Error(`--version printed ${shown}`);
    if (options.version !== undefined && version !== options.version) {
      throw new Error(`--version printed ${version}, expected ${options.version}`);
    }

    const port = await freePort();
    const config = join(dir, "seshi.toml");
    writeFileSync(
      config,
      [
        "[server]",
        `listen = "127.0.0.1:${port}"`,
        "[store]",
        `url = "${pathToFileURL(join(dir, "store")).href}"`,
        "",
      ].join("\n"),
    );
    const init = expectOk("admin init", await run(["admin", "init", "--config", config]));
    const lines = init.out.split(/\r?\n/);
    const keyAt = lines.findIndex((line) => line.startsWith("org key"));
    const orgKey = lines[keyAt + 1]?.trim();
    if (keyAt === -1 || !orgKey) throw new Error(`admin init printed no org key:\n${init.out}`);

    // stdout is not read, so it must not be a pipe the server could fill and block on.
    server = Bun.spawn([options.binary, "serve", "--config", config], {
      cwd: dir,
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (server.exitCode !== null || Date.now() > deadline) {
        // Its stderr ends only when it exits: stop a server that is still running first.
        server.kill();
        const code = await server.exited;
        const err = await new Response(server.stderr as ReadableStream).text();
        throw new Error(`seshi serve did not come up (exit ${code}):\n${err}`);
      }
      await Bun.sleep(100);
    }
    log("ok: serve");

    const login = expectOk(
      "login --key",
      await run(
        ["login", "--server", url, "--key", "-", "--user", "smoke@example.com", "--json"],
        `${orgKey}\n`,
      ),
    );
    const storedIn = JSON.parse(login.out).stored_in as string;
    log(`credentials stored in: ${storedIn}`);
    if (keychain === "required" && storedIn !== "keychain") {
      throw new Error(`the org key went to ${storedIn}, not the OS keychain:\n${login.err}`);
    }
    if (keychain === "off" && storedIn !== "file") {
      throw new Error(`keychain = false, yet the org key went to ${storedIn}`);
    }

    const who = JSON.parse(expectOk("whoami", await run(["whoami", "--json"])).out);
    if (who.login?.user !== "smoke@example.com" || who.login?.stored_in !== storedIn) {
      throw new Error(`whoami says ${JSON.stringify(who)}`);
    }
    expectOk("logout", await run(["logout", "--json"]));
    const after = await run(["whoami", "--json"]);
    if (after.code === 0) throw new Error(`whoami after logout still answers:\n${after.out}`);
    log("ok: signed out");
    return { version, storedIn };
  } finally {
    if (server) {
      server.kill();
      await server.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { version: { type: "string" }, keychain: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const keychain = (values.keychain ?? "allowed") as KeychainMode;
  if (positionals.length !== 1 || !["required", "allowed", "off"].includes(keychain)) {
    console.error(
      "usage: bun run scripts/release/smoke.ts <binary> [--version X.Y.Z] [--keychain required|allowed|off]",
    );
    process.exit(2);
  }
  try {
    const result = await smoke({
      binary: resolve(positionals[0] as string),
      keychain,
      ...(values.version ? { version: values.version } : {}),
      log: (line) => console.log(`smoke: ${line}`),
    });
    console.log(`smoke: seshi ${result.version} passed (credentials in ${result.storedIn})`);
  } catch (err) {
    console.error(`smoke: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
