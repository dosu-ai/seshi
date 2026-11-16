import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NOT_SETTINGS_ENV } from "@seshi/config/paths";
import { writeFileAtomic } from "@seshi/kit";

export const LAUNCHD_LABEL = "dev.seshi.uploader";
export const SYSTEMD_UNIT = "seshi-uploader.service";
export const WINDOWS_TASK = "seshi-uploader";

export type Exec = (words: string[]) => Promise<{ code: number; output: string }>;

export interface ServiceContext {
  home: string;
  platform: NodeJS.Platform;
  /** The words that start seshi (an absolute path: service managers have a bare PATH). */
  command: readonly string[];
  logFile: string;
  exec: Exec;
  env?: Record<string, string | undefined>;
}

export interface ServiceReport {
  entry: string;
  changed: boolean;
  problems: string[];
  notes?: string[];
}

export const CARRIED_ENV = [
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;
const XDG_ONLY = new Set(["XDG_STATE_HOME", "XDG_CONFIG_HOME"]);

export function serviceEnvironment(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): { carried: Record<string, string>; notes: string[] } {
  const carried: Record<string, string> = {};
  const notes: string[] = [];
  for (const name of CARRIED_ENV) {
    const value = env[name];
    if (!value) continue;
    // A Task Scheduler task carries no environment; XDG does not apply on Windows anyway.
    if (platform !== "win32") carried[name] = value;
    else if (!XDG_ONLY.has(name)) {
      notes.push(
        `${name} is set here, but the service does not see it: its sweep looks in the agent's default folder`,
      );
    }
  }
  const settings = Object.keys(env)
    .filter((n) => n.startsWith("SESHI_") && env[n] && !NOT_SETTINGS_ENV.includes(n))
    .sort();
  for (const n of settings) {
    notes.push(
      `${n} is set here, but the service does not see it: put the setting in the CLI config, or the service uploads without it`,
    );
  }
  return { carried, notes };
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(
  command: readonly string[],
  logFile: string,
  env: Record<string, string> = {},
): string {
  const args = [...command, "daemon", "--keep-alive"]
    .map((w) => `    <string>${xml(w)}</string>`)
    .join("\n");
  const names = Object.keys(env);
  const environment =
    names.length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>\n  <dict>\n${names
          .map((n) => `    <key>${xml(n)}</key>\n    <string>${xml(env[n] as string)}</string>`)
          .join("\n")}\n  </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${environment}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

const systemdWord = (w: string) =>
  /^[\w@%+=:,./-]+$/.test(w) ? w : `"${w.replace(/(["\\])/g, "\\$1")}"`;

/** A systemd `Environment=` assignment: quoted, with `%` doubled (systemd's specifiers). */
const systemdEnv = (name: string, value: string) =>
  `Environment="${`${name}=${value}`.replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"\n`;

export function systemdUnit(command: readonly string[], env: Record<string, string> = {}): string {
  return `[Unit]
Description=seshi session capture uploader

[Service]
${Object.entries(env)
  .map(([n, v]) => systemdEnv(n, v))
  .join("")}ExecStart=${[...command, "daemon", "--keep-alive"].map(systemdWord).join(" ")}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function windowsTaskCommand(command: readonly string[]): string {
  return [...command, "daemon", "--keep-alive"].map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(" ");
}

function entryOf(context: ServiceContext): string {
  switch (context.platform) {
    case "darwin":
      return join(context.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    case "win32":
      return WINDOWS_TASK;
    default:
      return join(context.home, ".config", "systemd", "user", SYSTEMD_UNIT);
  }
}

async function runAll(context: ServiceContext, commands: string[][]): Promise<string[]> {
  const problems: string[] = [];
  for (const words of commands) {
    try {
      const { code, output } = await context.exec(words);
      if (code !== 0) problems.push(`${words.join(" ")} exited ${code}: ${output.trim()}`);
    } catch (err) {
      problems.push(`${words.join(" ")}: ${(err as Error).message}`);
    }
  }
  return problems;
}

export async function installService(context: ServiceContext): Promise<ServiceReport> {
  const report = await install(context);
  const { notes } = serviceEnvironment(context.env ?? {}, context.platform);
  return notes.length > 0 ? { ...report, notes } : report;
}

async function install(context: ServiceContext): Promise<ServiceReport> {
  const entry = entryOf(context);
  const { carried } = serviceEnvironment(context.env ?? {}, context.platform);
  switch (context.platform) {
    case "darwin": {
      writeFileAtomic(entry, launchdPlist(context.command, context.logFile, carried), 0o644);
      // Unload first, so a reinstall picks up a changed command.
      await runAll(context, [["launchctl", "unload", entry]]);
      return {
        entry,
        changed: true,
        problems: await runAll(context, [["launchctl", "load", "-w", entry]]),
      };
    }
    case "win32": {
      const problems = await runAll(context, [
        [
          "schtasks",
          "/Create",
          "/F",
          "/SC",
          "ONLOGON",
          "/TN",
          WINDOWS_TASK,
          "/TR",
          windowsTaskCommand(context.command),
        ],
        ["schtasks", "/Run", "/TN", WINDOWS_TASK],
      ]);
      return { entry, changed: true, problems };
    }
    default: {
      writeFileAtomic(entry, systemdUnit(context.command, carried), 0o644);
      const problems = await runAll(context, [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
      ]);
      return { entry, changed: true, problems };
    }
  }
}

export async function uninstallService(context: ServiceContext): Promise<ServiceReport> {
  const entry = entryOf(context);
  switch (context.platform) {
    case "darwin": {
      if (!existsSync(entry)) return { entry, changed: false, problems: [] };
      const problems = await runAll(context, [["launchctl", "unload", "-w", entry]]);
      rmSync(entry, { force: true });
      return { entry, changed: true, problems };
    }
    case "win32": {
      const problems = await runAll(context, [["schtasks", "/Delete", "/F", "/TN", WINDOWS_TASK]]);
      return { entry, changed: problems.length === 0, problems };
    }
    default: {
      if (!existsSync(entry)) return { entry, changed: false, problems: [] };
      const problems = await runAll(context, [
        ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT],
      ]);
      rmSync(entry, { force: true });
      problems.push(...(await runAll(context, [["systemctl", "--user", "daemon-reload"]])));
      return { entry, changed: true, problems };
    }
  }
}

export async function serviceInstalled(context: ServiceContext): Promise<boolean> {
  if (context.platform === "win32") {
    return (await runAll(context, [["schtasks", "/Query", "/TN", WINDOWS_TASK]])).length === 0;
  }
  return existsSync(entryOf(context));
}

export const exec: Exec = async (words) => {
  const proc = Bun.spawn(words, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, output: `${out}${err}` };
};
