import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseListen } from "@seshi/config";
import { EXIT } from "../cli/exit";
import { emit, fail, helpOrUsageError, takeJson } from "../cli/output";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi healthcheck [--url <url>] [--config <file>] [--json]";

const DEFAULT_LISTEN = ":7200";

export function listenSetting(
  env: Record<string, string | undefined>,
  configFlag: string | undefined,
  readFile: (path: string) => string | undefined = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
): string {
  if (env.SESHI_SERVER__LISTEN) return env.SESHI_SERVER__LISTEN;
  const files = configFlag
    ? [configFlag]
    : env.SESHI_CONFIG
      ? [env.SESHI_CONFIG]
      : ["seshi.toml", "/etc/seshi/seshi.toml"];
  for (const file of files) {
    const text = readFile(file);
    if (text === undefined) continue;
    try {
      const listen = (Bun.TOML.parse(text) as { server?: { listen?: unknown } }).server?.listen;
      return typeof listen === "string" ? listen : DEFAULT_LISTEN;
    } catch {
      return DEFAULT_LISTEN;
    }
  }
  return DEFAULT_LISTEN;
}

export function healthUrl(listen: string): string {
  const parsed = parseListen(listen) ?? parseListen(DEFAULT_LISTEN);
  const { hostname, port } = parsed as { hostname: string; port: number };
  const host = ["0.0.0.0", "::", ""].includes(hostname)
    ? "127.0.0.1"
    : hostname.includes(":")
      ? `[${hostname}]`
      : hostname;
  return `http://${host}:${port}/healthz`;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let url: string;
  try {
    const { values } = parseArgs({
      args: rest,
      options: { url: { type: "string" }, config: { type: "string" } },
      strict: true,
    });
    url = values.url ?? healthUrl(listenSetting(ctx.env, values.config));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  let problem: string;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      version?: unknown;
    } | null;
    if (response.ok && body?.ok === true) {
      const version = typeof body.version === "string" ? body.version : undefined;
      emit(ctx, json, { ok: true, url, ...(version ? { version } : {}) }, () => [`ok: ${url}`]);
      return EXIT.ok;
    }
    problem = `${url} answered ${response.status}`;
  } catch (err) {
    problem = `${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return fail(ctx, json, EXIT.unavailable, "unavailable", problem);
}
