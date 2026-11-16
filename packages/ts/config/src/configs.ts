import { type CliConfig, cliConfigSchema } from "./cli";
import { type ConfigFs, type Loaded, type LoadOptions, loadConfig, nodeFs, shapeOf } from "./load";
import { cliConfigPath, findServerConfig, NOT_SETTINGS_ENV } from "./paths";
import { type ServerConfig, serverConfigSchema } from "./server/index";

export interface ServerLoadOptions extends Omit<LoadOptions, "file" | "foreign" | "ignoreEnv"> {
  configFlag?: string;
  cwd?: string;
  systemPath?: string;
  trustCwdConfig?: boolean;
}

export function loadServerConfig(options: ServerLoadOptions = {}): Loaded<ServerConfig> {
  const fs: ConfigFs = options.fs ?? nodeFs;
  const env = options.env ?? {};
  const found = findServerConfig({
    flag: options.configFlag,
    env,
    cwd: options.cwd ?? process.cwd(),
    exists: (path) => fs.mode(path) !== undefined,
    systemPath: options.systemPath,
    trustCwdConfig: options.trustCwdConfig,
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
  file?: string;
  home?: string;
}

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
