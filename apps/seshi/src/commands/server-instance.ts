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
import { ServeConfigError } from "../cli/failures";
import { fail } from "../cli/output";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";
import { configFlags, type ServeSettings, serveSettings } from "./serve-settings";

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
  roles?: readonly Role[];
  probe?: readonly string[];
  log?: Logger;
  claimUnmarkedBucket?: boolean;
  trustCwdConfig?: boolean;
}

export function cwdConfigHint(
  ctx: CommandContext,
  configFlag: string | undefined,
  cwd: string = process.cwd(),
): void {
  const { skipped } = findServerConfig({ flag: configFlag, env: ctx.env, cwd, exists: existsSync });
  if (skipped !== undefined) ctx.stderr(SKIPPED_CONFIG_HINT);
}

export const SKIPPED_CONFIG_HINT =
  "seshi: hint: ./seshi.toml here was not read (only seshi serve reads it unasked); pass --config ./seshi.toml to use it";

export interface OpenedServer {
  instance: Instance;
  loaded: Loaded<ServerConfig>;
  settings: ServeSettings;
}

export async function openServer(
  ctx: CommandContext,
  args: ServerArgs,
  options: OpenServerOptions = {},
): Promise<OpenedServer> {
  if (options.trustCwdConfig !== true) cwdConfigHint(ctx, args.config);
  const loaded = loadServerConfig({
    configFlag: args.config,
    env: ctx.env,
    flags: configFlags(args),
    ...(options.trustCwdConfig === true ? { trustCwdConfig: true } : {}),
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
    ...(options.claimUnmarkedBucket === false ? { initialize: false } : {}),
  });
  return { instance, loaded, settings };
}

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
