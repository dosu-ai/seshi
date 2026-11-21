import { hostname } from "node:os";
import { parseArgs } from "node:util";
import {
  type AuthConfig,
  authConfig,
  exchangeIdToken,
  HttpSeshi,
  ServerError,
} from "@seshi/client";
import type { Identity } from "@seshi/model";
import { type Account, fallbackWarning, openAccount, serverOf } from "../account/account";
import { writeCliKeyIfValid } from "../account/cli-file";
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
import { emit, helpOrUsageError, takeJson } from "../cli/output";
import { printable, type Style, styleFor } from "../cli/style";
import { isServerless } from "../serverless/settings";
import { USER_AGENT } from "../user-agent";
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

async function secretArg(ctx: CommandContext, value: string, what: string): Promise<string> {
  if (value !== "-") return value.trim();
  if (!ctx.stdin)
    throw new Refused(EXIT.usage, "usage", `no standard input to read the ${what} from`);
  const read = (await ctx.stdin()).trim();
  if (!read) throw new Refused(EXIT.usage, "usage", `standard input held no ${what}`);
  return read;
}

async function identify(server: string, token: string, user?: string): Promise<Identity> {
  try {
    return await new HttpSeshi({
      server,
      token,
      userAgent: USER_AGENT,
      ...(user ? { user } : {}),
    }).me();
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      throw new Refused(EXIT.auth, "unauthorized", `${server} does not accept that credential`);
    }
    throw err;
  }
}

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
        ctx.stderr(`  ${style.link(printable(url))}`);
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
          `To sign in, open ${style.link(printable(code.verification_uri))} and enter the code ${style.bold(printable(code.user_code))}`,
        );
        if (code.verification_uri_complete) {
          ctx.stderr(`  or open ${style.link(printable(code.verification_uri_complete))}`);
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
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  const given = [values.key, values.token].filter((v) => v !== undefined).length;
  if (given > 1) return helpOrUsageError(ctx, json, "give --key or --token, not both", USAGE);
  if (values.browser && values.device) {
    return helpOrUsageError(ctx, json, "give --browser or --device, not both", USAGE);
  }
  if (
    values.visibility !== undefined &&
    values.visibility !== "org" &&
    values.visibility !== "owner"
  ) {
    return helpOrUsageError(ctx, json, "--visibility must be org or owner", USAGE);
  }
  if (values.user !== undefined && !sendableUser(values.user)) {
    return helpOrUsageError(ctx, json, "--user must be printable ASCII", USAGE);
  }
  try {
    const account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    if (isServerless(account.cli)) {
      throw new Refused(
        EXIT.config,
        "serverless_mode",
        `the CLI config (${account.cliFile}) uses serverless mode ([${account.cli.serverless ? "serverless" : "local"}]): sessions go straight to the bucket and need no sign-in. Remove it to use a server.`,
      );
    }
    const server = serverOf(account, values.server);
    if (server === undefined) {
      return helpOrUsageError(ctx, json, "which server? seshi login --server <url>", USAGE);
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

    const viaIdp = values.token === undefined && values.key === undefined && !!config.oidc;
    if (values.visibility !== undefined && !viaIdp) {
      throw new Refused(
        EXIT.usage,
        "usage",
        "--visibility sets the default of the device token an IdP sign-in gets; with the org key, set visibility per repository (.seshi/config.toml) or ask an admin for a token that has it",
      );
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
        ...(me.expires_at ? { token_expires_at: me.expires_at } : {}),
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
        return helpOrUsageError(
          ctx,
          json,
          `${server} signs in with the org key: seshi login --key - (reads it from standard input)`,
          USAGE,
        );
      }
      const { user, from } =
        values.user !== undefined
          ? { user: values.user, from: "flag" }
          : await resolveUser({
              env: ctx.env,
              ...(account.user ? { configured: account.user } : {}),
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
    if (serverOf(account) !== server)
      writeCliKeyIfValid(account.cliFile, "server", server, ctx.env);
    if (values.user !== undefined && values.user !== account.cli.user) {
      writeCliKeyIfValid(account.cliFile, "user", values.user, ctx.env);
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
