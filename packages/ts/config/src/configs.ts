import { type CliConfig, cliConfigSchema } from "./cli";
import {
  ConfigError,
  type ConfigFs,
  type Loaded,
  type LoadOptions,
  loadConfig,
  nodeFs,
  parseConfigToml,
  shapeOf,
} from "./load";
import { cliConfigPath, findServerConfig, NOT_SETTINGS_ENV, serverDropInDir } from "./paths";
import { type ServerConfig, serverConfigSchema } from "./server/index";

export interface ServerLoadOptions extends Omit<LoadOptions, "file" | "foreign" | "ignoreEnv"> {
  configFlag?: string;
  cwd?: string;
  systemPath?: string;
  trustCwdConfig?: boolean;
}

/** What a drop-in in `seshi.d/` may add to: sources and rule packs. Everything else is the
 * main file's. */
export const DROP_IN_LISTS: readonly (readonly string[])[] = [["sources"], ["redaction", "packs"]];

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
    ...(found.path !== undefined
      ? { dropIns: { dir: serverDropInDir(found.path), lists: DROP_IN_LISTS } }
      : {}),
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

/** The sections a serverless laptop ignores (F11.3): they configure what only a server runs
 * (OTLP intake is a source, so `[[sources]]` covers it).
 * A bucket that switches modes may keep them in its shared config. */
export const SERVER_ONLY_SECTIONS = ["sources", "auth", "server", "worker"] as const;

export interface ServerlessLoadOptions extends Omit<LoadOptions, "foreign" | "ignoreEnv"> {
  /** The local server config (`serverless.config`); none when unset. Unlike
   * `loadServerConfig`, nothing is looked for in the working folder or /etc. */
  file?: string;
}

/** A serverless laptop's server config (F11.6): the shared layer (`base`), the local file,
 * `SESHI_*` env, then `flags`. The sections in `SERVER_ONLY_SECTIONS` are dropped from every
 * layer (returned in `ignored`, by where they were set), and the shared layer's `[store]` too:
 * the laptop already knows where the bucket is. */
export function loadServerlessConfig(
  options: ServerlessLoadOptions = {},
): Loaded<ServerConfig> & { ignored: string[] } {
  const fs: ConfigFs = options.fs ?? nodeFs;
  const env = options.env ?? {};
  const ignored: string[] = [];
  const drop = (tree: Record<string, unknown>, where: string, store: boolean) => {
    const kept: Record<string, unknown> = { ...tree };
    for (const section of [...SERVER_ONLY_SECTIONS, ...(store ? ["store"] : [])]) {
      if (section in kept) {
        ignored.push(`[${section}] in ${where}`);
        delete kept[section];
      }
    }
    return kept;
  };
  const base = options.base
    ? { path: options.base.path, tree: drop(options.base.tree, options.base.path, true) }
    : undefined;
  const search = base?.tree.search;
  if (search && typeof search === "object" && "path" in search) {
    ignored.push(`search.path in ${base?.path}: a path on each laptop is the laptop's to set`);
    const { path: _path, ...rest } = search as Record<string, unknown>;
    (base as { tree: Record<string, unknown> }).tree.search = rest;
  }
  const file = options.file;
  if (file !== undefined) {
    let text: string;
    try {
      text = fs.readFile(file);
    } catch (err) {
      throw new ConfigError([`cannot read ${file}: ${err instanceof Error ? err.message : err}`]);
    }
    drop(parseConfigToml(file, text), file, false);
  }
  const loaded = loadConfig(serverConfigSchema, {
    ...options,
    ...(base ? { base } : {}),
    fs,
    env,
    ...(file !== undefined ? { file } : {}),
    omit: SERVER_ONLY_SECTIONS,
    ignoreEnv: [...NOT_SETTINGS_ENV],
    foreign: [shapeOf(cliConfigSchema)],
  });
  return { ...loaded, ignored };
}
