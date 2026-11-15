/** `seshi config check` and `seshi config show` (F1.4).
 *
 *   seshi config check [--cli] [--config <file>] [--json] [--set path=value]…
 *       Validates the server's config (or the CLI's, with --cli) the way `seshi serve` loads it,
 *       secret references included, and prints warnings. Exit 0 when it can be used, 3 (config)
 *       when not.
 *   seshi config show [--cli] [--config <file>] [--origin] [--json] [--set path=value]…
 *       Prints every value, with --origin where it came from (flag, env, file, default).
 *       Secrets are masked and not read. */

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  type CheckReport,
  type ConfigEntry,
  ConfigError,
  checkServerConfig,
  configEntries,
  describeOrigin,
  displayTree,
  type Loaded,
  loadCliConfig,
  loadServerConfig,
} from "@seshi/config";
import { EXIT } from "../cli/exit";
import type { CommandContext } from "./index";
import { configFlags, ServeConfigError, serveSettings } from "./serve-settings";

const USAGE = `usage: seshi config check [--cli] [--config <file>] [--json] [--set path=value]…
       seshi config show  [--cli] [--config <file>] [--origin] [--json] [--set path=value]…`;

interface Options {
  cli?: boolean;
  config?: string;
  json?: boolean;
  origin?: boolean;
  listen?: string;
  roles?: string;
  set?: string[];
}

function loadCli(ctx: CommandContext, options: Options, resolveSecrets: boolean) {
  if (options.listen !== undefined || options.roles !== undefined) {
    throw new ServeConfigError("--listen and --roles are server settings, not the CLI's");
  }
  return loadCliConfig({
    file: options.config,
    home: ctx.env.HOME || ctx.env.USERPROFILE || homedir(),
    env: ctx.env,
    flags: configFlags({ set: options.set }),
    resolveSecrets,
  });
}

function loadServer(ctx: CommandContext, options: Options, resolveSecrets: boolean) {
  const { listen, roles, set } = options;
  return loadServerConfig({
    configFlag: options.config,
    env: ctx.env,
    flags: configFlags({ listen, roles, set }),
    resolveSecrets,
  });
}

function load(ctx: CommandContext, options: Options, resolveSecrets: boolean): Loaded<unknown> {
  return options.cli
    ? loadCli(ctx, options, resolveSecrets)
    : loadServer(ctx, options, resolveSecrets);
}

function where(loaded: Loaded<unknown>): string {
  return loaded.file ?? "no config file (env and defaults)";
}

function check(ctx: CommandContext, options: Options): number {
  const errors: string[] = [];
  let file: string | undefined;
  let loaded: Loaded<unknown> | undefined;
  let report: CheckReport = { warnings: [], notices: [] };
  try {
    if (options.cli) {
      loaded = loadCli(ctx, options, true);
    } else {
      const server = loadServer(ctx, options, true);
      loaded = server;
      report = checkServerConfig(server.config);
      serveSettings(server.config);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      errors.push(...err.issues);
      file = err.file;
    } else if (err instanceof ServeConfigError) errors.push(err.message);
    else throw err;
  }
  const warnings = [...(loaded?.warnings ?? []), ...report.warnings];
  if (options.json) {
    ctx.stdout(
      JSON.stringify(
        {
          ok: errors.length === 0,
          file: loaded?.file ?? file ?? null,
          errors,
          warnings,
          notices: report.notices,
        },
        null,
        2,
      ),
    );
    return errors.length === 0 ? EXIT.ok : EXIT.config;
  }
  for (const error of errors) ctx.stderr(`error: ${error}`);
  for (const warning of warnings) ctx.stdout(`warning: ${warning}`);
  for (const notice of report.notices) ctx.stdout(`note: ${notice}`);
  if (errors.length > 0 || !loaded) return EXIT.config;
  const counted =
    warnings.length === 0 ? "" : ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`;
  ctx.stdout(`ok: ${where(loaded)}${counted}`);
  return 0;
}

function show(ctx: CommandContext, options: Options): number {
  let loaded: Loaded<unknown>;
  try {
    loaded = load(ctx, options, false);
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const issue of err.issues) ctx.stderr(`error: ${issue}`);
      return EXIT.config;
    }
    if (err instanceof ServeConfigError) {
      ctx.stderr(`error: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }
  const entries: ConfigEntry[] = configEntries(loaded);
  if (options.json) {
    const out = options.origin
      ? {
          file: loaded.file ?? null,
          values: entries.map(({ name, value, origin }) => ({ path: name, value, origin })),
        }
      : displayTree(loaded);
    ctx.stdout(JSON.stringify(out, null, 2));
    return 0;
  }
  if (options.origin) ctx.stdout(`# ${where(loaded)}`);
  for (const entry of entries) {
    const line = `${entry.name} = ${JSON.stringify(entry.value)}`;
    ctx.stdout(options.origin ? `${line}  # ${describeOrigin(entry.origin)}` : line);
  }
  return 0;
}

export async function run(ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = ctx.argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    (sub === undefined ? ctx.stderr : ctx.stdout)(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== "check" && sub !== "show") {
    ctx.stderr(`seshi config: unknown subcommand '${sub}'\n\n${USAGE}`);
    return 2;
  }
  let options: Options;
  try {
    ({ values: options } = parseArgs({
      args: rest,
      options: {
        cli: { type: "boolean" },
        config: { type: "string" },
        json: { type: "boolean" },
        origin: { type: "boolean" },
        listen: { type: "string" },
        roles: { type: "string" },
        set: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
    if (sub === "check" && options.origin) throw new Error("--origin is for config show");
  } catch (err) {
    ctx.stderr(`seshi config: ${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 2;
  }
  try {
    return sub === "check" ? check(ctx, options) : show(ctx, options);
  } catch (err) {
    if (err instanceof ServeConfigError) {
      ctx.stderr(`error: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }
}
