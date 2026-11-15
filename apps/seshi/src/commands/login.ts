/** `seshi login`: sign in to a seshi server (F8.2, X5.7). `GET /v1/auth/config` says which
 * ways in the server takes:
 *
 * - With an IdP: the device flow (a code to enter in a browser), or `--browser` for the browser
 *   with PKCE where the device flow is not allowed. The ID token is exchanged once for a session
 *   token (interactive commands, one hour, renewed through the IdP's refresh token) and a
 *   write-only device token for unattended uploads (90 days).
 * - Without one: `--key` stores the org key; the username stated with it is resolved on every
 *   use (`--user`, which writes `user` to the CLI config, SESHI_USER, git user.email, the OS
 *   user).
 * - `--token` stores a token an admin issued (an admin or service token), or a static token.
 *
 * Credentials go in the OS keychain, falling back to a 0600 file next to the CLI config. A
 * `--server` is written to the CLI config, so later commands use it.
 *
 *   seshi login [--server <url>] [--key <key>|-] [--token <token>|-] [--user <name>]
 *               [--browser|--device] [--visibility org|owner] [--json]
 *
 * Exit 0 signed in; 2 usage; 3 the CLI config is in local mode or cannot be written; 5 the
 * server or IdP refused; 7 the server or IdP cannot be reached. */

import { hostname } from "node:os";
import { parseArgs } from "node:util";
import {
  type AuthConfig,
  authConfig,
  exchangeIdToken,
  HttpSessionDB,
  ServerError,
} from "@seshi/client";
import type { Identity } from "@seshi/model";
import { type Account, fallbackWarning, openAccount, serverOf } from "../account/account";
import { writeCliKey } from "../account/cli-file";
import type { LoginProfile } from "../account/logins";
import {
  browserFlow,
  type DeviceCode,
  deviceFlow,
  discover,
  type IdpTokens,
  signInScopes,
} from "../account/oidc";
import { resolveUser, sendableUser } from "../account/user";
import { EXIT } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, takeJson, usageError } from "../cli/output";
import { type Style, styleFor } from "../cli/style";
import type { CommandContext } from "./index";

const USAGE = `usage: seshi login [--server <url>] [--key <org key>|-] [--token <token>|-] [--user <name>]
                   [--browser|--device] [--visibility org|owner] [--json]`;

const OPTIONS = {
  server: { type: "string" },
  key: { type: "string" },
  token: { type: "string" },
  user: { type: "string" },
  browser: { type: "boolean" },
  device: { type: "boolean" },
  visibility: { type: "string" },
} as const;

interface Values {
  server?: string;
  key?: string;
  token?: string;
  user?: string;
  browser?: boolean;
  device?: boolean;
  visibility?: string;
}

/** A secret from a flag: `-` reads it from standard input. */
async function secretArg(ctx: CommandContext, value: string, what: string): Promise<string> {
  if (value !== "-") return value.trim();
  if (!ctx.stdin)
    throw new Refused(EXIT.usage, "usage", `no standard input to read the ${what} from`);
  const read = (await ctx.stdin()).trim();
  if (!read) throw new Refused(EXIT.usage, "usage", `standard input held no ${what}`);
  return read;
}

/** Who a pasted credential is, as the server says; 401 means it does not accept it. */
async function identify(server: string, token: string, user?: string): Promise<Identity> {
  try {
    return await new HttpSessionDB({ server, token, ...(user ? { user } : {}) }).me();
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      throw new Refused(EXIT.auth, "unauthorized", `${server} does not accept that credential`);
    }
    throw err;
  }
}

