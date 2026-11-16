import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  timeout?: number;
  readyTimeout?: number;
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
  env.XDG_CONFIG_HOME = join(dir, "config");
  env.APPDATA = join(dir, "appdata");
  env.XDG_STATE_HOME = join(dir, "state");
  env.LOCALAPPDATA = join(dir, "localappdata");
  env.NO_COLOR = "1";
  if (keychain === "off") env.SESHI_KEYCHAIN = "false";
  return env;
}

const SMOKE_RULE = "smoke-key";
const SMOKE_SECRET = "SMOKE-314159";
const SMOKE_SESSION = "5e551000-0000-4000-8000-00000000c0de";

export const SMOKE_PACK = [
  'id = "smoke"',
  "[[rules]]",
  `id = "${SMOKE_RULE}"`,
  "pattern = 'SMOKE-[0-9]{6}'",
  `tests.match = ["deploy with ${SMOKE_SECRET}"]`,
  'tests.no_match = ["SMOKE-12"]',
  "",
].join("\n");

export function smokeTranscript(cwd: string): string {
  const records = [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd,
      sessionId: SMOKE_SESSION,
      message: { role: "user", content: `Deploy with ${SMOKE_SECRET} please.` },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-09-01T00:00:05.000Z",
      sessionId: SMOKE_SESSION,
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Deploying now. ${"The steps, in order. ".repeat(120)}` }],
      },
    },
  ];
  return records.map((r) => `${JSON.stringify(r)}\n`).join("");
}

export function commandsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, v]) =>
    key === "command" && typeof v === "string" ? [v] : commandsIn(v),
  );
}

export function startsWithProgram(command: string, binary: string): boolean {
  return command.startsWith(`${binary} `) || command.startsWith(`"${binary}" `);
}

export async function smokeExplore(
  binary: string,
  cwd: string,
  env: Record<string, string>,
  timeout: number,
): Promise<void> {
  const proc = Bun.spawn([binary, "explore", "--no-open"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const reader = proc.stdout.getReader();
    let printed = "";
    while (!printed.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      printed += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const url = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(printed)?.[1];
    if (!url) throw new Error(`explore printed no address:\n${printed}`);
    const { origin, searchParams } = new URL(url);
    const page = await fetch(url);
    const html = await page.text();
    const script = /src="(\/chunk-[^"]+\.js\?token=[^"]+)"/.exec(html)?.[1];
    if (page.status !== 200 || !script) {
      throw new Error(`explore's page (${page.status}) links no script:\n${html}`);
    }
    if ((await fetch(`${origin}${script}`)).status !== 200) {
      throw new Error("explore did not serve the page's script");
    }
    if ((await fetch(`${origin}${script.split("?")[0]}`)).status !== 401) {
      throw new Error("explore served the page's script without the token");
    }
    const api = await fetch(`${origin}/api/sessions`, {
      headers: { "x-seshi-token": searchParams.get("token") as string },
    });
    const body = (await api.json()) as { sessions?: unknown };
    if (api.status !== 200 || !Array.isArray(body.sessions)) {
      throw new Error(`explore's API answered ${api.status}`);
    }
    proc.kill("SIGINT");
    const code = await proc.exited;
    if (code !== 0) throw new Error(`explore exited ${code} on SIGINT`);
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill();
  }
}

export async function smoke(options: SmokeOptions): Promise<SmokeResult> {
  const keychain = options.keychain ?? "allowed";
  const log = options.log ?? (() => {});
  const timeout = options.timeout ?? 60_000;
  const dir = mkdtempSync(join(tmpdir(), "seshi-smoke-"));
  const env = smokeEnv(process.env, dir, keychain);
  mkdirSync(env.HOME as string, { recursive: true });
  let server: ReturnType<typeof Bun.spawn> | undefined;

  const run = async (
    args: string[],
    stdin?: string,
    runEnv: Record<string, string> = env,
  ): Promise<Ran> => {
    const proc = Bun.spawn([options.binary, ...args], {
      cwd: dir,
      env: runEnv,
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
        "[redaction]",
        // A TOML literal string: a Windows path's backslashes stay as they are.
        `packs = ['${join(dir, "smoke.toml")}']`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "smoke.toml"), SMOKE_PACK);
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
    const deadline = Date.now() + (options.readyTimeout ?? timeout);
    for (;;) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) break;
      } catch {}
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

    const project = join(dir, "code");
    mkdirSync(project, { recursive: true });
    const transcript = join(dir, "transcripts", `${SMOKE_SESSION}.jsonl`);
    mkdirSync(join(dir, "transcripts"), { recursive: true });
    writeFileSync(transcript, smokeTranscript(project));
    const uploaded = JSON.parse(
      expectOk("upload", await run(["upload", transcript, "--json"])).out,
    ) as { sessions: { result: string }[] };
    if (uploaded.sessions[0]?.result !== "uploaded") {
      throw new Error(`upload did not upload: ${JSON.stringify(uploaded)}`);
    }
    const exported = expectOk(
      "sessions export",
      await run(["sessions", "export", `claude-code/${SMOKE_SESSION}`]),
    ).out;
    if (exported.includes(SMOKE_SECRET) || !exported.includes(`[redacted:${SMOKE_RULE}]`)) {
      throw new Error(`the stored session was not redacted with the pack's rule:\n${exported}`);
    }
    log("ok: uploaded and redacted (RE2)");

    await smokeExplore(options.binary, dir, env, timeout);
    log("ok: explore serves its page");

    const agentHome = join(dir, "agent-home");
    mkdirSync(agentHome, { recursive: true });
    const installEnv = {
      ...env,
      HOME: agentHome,
      USERPROFILE: agentHome,
      XDG_CONFIG_HOME: join(agentHome, "config"),
      APPDATA: join(agentHome, "appdata"),
      SESHI_KEYCHAIN: "false",
    };
    expectOk(
      "capture install",
      await run(["capture", "install", "claude-code", "--json"], undefined, installEnv),
    );
    const settings = JSON.parse(readFileSync(join(agentHome, ".claude", "settings.json"), "utf8"));
    const commands = commandsIn(settings);
    const programs = [...new Set([options.binary, realpathSync(options.binary)])];
    const stray = commands.filter((c) => !programs.some((p) => startsWithProgram(c, p)));
    if (commands.length === 0 || stray.length > 0) {
      throw new Error(
        `capture install wrote commands that do not name ${options.binary}:\n${(stray.length > 0 ? stray : ["(none written)"]).join("\n")}`,
      );
    }
    log(`ok: capture install (${commands.length} commands name the binary)`);

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
