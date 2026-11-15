/** `seshi logout`: forget the credentials `seshi login` stored for a server (F8.2): the
 * profile and every secret, from the keychain and the fallback file. Nothing is revoked on the
 * server: the CLI's credentials cannot revoke tokens (X5.3). A device token stays valid until
 * it expires or an admin revokes it (`seshi tokens revoke <id>`); the message names its id.
 *
 *   seshi logout [--server <url>] [--all] [--json]
 *
 * Exit 0, whether or not there was anything to forget. */

import { parseArgs } from "node:util";
import { openAccount, serverOf } from "../account/account";
import type { LoginProfile } from "../account/logins";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, takeJson, usageError } from "../cli/output";
import { styleFor } from "../cli/style";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi logout [--server <url>] [--all] [--json]";

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: { server?: string; all?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { server: { type: "string" }, all: { type: "boolean" } },
      strict: true,
    }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  if (values.all && values.server) {
    return usageError(ctx, json, "give --server or --all, not both", USAGE);
  }
  try {
    const account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    let servers: string[];
    if (values.all) servers = account.logins.list().map((p) => p.server);
    else {
      const server = serverOf(account, values.server);
      if (server === undefined) {
        return usageError(ctx, json, "which server? seshi logout --server <url>, or --all", USAGE);
      }
      servers = [server];
    }
    const results: {
      server: string;
      signed_out: boolean;
      device_token?: LoginProfile["device"];
    }[] = [];
    for (const server of servers) {
      const profile = account.logins.get(server);
      const removed = await account.logins.remove(server);
      results.push({
        server,
        signed_out: removed,
        ...(profile?.device ? { device_token: profile.device } : {}),
      });
    }
    emit(ctx, json, { servers: results }, () => {
      if (results.length === 0) return ["Not signed in anywhere."];
      const lines: string[] = [];
      for (const r of results) {
        if (!r.signed_out) {
          lines.push(`Not signed in to ${r.server}.`);
          continue;
        }
        lines.push(`${style.status("Signed out", "success")} of ${style.link(r.server)}.`);
        if (r.device_token) {
          lines.push(
            `  Its device token (${r.device_token.id}) stays valid until ${r.device_token.expires_at.slice(0, 10)}; an admin can revoke it: seshi tokens revoke ${r.device_token.id}`,
          );
        }
      }
      return lines;
    });
    return EXIT.ok;
  } catch (err) {
    return failWith(ctx, json, err);
  }
}