/** The IdP sign-in: device flow or browser, then the exchange (X5.2). */
async function idpSignIn(
  ctx: CommandContext,
  account: Account,
  server: string,
  config: AuthConfig,
  values: Values,
  style: Style,
): Promise<{ profile: Omit<LoginProfile, "stored_in">; secrets: Record<string, string> }> {
  const oidc = config.oidc as NonNullable<AuthConfig["oidc"]>;
  const fetchImpl = (input: string, init?: RequestInit) => globalThis.fetch(input, init);
  const discovery = await discover(oidc.issuer, fetchImpl);
  const scopes = signInScopes(oidc.scopes, discovery);
  const useBrowser =
    values.browser === true ||
    (values.device !== true && discovery.device_authorization_endpoint === undefined);
  let tokens: IdpTokens;
  let nonce: string | undefined;
  let flow: "device" | "browser";
  if (useBrowser) {
    flow = "browser";
    const terminal = ctx.terminal ? await ctx.terminal() : undefined;
    const signedIn = await browserFlow({
      discovery,
      clientId: oidc.client_id,
      scopes,
      fetch: fetchImpl,
      open: async (url) => (terminal ? terminal.openUrl(url) : false),
      prompt: (url) => {
        ctx.stderr(`Opening your browser to sign in. If it does not open, visit:`);
        ctx.stderr(`  ${style.link(url)}`);
      },
    });
    tokens = signedIn;
    nonce = signedIn.nonce;
  } else {
    flow = "device";
    tokens = await deviceFlow({
      discovery,
      clientId: oidc.client_id,
      scopes,
      fetch: fetchImpl,
      prompt: (code: DeviceCode) => {
        ctx.stderr(
          `To sign in, open ${style.link(code.verification_uri)} and enter the code ${style.bold(code.user_code)}`,
        );
        if (code.verification_uri_complete) {
          ctx.stderr(`  or open ${style.link(code.verification_uri_complete)}`);
        }
        ctx.stderr(style.progress("Waiting for you to sign in…"));
      },
    });
  }
  const machineName = hostname().slice(0, 128);
  const exchanged = await exchangeIdToken(
    { server, fetch: fetchImpl },
    {
      id_token: tokens.id_token,
      ...(nonce ? { nonce } : {}),
      machine: { id: account.logins.machineId(), ...(machineName ? { name: machineName } : {}) },
      ...(values.visibility ? { visibility: values.visibility as "org" | "owner" } : {}),
    },
  ).catch((err: unknown) => {
    if (err instanceof ServerError && err.status === 401) {
      throw new Refused(EXIT.auth, "unauthorized", `${server} refused the sign-in: ${err.message}`);
    }
    throw err;
  });
  const now = new Date().toISOString();
  return {
    profile: {
      server,
      mode: "oidc",
      owner: exchanged.owner,
      role: exchanged.role,
      scopes: exchanged.scopes,
      oidc: {
        issuer: oidc.issuer,
        client_id: oidc.client_id,
        token_endpoint: discovery.token_endpoint,
        flow,
      },
      session: { issued_at: now, expires_at: exchanged.expires_at },
      delete_fresh_seconds: config.delete_fresh_seconds,
      ...(exchanged.device_token
        ? {
            device: {
              id: exchanged.device_token.id,
              expires_at: exchanged.device_token.expires_at,
            },
          }
        : {}),
      signed_in_at: now,
    },
    secrets: {
      session: exchanged.session_token,
      ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : {}),
      ...(exchanged.device_token ? { device: exchanged.device_token.token } : {}),
    },
  };
}

