/** The world a process-mode scenario runs in: real processes on this machine, isolated the way
 * the verify-seshi skill isolates a run. A temporary folder holds a throwaway home (agent
 * folders, XDG folders, the capture state), a `file://` bucket and the server's config;
 * `seshi serve` runs as its own process on a free port, behind the fault proxy on another;
 * the machine is signed in through the proxy with the org key (`SESHI_KEYCHAIN=false`, so no
 * keychain), and hooks never start an uploader of their own (`SESHI_NO_UPLOADER=1`): the
 * scenario starts every `seshi daemon` itself, so it knows each one's pid.
 *
 * seshi runs from source (`bun run apps/seshi/src/main.ts`), or the compiled binary when
 * `SCENARIO_SESHI_BIN` names one (`SCENARIO_SESHI_BIN=dist/seshi`). The variable is read here
 * and never passed on: seshi refuses `SESHI_*` names it does not know, and every child gets an
 * environment built from scratch. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capturePaths } from "@seshi/capture";
import type { CaptureHost } from "@seshi/kit";
import { FsStore } from "@seshi/store";
import { type Child, type Exit, Procs } from "./procs";
import { FaultProxy } from "./proxy";
import type { Scenario } from "./schema";

/** The person whose machine it is, as the server records them. */
export const OWNER = "alice@acme.com";
export const AGENT = "claude-code";
const REPO = resolve(import.meta.dirname, "../../..");
/** How long a foreground command may take before the scenario fails. */
const COMMAND_TIMEOUT_MS = 60_000;

/** The seshi command line: the binary `SCENARIO_SESHI_BIN` names, or the source through bun. */
export function seshiCommand(): string[] {
  const bin = process.env.SCENARIO_SESHI_BIN;
  if (bin) {
    const path = resolve(REPO, bin);
    if (!existsSync(path)) throw new Error(`SCENARIO_SESHI_BIN=${bin}: no such file`);
    return [path];
  }
  return [process.execPath, "run", join(REPO, "apps/seshi/src/main.ts")];
}

