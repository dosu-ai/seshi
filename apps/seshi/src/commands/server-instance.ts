/** The commands that run where the server's config and bucket keys are (`serve`, `admin`,
 * `workers`, `sync`, `reprocess`) build an Instance the same way: load the server config
 * (F1.1), check what serve checks, then `buildInstance` with this binary's integrations. Their
 * setting errors print the same way and exit `config` (3). */

import { existsSync } from "node:fs";
import {
  ConfigError,
  findServerConfig,
  type Loaded,
  loadServerConfig,
  type ServerConfig,
} from "@seshi/config";
import {
  buildInstance,
  type Instance,
  InstanceError,
  type Logger,
  type Role,
} from "@seshi/instance";
import { EXIT } from "../cli/exit";
import { fail } from "../cli/output";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";
import { configFlags, ServeConfigError, type ServeSettings, serveSettings } from "./serve-settings";

/** The config flags these commands share. */
export const SERVER_OPTIONS = {
  config: { type: "string" },
  set: { type: "string", multiple: true },
} as const;

export interface ServerArgs {
  config?: string;
  set?: string[];
  listen?: string;
  roles?: string;
}

export interface OpenServerOptions {
  /** What the instance runs; `server.roles` when omitted. A one-shot command passes `[]`. */
  roles?: readonly Role[];
  /** Owners to probe; none for a one-shot command, the static tokens' owners for serve. */
  probe?: readonly string[];
  log?: Logger;
  /** False for a read-only command: a bucket with no layout marker is refused, not claimed. */
  initialize?: boolean;
  /** Read `./seshi.toml` when nothing names a config: `seshi serve` only. */
  cwdFile?: boolean;
}

/** Say how to use a `./seshi.toml` this command did not read. Only `seshi serve` reads one
 * unasked (F1.1, revised): anywhere else the folder may be a checkout someone else wrote, and
 * its secret references could send this machine's env or files to a bucket of theirs. */
export function cwdConfigHint(
  ctx: CommandContext,
  configFlag: string | undefined,
  cwd: string = process.cwd(),
): void {
  const { skipped } = findServerConfig({ flag: configFlag, env: ctx.env, cwd, exists: existsSync });
  if (skipped !== undefined) ctx.stderr(SKIPPED_CONFIG_HINT);
}

/** The hint for a `./seshi.toml` that was there but not read. */
export const SKIPPED_CONFIG_HINT =
  "seshi: hint: ./seshi.toml here was not read (only seshi serve reads it unasked); pass --config ./seshi.toml to use it";

export interface OpenedServer {
  instance: Instance;
  loaded: Loaded<ServerConfig>;
  settings: ServeSettings;
}

/** Load the server config, check it, and build its Instance. Throws `ConfigError`,
 * `ServeConfigError` or `InstanceError` (`serverFailure` prints them). */
export async function openServer(
  ctx: CommandContext,
  args: ServerArgs,
  options: OpenServerOptions = {},
): Promise<OpenedServer> {
  if (options.cwdFile !== true) cwdConfigHint(ctx, args.config);
  const loaded = loadServerConfig({
    configFlag: args.config,
    env: ctx.env,
    flags: configFlags(args),
    ...(options.cwdFile === true ? { cwdFile: true } : {}),
  });
  for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
  const settings = serveSettings(loaded.config);
  const integrations = await ctx.integrations();
  const instance = await buildInstance(loaded.config, {
    formats: buildFormats(integrations),
    integrations,
    env: ctx.env,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.initialize === false ? { initialize: false } : {}),
  });
  return { instance, loaded, settings };
}

/** The exit code for a setting the command cannot run with, printed; undefined for any other
 * error (the caller rethrows it). */
export function serverFailure(
  ctx: CommandContext,
  json: boolean,
  err: unknown,
): number | undefined {
  if (err instanceof ConfigError) {
    if (json) return fail(ctx, true, EXIT.config, "config", err.issues.join("\n"));
    for (const issue of err.issues) ctx.stderr(`seshi: ${issue}`);
    return EXIT.config;
  }
  if (err instanceof ServeConfigError || err instanceof InstanceError) {
    return fail(ctx, json, EXIT.config, "config", err.message);
  }
  return undefined;
}
