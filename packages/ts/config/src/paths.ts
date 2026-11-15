/** Where the config files are (F1.1, F1.4, F8.4). Pure: the environment, working directory
 * and platform come in as arguments. */

import { join, posix, resolve, win32 } from "node:path";

/** The env variable naming the server's config file. */
export const CONFIG_ENV = "SESHI_CONFIG";

/** `SESHI_*` variables that are not settings, which both loaders pass over: the config file's
 * name, and capture's own (F9): `SESHI_SESSION_ID` and `SESHI_AGENT`, which an agent's
 * SessionStart hook sets for every command the agent runs, and `SESHI_NO_UPLOADER`. */
export const NOT_SETTINGS_ENV: readonly string[] = [
  CONFIG_ENV,
  "SESHI_SESSION_ID",
  "SESHI_AGENT",
  "SESHI_NO_UPLOADER",
];
export const SERVER_CONFIG_NAME = "seshi.toml";
export const SYSTEM_CONFIG_PATH = "/etc/seshi/seshi.toml";

export interface ServerConfigLookup {
  /** `--config`. */
  flag?: string;
  env: Record<string, string | undefined>;
  cwd: string;
  exists(path: string): boolean;
  /** Overrides `/etc/seshi/seshi.toml` (tests). */
  systemPath?: string;
}

/** The server's config file: `--config`, else `SESHI_CONFIG`, else `./seshi.toml`, else
 * `/etc/seshi/seshi.toml` (F1.1). A file named by the flag or env must exist (`explicit`);
 * the other two are used when present, and with neither the config is env and defaults. */
export function findServerConfig(lookup: ServerConfigLookup): {
  path?: string;
  explicit: boolean;
} {
  const named = lookup.flag ?? (lookup.env[CONFIG_ENV] || undefined);
  if (named !== undefined) return { path: resolve(lookup.cwd, named), explicit: true };
  for (const candidate of [
    join(lookup.cwd, SERVER_CONFIG_NAME),
    lookup.systemPath ?? SYSTEM_CONFIG_PATH,
  ]) {
    if (lookup.exists(candidate)) return { path: candidate, explicit: false };
  }
  return { explicit: false };
}

/** The CLI's config file: `%APPDATA%\seshi\config.toml` on Windows, else
 * `$XDG_CONFIG_HOME/seshi/config.toml`, else `~/.config/seshi/config.toml`. */
export function cliConfigPath(options: {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
}): string {
  const { env, home, platform } = options;
  if (platform === "win32") {
    const appData = env.APPDATA || win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "seshi", "config.toml");
  }
  // Joined as the platform named does, whatever this process runs on.
  const base = env.XDG_CONFIG_HOME || posix.join(home, ".config");
  return posix.join(base, "seshi", "config.toml");
}
