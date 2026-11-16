import { parseArgs } from "node:util";
import type { Identity } from "@seshi/model";
import { openAccount, serverOf } from "../account/account";
import { openBackend, ServerBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, helpOrUsageError, takeJson } from "../cli/output";
import { type Style, styleFor } from "../cli/style";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi whoami [--server <url>] [--json]";

function lines(
  identity: Identity,
  mode: "server" | "serverless",
  where: string,
  login: { mode: string; user?: string; stored_in: string } | undefined,
  style: Style,
): string[] {
  const out: string[] = [];
  if (mode === "serverless") {
    out.push(
      `${style.bold(identity.owner)} in serverless mode: sessions go straight to ${style.link(where)}`,
    );
    out.push(`  owner       ${identity.owner_basis ?? "claimed"} (from the CLI config)`);
    out.push("  access      the bucket key's permissions decide what this machine may do");
    return out;
  }
  out.push(`${style.bold(identity.owner)} on ${style.link(where)}`);
  const via =
    login?.mode === "org_key"
      ? `the org key, stating '${login.user}'`
      : login?.mode === "oidc"
        ? "an IdP sign-in"
        : "a token";
  out.push(
    `  credential  ${identity.kind ?? "?"} (${via}), kept in the ${login?.stored_in ?? "?"}`,
  );
  if (identity.role) out.push(`  role        ${identity.role}`);
  if (identity.scopes) out.push(`  scopes      ${identity.scopes.join(", ")}`);
  if (identity.owner_basis) out.push(`  owner       ${identity.owner_basis}`);
  if (identity.visibility) out.push(`  writes as   ${identity.visibility} visibility`);
  if (identity.expires_at) out.push(`  expires     ${identity.expires_at}`);
  return out;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: { server?: string };
  try {
    ({ values } = parseArgs({ args: rest, options: { server: { type: "string" } }, strict: true }));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  try {
    const account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    const backend = await openBackend(ctx, account, {
      ...(values.server ? { server: values.server } : {}),
    });
    try {
      const identity = await backend.me();
      const profile =
        backend.mode === "server"
          ? account.logins.get(serverOf(account, values.server) as string)
          : undefined;
      const login = profile
        ? {
            mode: profile.mode,
            stored_in: profile.stored_in,
            ...(backend instanceof ServerBackend && backend.user ? { user: backend.user } : {}),
          }
        : undefined;
      emit(
        ctx,
        json,
        { mode: backend.mode, where: backend.where, identity, ...(login ? { login } : {}) },
        () => lines(identity, backend.mode, backend.where, login, style),
      );
      return EXIT.ok;
    } finally {
      await backend.close();
    }
  } catch (err) {
    return failWith(ctx, json, err);
  }
}
