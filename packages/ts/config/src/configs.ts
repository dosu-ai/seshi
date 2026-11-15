/** The two configs seshi reads: the server's and the CLI's own, each found where F1.1 and
 * F1.4 say and loaded with the other's env names set aside. */

import { type CliConfig, cliConfigSchema } from "./cli";
import { type ConfigFs, type Loaded, type LoadOptions, loadConfig, nodeFs, shapeOf } from "./load";
import { cliConfigPath, findServerConfig, NOT_SETTINGS_ENV } from "./paths";
import { type ServerConfig, serverConfigSchema } from "./server/index";

export interface ServerLoadOptions extends Omit<LoadOptions, "file" | "foreign" | "ignoreEnv"> {
  /** `--config`. */
  configFlag?: string;
  /** Where `./seshi.toml` is looked for; `process.cwd()` by default. */
  cwd?: string;
  /** Overrides `/etc/seshi/seshi.toml` (tests). */
  systemPath?: string;
}

/** The server's config: the file `findServerConfig` picks, `SESHI_*` env and flags. */
export function loadServerConfig(options: ServerLoadOptions = {}): Loaded<ServerConfig> {
  const fs: ConfigFs = options.fs ?? nodeFs;
  const env = options.env ?? {};
  const found = findServerConfig({
    flag: options.configFlag,
    env,
    cwd: options.cwd ?? process.cwd(),
    exists: (path) => fs.mode(path) !== undefined,
    systemPath: options.systemPath,
  });
  return loadConfig(serverConfigSchema, {
    ...options,
    fs,
    env,
    file: found.path,
    ignoreEnv: [...NOT_SETTINGS_ENV],
    foreign: [shapeOf(cliConfigSchema)],
  });
}

export interface CliLoadOptions extends Omit<LoadOptions, "file" | "foreign" | "ignoreEnv"> {
  /** The file to read instead of the default location. It must exist. */
  file?: string;
  /** The home folder; needed unless `file` is given. */
  home?: string;
}

/** The CLI's config: `~/.config/seshi/config.toml` (`%APPDATA%\seshi\config.toml` on Windows)
 * when it exists, `SESHI_*` env and flags. */
export function loadCliConfig(options: CliLoadOptions = {}): Loaded<CliConfig> {
  const fs: ConfigFs = options.fs ?? nodeFs;
  const env = options.env ?? {};
  let file = options.file;
  if (file === undefined && options.home !== undefined) {
    const path = cliConfigPath({
      env,
      home: options.home,
      platform: options.platform ?? process.platform,
    });
    if (fs.mode(path) !== undefined) file = path;
  }
  return loadConfig(cliConfigSchema, {
    ...options,
    fs,
    env,
    file,
    ignoreEnv: [...NOT_SETTINGS_ENV],
    foreign: [shapeOf(serverConfigSchema)],
  });
}
