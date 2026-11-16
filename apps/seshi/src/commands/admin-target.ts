import { existsSync } from "node:fs";
import { HttpSessionDB } from "@seshi/client";
import { findServerConfig } from "@seshi/config";
import { accountCredential, openAccount, serverOf } from "../account/account";
import { isServerless } from "../serverless/settings";
import { USER_AGENT } from "../user-agent";
import type { CommandContext } from "./index";
import { SKIPPED_CONFIG_HINT } from "./server-instance";

export type AdminTarget =
  | { kind: "local"; config?: string }
  | { kind: "remote"; server: string; db: HttpSessionDB }
  /** The CLI config names a serverless bucket (F11): there is no server or worker to ask. */
  | { kind: "serverless" };

export interface AdminTargetArgs {
  config?: string;
  set?: string[];
  server?: string;
}

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
  const hint = () => {
    if (found.skipped !== undefined) ctx.stderr(SKIPPED_CONFIG_HINT);
  };
  const account = openAccount(ctx);
  if (isServerless(account.cli)) {
    hint();
    return { kind: "serverless" };
  }
  if (account.cli.server) {
    hint();
    return remote(ctx, account.cli.server);
  }
  return { kind: "local" };
}