function summary(profile: LoginProfile, style: Style): string[] {
  const how =
    profile.mode === "oidc"
      ? "through the IdP"
      : profile.mode === "org_key"
        ? `with the org key, as ${profile.user}`
        : "with a token";
  const lines = [
    `${style.status("Signed in", "success")} to ${style.link(profile.server)} as ${style.bold(profile.owner ?? "?")} (${profile.role ?? "?"}, ${how}).`,
  ];
  if (profile.device) {
    lines.push(
      `Uploads use a device token that expires ${profile.device.expires_at.slice(0, 10)}.`,
    );
  }
  return lines;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: Values;
  try {
    const parsed = parseArgs({
      args: rest,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  const given = [values.key, values.token].filter((v) => v !== undefined).length;
  if (given > 1) return usageError(ctx, json, "give --key or --token, not both", USAGE);
  if (values.browser && values.device) {
    return usageError(ctx, json, "give --browser or --device, not both", USAGE);
  }
  if (
    values.visibility !== undefined &&
    values.visibility !== "org" &&
    values.visibility !== "owner"
  ) {
    return usageError(ctx, json, "--visibility must be org or owner", USAGE);
  }
  if (values.user !== undefined && !sendableUser(values.user)) {
    return usageError(ctx, json, "--user must be printable ASCII", USAGE);
  }
  try {
    const account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    if (account.cli.local) {
      throw new Refused(
        EXIT.config,
        "local_mode",
        `the CLI config (${account.cliFile}) uses local mode ([local]): sessions go straight to your bucket and need no sign-in. Remove [local] to use a server.`,
      );
    }
    const server = serverOf(account, values.server);
    if (server === undefined) {
      return usageError(ctx, json, "which server? seshi login --server <url>", USAGE);
    }
    let config: AuthConfig;
    try {
      config = await authConfig({ server });
    } catch (err) {
      if (err instanceof ServerError && err.status === 404) {
        throw new Refused(
          EXIT.config,
          "not_seshi",
          `${server} has no /v1/auth/config: is it a seshi server?`,
        );
      }
      throw err;
    }

    let profile: Omit<LoginProfile, "stored_in">;
    let secrets: Record<string, string>;
    const now = new Date().toISOString();
    if (values.token !== undefined) {
      const token = await secretArg(ctx, values.token, "token");
      const me = await identify(server, token);
      profile = {
        server,
        mode: "token",
        owner: me.owner,
        ...(me.role ? { role: me.role } : {}),
        ...(me.scopes ? { scopes: me.scopes } : {}),
        ...(me.credential_id ? { credential_id: me.credential_id } : {}),
        signed_in_at: now,
      };
      secrets = { token };
    } else if (values.key !== undefined || (!config.oidc && config.org_key)) {
      if (!config.org_key) {
        throw new Refused(
          EXIT.auth,
          "no_org_key",
          `${server} does not take the org key; sign in through its IdP: seshi login`,
        );
      }
      let key: string;
      if (values.key !== undefined) key = await secretArg(ctx, values.key, "org key");
      else if (ctx.terminal && ctx.tty?.stdin) {
        key = (await (await ctx.terminal()).ask("Org key: ", { hidden: true })).trim();
        if (!key) throw new Refused(EXIT.usage, "usage", "no org key given");
      } else {
        return usageError(
          ctx,
          json,
          `${server} signs in with the org key: seshi login --key - (reads it from standard input)`,
          USAGE,
        );
      }
      // --user wins here; later uses resolve it again in X5.7's order (SESHI_USER first).
      const { user, from } =
        values.user !== undefined
          ? { user: values.user, from: "flag" }
          : await resolveUser({
              env: ctx.env,
              ...(account.cli.user ? { configured: account.cli.user } : {}),
            });
      const me = await identify(server, key, user);
      profile = {
        server,
        mode: "org_key",
        owner: me.owner,
        ...(me.role ? { role: me.role } : {}),
        ...(me.scopes ? { scopes: me.scopes } : {}),
        user,
        ...(me.credential_id ? { credential_id: me.credential_id } : {}),
        signed_in_at: now,
      };
      secrets = { org_key: key };
      if (from === "os" && !json) {
        ctx.stderr(
          `seshi: warning: stating the OS user name '${user}'; set it with --user or SESHI_USER`,
        );
      }
    } else if (config.oidc) {
      ({ profile, secrets } = await idpSignIn(ctx, account, server, config, values, style));
    } else {
      throw new Refused(
        EXIT.config,
        "no_way_in",
        `${server} takes neither an IdP sign-in nor the org key; ask its admin for a token: seshi login --token -`,
      );
    }

    const saved = await account.logins.save(profile, secrets);
    if (serverOf(account) !== server) writeCliKey(account.cliFile, "server", server, ctx.env);
    if (values.user !== undefined && values.user !== account.cli.user) {
      writeCliKey(account.cliFile, "user", values.user, ctx.env);
    }
    const warning = fallbackWarning(account);
    if (warning) ctx.stderr(`seshi: warning: ${warning}`);
    emit(
      ctx,
      json,
      {
        server: saved.server,
        mode: saved.mode,
        owner: saved.owner,
        role: saved.role,
        scopes: saved.scopes,
        ...(saved.user ? { user: saved.user } : {}),
        ...(saved.session ? { session_expires_at: saved.session.expires_at } : {}),
        ...(saved.device ? { device_token: saved.device } : {}),
        refresh: secrets.refresh !== undefined,
        stored_in: saved.stored_in,
      },
      () => {
        const lines = summary(saved, style);
        if (saved.mode === "oidc" && secrets.refresh === undefined) {
          lines.push(
            "The IdP gave no refresh token: sign in again when the session ends (1 hour).",
          );
        }
        return lines;
      },
    );
    return EXIT.ok;
  } catch (err) {
    return failWith(ctx, json, err);
  }
}