/** A port nothing listens on now. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  parent?: string;
  turns: number;
  summaries: number;
}

export class World {
  readonly dir: string;
  readonly home: string;
  readonly bucketDir: string;
  readonly store: FsStore;
  readonly env: Record<string, string>;
  readonly procs = new Procs();
  readonly proxy: FaultProxy;
  readonly serverPort: number;
  readonly sessions = new Map<string, SessionInfo>();
  readonly marks: string[] = [];
  planted = false;
  /** Problems found outside a step (a kill rule with no uploader to kill): the next check
   * fails with them. */
  readonly errors: string[] = [];
  server: Child | undefined;
  private orgKey = "";
  private readonly command = seshiCommand();
  private serverStarts = 0;

  constructor(readonly scenario: Scenario) {
    this.dir = mkdtempSync(join(tmpdir(), "seshi-proc-"));
    this.home = join(this.dir, "home");
    this.bucketDir = join(this.dir, "bucket");
    for (const sub of ["home/.claude/projects", "home/.config", "home/code/app", "logs"]) {
      mkdirSync(join(this.dir, sub), { recursive: true });
    }
    writeFileSync(join(this.home, ".gitconfig"), "");
    this.store = new FsStore(`file://${this.bucketDir}`);
    this.serverPort = freePort();
    this.env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      XDG_STATE_HOME: join(this.home, ".local", "state"),
      XDG_CACHE_HOME: join(this.home, ".cache"),
      CLAUDE_CONFIG_DIR: join(this.home, ".claude"),
      CODEX_HOME: join(this.home, ".codex"),
      GIT_CONFIG_GLOBAL: join(this.home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      SESHI_KEYCHAIN: "false",
      SESHI_NO_UPLOADER: "1",
      NO_COLOR: "1",
    };
    this.proxy = new FaultProxy(this.serverPort, {
      killClient: () => this.killUploader(),
      killServer: () => this.killServer(),
    });
  }

  get host(): CaptureHost {
    return { env: this.env, home: this.home, platform: process.platform };
  }

  get paths() {
    return capturePaths(this.host);
  }

  get configPath(): string {
    return join(this.dir, "seshi.toml");
  }

  /** Start a seshi process; it runs until it exits or the scenario ends. */
  spawn(
    args: string[],
    label: string,
    options: { stdin?: string; env?: Record<string, string> } = {},
  ) {
    return this.procs.spawn([...this.command, ...args], {
      label,
      cwd: this.home,
      env: { ...this.env, ...options.env },
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    });
  }

  /** Run a seshi command and wait for it (killed, and a failure, past the timeout). */
  async run(
    args: string[],
    options: { stdin?: string; env?: Record<string, string>; label?: string } = {},
  ): Promise<Exit & { child: Child }> {
    const child = this.spawn(args, options.label ?? args.slice(0, 2).join(" "), options);
    return this.wait(child);
  }

  async wait(child: Child, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Exit & { child: Child }> {
    const exit = await Promise.race([child.done, Bun.sleep(timeoutMs).then(() => undefined)]);
    if (!exit) {
      await this.procs.kill(child);
      throw new Error(`${child.label} (pid ${child.pid}) still running after ${timeoutMs} ms`);
    }
    return { ...exit, child };
  }

  async start(): Promise<void> {
    const { setup } = this.scenario;
    writeFileSync(
      this.configPath,
      `${setup.server ?? ""}\n[server]\nlisten = "127.0.0.1:${this.serverPort}"\n\n[store]\nurl = "file://${this.bucketDir}"\n`,
      { mode: 0o600 },
    );
    const init = await this.run(["admin", "init", "--config", this.configPath, "--json"]);
    if (init.code !== 0) throw new Error(`seshi admin init exited ${init.code}: ${init.err}`);
    this.orgKey = (JSON.parse(init.out) as { org_key: { token: string } }).org_key.token;
    this.proxy.start();
    await this.startServer();
    const login = await this.run(
      ["login", "--server", this.proxy.url, "--key", "-", "--user", OWNER],
      { stdin: this.orgKey },
    );
    if (login.code !== 0) throw new Error(`seshi login exited ${login.code}: ${login.err}`);
    for (const [folder, repo] of Object.entries(setup.repos)) {
      const root = join(this.home, folder);
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      if (repo.config !== undefined) {
        mkdirSync(join(root, ".seshi"), { recursive: true });
        writeFileSync(join(root, ".seshi", "config.toml"), repo.config);
      }
    }
  }

  get serverUp(): boolean {
    return this.server !== undefined && !this.server.exited;
  }

  /** `seshi serve` on the scenario's port; resolves once `/healthz` answers. */
  async startServer(): Promise<void> {
    this.serverStarts++;
    const log = join(this.dir, "logs", `serve-${this.serverStarts}.log`);
    const child = this.procs.spawn([...this.command, "serve", "--config", this.configPath], {
      label: "serve",
      cwd: this.dir,
      env: this.env,
      logFile: log,
    });
    this.server = child;
    const url = `http://127.0.0.1:${this.serverPort}/healthz`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exited) {
        const exit = await child.done;
        throw new Error(`seshi serve exited ${exit.code ?? exit.signal}: ${exit.err.slice(-2000)}`);
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error(`seshi serve not ready after 30 s (${log})`);
  }

  async killServer(): Promise<void> {
    if (this.server) await this.procs.kill(this.server);
  }

  async restartServer(): Promise<void> {
    if (this.server && !this.server.exited) await this.procs.kill(this.server, "SIGTERM");
    await this.startServer();
  }

  /** The server's log so far (the current process's, once it exited). */
  serverLog(): string {
    try {
      return readFileSync(join(this.dir, "logs", `serve-${this.serverStarts}.log`), "utf8");
    } catch {
      return "";
    }
  }

  /** Uploaders this scenario started that are running. */
  uploaders(): Child[] {
    return this.procs.running().filter((c) => c.label.startsWith("daemon"));
  }

  /** What a kill-client rule does: SIGKILL the one uploader running. */
  private async killUploader(): Promise<void> {
    const live = this.uploaders();
    if (live.length !== 1) {
      this.errors.push(`a kill-client rule fired with ${live.length} uploaders running, not one`);
    }
    await Promise.all(live.map((c) => this.procs.kill(c)));
  }

  /** Stop everything this scenario started, by pid, and remove its folder (kept with `keep`). */
  async stop(keep = false): Promise<void> {
    try {
      this.proxy.stop();
    } finally {
      await this.procs.killAll();
      if (!keep) rmSync(this.dir, { recursive: true, force: true });
    }
  }
}
