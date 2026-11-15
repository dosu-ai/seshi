/** Where `seshi workers status` and `seshi sync status|failed|dropped` read from: the bucket,
 * through the server's config, where that config is (06's commands, as `seshi serve` loads
 * it); or a seshi server over HTTP (`/v1/admin/jobs`, `/v1/admin/sources…`, needing
 * `sources:admin`), from a laptop signed in with `seshi login`.
 *
 * In order: `--server <url>` is the server; `--config` or `--set` is the local config; a
 * server config that serve would find (`SESHI_CONFIG`, `./seshi.toml`,
 * `/etc/seshi/seshi.toml`) is local; the CLI config's `[local] config` is local; its `server`
 * is the server; otherwise local, from `SESHI_*` env alone. */

import { existsSync } from "node:fs";
import { HttpSessionDB } from "@seshi/client";
import { findServerConfig } from "@seshi/config";
import { accountCredential, openAccount, serverOf } from "../account/account";
import { expandHome } from "../connect";
import { USER_AGENT } from "../user-agent";
import type { CommandContext } from "./index";

export type AdminTarget =
  | { kind: "local"; config?: string }
  | { kind: "remote"; server: string; db: HttpSessionDB };

export interface AdminTargetArgs {
  config?: string;
  set?: string[];
  server?: string;
}

/** The server's admin routes, with the stored credential. */
async function remote(ctx: CommandContext, server: string | undefined): Promise<AdminTarget> {
  const account = openAccount(ctx);
  const url = serverOf(account, server) as string;
  const credential = await accountCredential(account, url, "read");
  return {
    kind: "remote",
    server: url,
    db: new HttpSessionDB({
      server: url,
      token: credential.token,
      userAgent: USER_AGENT,
      ...(credential.user ? { user: credential.user } : {}),
    }),
  };
}

export async function adminTarget(
  ctx: CommandContext,
  args: AdminTargetArgs,
  options: { exists?: (path: string) => boolean; cwd?: string } = {},
): Promise<AdminTarget> {
  if (args.server !== undefined) return remote(ctx, args.server);
  if (args.config !== undefined || (args.set?.length ?? 0) > 0) return { kind: "local" };
  const found = findServerConfig({
    env: ctx.env,
    cwd: options.cwd ?? process.cwd(),
    exists: options.exists ?? existsSync,
  });
  if (found.path !== undefined) return { kind: "local" };
  const account = openAccount(ctx);
  if (account.cli.local) {
    return { kind: "local", config: expandHome(account.cli.local.config, account.home) };
  }
  if (account.cli.server) return remote(ctx, account.cli.server);
  return { kind: "local" };
}
