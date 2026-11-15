/** `seshi healthcheck`: ask a running server's `/healthz` whether it is up, for container
 * health checks where the image has no curl (the image is the compiled binary alone, X2.2).
 *
 *   seshi healthcheck [--url <url>]
 *
 * Without `--url` it asks `http://127.0.0.1:<port>/healthz`, the port from
 * `SESHI_SERVER__LISTEN` when set, else 7200.
 *
 * Exit 0 when it answers ok, 7 (`unavailable`) otherwise. */

import { parseArgs } from "node:util";
import { EXIT } from "../cli/exit";
import { usageError } from "../cli/output";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi healthcheck [--url <url>]";

/** The port of a `server.listen` value (`host:port`, `:port`, `port`); 7200 when unset or
 * unreadable. */
export function listenPort(listen: string | undefined): number {
  const port = Number(/(\d{1,5})\s*$/.exec(listen ?? "")?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 7200;
}

export async function run(ctx: CommandContext): Promise<number> {
  let url: string;
  try {
    const { values } = parseArgs({
      args: ctx.argv,
      options: { url: { type: "string" } },
      strict: true,
    });
    url = values.url ?? `http://127.0.0.1:${listenPort(ctx.env.SESHI_SERVER__LISTEN)}/healthz`;
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
