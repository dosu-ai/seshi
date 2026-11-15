/** `seshi healthcheck`: ask a running server's `/healthz` whether it is up, for container
 * health checks where the image has no curl (the image is the compiled binary alone, X2.2).
 *
 *   seshi healthcheck [--url <url>] [--config <file>]
 *
 * Without `--url` it asks `/healthz` where the server listens: `server.listen` from
 * `SESHI_SERVER__LISTEN`, else from the TOML file serve would read (`--config`, `SESHI_CONFIG`,
 * `./seshi.toml`, `/etc/seshi/seshi.toml`), else `:7200`. A wildcard host (`:7200`, `0.0.0.0`,
 * `::`) is asked on 127.0.0.1. Only `server.listen` is read from the file, so a health check
 * never resolves secrets.
 *
 * Exit 0 when it answers ok, 7 (`unavailable`) otherwise. */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseListen } from "@seshi/config";
import { EXIT } from "../cli/exit";
import { usageError } from "../cli/output";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi healthcheck [--url <url>] [--config <file>]";

const DEFAULT_LISTEN = ":7200";

/** The `server.listen` serve would use, without loading the whole config. */
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

/** The `/healthz` URL for a `server.listen` value. */
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
  let url: string;
  try {
    const { values } = parseArgs({
      args: ctx.argv,
      options: { url: { type: "string" }, config: { type: "string" } },
      strict: true,
    });
    url = values.url ?? healthUrl(listenSetting(ctx.env, values.config));
  } catch (err) {
    return usageError(ctx, false, (err as Error).message, USAGE);
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (response.ok && body?.ok === true) {
      ctx.stdout(`ok: ${url}`);
      return EXIT.ok;
    }
    ctx.stderr(`seshi: ${url} answered ${response.status}`);
  } catch (err) {
    ctx.stderr(`seshi: ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return EXIT.unavailable;
}
