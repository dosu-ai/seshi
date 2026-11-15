/** `seshi capture install --service` (F9.1): an entry in the OS's own service manager that keeps
 * the uploader running between agent sessions, for people who want that. Without it the
 * uploader starts on demand and stops when idle, which needs nothing installed.
 *
 * - macOS: a launchd agent, `~/Library/LaunchAgents/dev.seshi.uploader.plist`.
 * - Linux: a systemd user unit, `~/.config/systemd/user/seshi-uploader.service`.
 * - Windows: a Task Scheduler task, `seshi-uploader`, run at log-on.
 *
 * Each runs `seshi daemon --keep-alive`. The commands that load the entry are run through
 * `exec`, so tests see them without touching the real service manager. */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "@seshi/kit";

export const LAUNCHD_LABEL = "dev.seshi.uploader";
export const SYSTEMD_UNIT = "seshi-uploader.service";
export const WINDOWS_TASK = "seshi-uploader";

/** Runs a program and waits: its exit code and what it printed. */
export type Exec = (words: string[]) => Promise<{ code: number; output: string }>;

export interface ServiceContext {
  home: string;
  platform: NodeJS.Platform;
  /** The words that start seshi (an absolute path: service managers have a bare PATH). */
  command: readonly string[];
  /** Where the uploader's own output goes. */
  logFile: string;
  exec: Exec;
}

export interface ServiceReport {
  /** The entry: a file, or the Windows task's name. */
  entry: string;
  changed: boolean;
  /** Commands that failed, with what they said. */
  problems: string[];
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(command: readonly string[], logFile: string): string {
  const args = [...command, "daemon", "--keep-alive"]
    .map((w) => `    <string>${xml(w)}</string>`)
    .join("\n");
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
  <key>RunAtLoad</key>
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

/** A systemd `ExecStart` word: quoted when it holds a space or a quote. */
const systemdWord = (w: string) =>
  /^[\w@%+=:,./-]+$/.test(w) ? w : `"${w.replace(/(["\\])/g, "\\$1")}"`;

export function systemdUnit(command: readonly string[]): string {
  return `[Unit]
Description=seshi session capture uploader

[Service]
ExecStart=${[...command, "daemon", "--keep-alive"].map(systemdWord).join(" ")}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

/** The Task Scheduler command line: the program quoted, as `schtasks /TR` takes it. */
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
  const entry = entryOf(context);
  switch (context.platform) {
    case "darwin": {
      writeFileAtomic(entry, launchdPlist(context.command, context.logFile), 0o644);
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
      writeFileAtomic(entry, systemdUnit(context.command), 0o644);
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

/** Whether the entry is there (on Windows, whether the task exists). */
export async function serviceInstalled(context: ServiceContext): Promise<boolean> {
  if (context.platform === "win32") {
    return (await runAll(context, [["schtasks", "/Query", "/TN", WINDOWS_TASK]])).length === 0;
  }
  return existsSync(entryOf(context));
}

/** Runs a program and waits for it, bounded at 30 s. */
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
