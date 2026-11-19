import { dirname, join, posix, resolve, win32 } from "node:path";

export const CONFIG_ENV = "SESHI_CONFIG";

export const NOT_SETTINGS_ENV: readonly string[] = [
  CONFIG_ENV,
  "SESHI_SESSION_ID",
  "SESHI_AGENT",
  "SESHI_NO_UPLOADER",
  // A token scripts pipe to `seshi login --token -`; seshi never reads one from the environment.
  "SESHI_TOKEN",
];
export const SERVER_CONFIG_NAME = "seshi.toml";
export const SYSTEM_CONFIG_PATH = "/etc/seshi/seshi.toml";
export const DROP_IN_DIR_NAME = "seshi.d";

/** The drop-in folder beside a server config file: `/etc/seshi/seshi.d` for
 * `/etc/seshi/seshi.toml`. */
export function serverDropInDir(configFile: string): string {
  return join(dirname(configFile), DROP_IN_DIR_NAME);
}

export interface ServerConfigLookup {
  flag?: string;
  env: Record<string, string | undefined>;
  cwd: string;
  exists(path: string): boolean;
  systemPath?: string;
  trustCwdConfig?: boolean;
}

export function findServerConfig(lookup: ServerConfigLookup): {
  path?: string;
  explicit: boolean;
  skipped?: string;
} {
  const named = lookup.flag ?? (lookup.env[CONFIG_ENV] || undefined);
  if (named !== undefined) return { path: resolve(lookup.cwd, named), explicit: true };
  const here = join(lookup.cwd, SERVER_CONFIG_NAME);
  if (lookup.trustCwdConfig === true && lookup.exists(here)) return { path: here, explicit: false };
  const skipped = lookup.trustCwdConfig !== true && lookup.exists(here) ? { skipped: here } : {};
  const system = lookup.systemPath ?? SYSTEM_CONFIG_PATH;
  if (lookup.exists(system)) return { path: system, explicit: false, ...skipped };
  return { explicit: false, ...skipped };
}

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
  const base = env.XDG_CONFIG_HOME || posix.join(home, ".config");
  return posix.join(base, "seshi", "config.toml");
}
