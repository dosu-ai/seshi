import { parseDuration } from "@seshi/config";
import { type Account, openAccount } from "../account/account";
import { type Backend, openBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { fail, helpOrUsageError } from "../cli/output";
import { printable } from "../cli/style";
import { failureOf, realDeps } from "../doctor/index";
import { ExploreApi } from "../explore/api";
import { type Assets, loadAssets } from "../explore/assets";

export { type Assets, buildAssets } from "../explore/assets";

import { type ExploreServer, startExploreServer } from "../explore/server";
import { pathsOf } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE =
  "usage: seshi explore [--port <n>] [--no-open] [--server <url>] [--since <duration>] [--include-private]";

export const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExploreArgs {
  port?: number;
  open: boolean;
  server?: string;
  since?: string;
  /** Serverless mode: read others' owner-only sessions too. */
  includePrivate?: boolean;
}

export function parseExploreArgs(argv: readonly string[]): ExploreArgs | string {
  const args: ExploreArgs = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    switch (word) {
      case "--no-open":
        args.open = false;
        break;
      case "--include-private":
        args.includePrivate = true;
        break;
      case "--port":
      case "--server":
      case "--since": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) return `${word} needs a value`;
        i++;
        if (word === "--port") {
          if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) {
            return `--port takes a port number (0–65535), not '${value}'`;
          }
          args.port = Number(value);
        } else args[word.slice(2) as "server" | "since"] = value;
        break;
      }
      default:
        return word.startsWith("-") ? `unknown option ${word}` : `unexpected ${word}`;
    }
  }
  return args;
}

export interface RunningExplore {
  server: ExploreServer;
  api: ExploreApi;
  /** Where stored sessions are read from, in words. */
  where: string;
  close(): Promise<void>;
}

/** Start the server: the backend and the doctor's loaders, the API and the page. The command
 * itself only adds the browser and the signals; tests call this. */
export async function startExplore(
  ctx: CommandContext,
  args: Omit<ExploreArgs, "open">,
  options: { assets?: Assets; sinceMs?: number } = {},
): Promise<RunningExplore> {
  const { host, paths } = pathsOf(ctx);
  let account: Account | undefined;
  let backend: Backend | undefined;
  let backendError: ReturnType<typeof failureOf> | undefined;
  try {
    account = openAccount(ctx);
    backend = await openBackend(ctx, account, {
      ...(args.server ? { server: args.server } : {}),
      ...(args.includePrivate ? { includePrivate: true } : {}),
      purpose: "read",
    });
  } catch (err) {
    backendError = failureOf(err);
    if (backendError.exit === undefined) throw err;
  }
  try {
    const deps = await realDeps(ctx, {
      host,
      paths,
      ...(backend ? { backend } : {}),
      ...(backendError ? { backendError } : {}),
      ...(account ? { account } : {}),
    });
    const assets = options.assets ?? (await loadAssets());
    const api = new ExploreApi(deps, { sinceMs: options.sinceMs ?? DEFAULT_SINCE_MS });
    const server = startExploreServer({
      api,
      assets,
      ...(args.port !== undefined ? { port: args.port } : {}),
    });
    return {
      server,
      api,
      where: backend?.where ?? `nowhere (${backendError?.message ?? "no server"})`,
      async close() {
        api.close();
        await server.stop();
        await backend?.close();
      },
    };
  } catch (err) {
    await backend?.close();
    throw err;
  }
}

export async function run(ctx: CommandContext): Promise<number | undefined> {
  const args = parseExploreArgs(ctx.argv);
  if (typeof args === "string") return helpOrUsageError(ctx, false, args, USAGE);
  const sinceMs = args.since === undefined ? DEFAULT_SINCE_MS : parseDuration(args.since);
  if (sinceMs === undefined) {
    return helpOrUsageError(
      ctx,
      false,
      `--since takes a duration (2h, 1d, 7d), not '${args.since}'`,
      USAGE,
    );
  }
  let running: RunningExplore;
  try {
    running = await startExplore(ctx, args, { sinceMs });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      return fail(
        ctx,
        false,
        EXIT.config,
        "port",
        `cannot listen on 127.0.0.1:${args.port}: ${code}`,
      );
    }
    throw err;
  }
  const { server } = running;
  ctx.stdout(`seshi explore: ${server.url}`);
  ctx.stdout(
    `  sessions seen in the past ${printable(args.since ?? "7d")}, stored sessions read from ${printable(running.where)}`,
  );
  ctx.stdout("  read-only; Ctrl-C stops it");
  if (args.open) {
    const opened = ctx.terminal ? await (await ctx.terminal()).openUrl(server.url) : false;
    if (!opened) ctx.stderr("seshi: open the address above in a browser");
  }
  const stop = () => {
    void running.close().finally(() => process.exit(EXIT.ok));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return undefined;
}
