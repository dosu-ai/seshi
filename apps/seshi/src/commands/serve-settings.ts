/** What `seshi serve` needs from a loaded server config, checked: nothing is read or opened
 * here, so `seshi config check` runs the same checks without starting anything. */

import { MIN_SECRET_LENGTH } from "@seshi/auth";
import { type FlagValue, parseListen, type ServerConfig } from "@seshi/config";
import { assertOwner } from "@seshi/store";

/** A setting the server cannot start with: printed as `seshi: <message>`, exit 1. */
export class ServeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeConfigError";
  }
}

function fail(message: string): never {
  throw new ServeConfigError(message);
}

export const MIN_TOKEN_LENGTH = 16;

export interface ServeSettings {
  tokens: Array<{ token: string; owner: string }>;
  tokenSecret: string | undefined;
  owners: string[];
  url: string;
  store: {
    region?: string;
    endpoint?: string;
    accountId?: string;
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  };
  format: ServerConfig["store"]["format"];
  redactionPacks: string[];
  hostname: string;
  port: number;
  filter: ServerConfig["filter"];
  limits: ServerConfig["limits"];
}

/** The settings, or `ServeConfigError` for the first one the server cannot start with. The
 * config's secrets must be resolved. */
export function serveSettings(config: ServerConfig): ServeSettings {
  if (!config.server.roles.includes("api")) {
    fail(
      `server.roles is ${config.server.roles.join(", ")}: the worker role runs no jobs yet, so an instance needs api`,
    );
  }
  const tokens = Object.entries(config.auth.tokens).map(([owner, secret]) => {
    try {
      assertOwner(owner);
    } catch {
      fail(`auth.tokens: '${owner}' is not a valid owner name: letters, digits, . _ - (up to 128)`);
    }
    const token = secret.reveal().trim();
    if (token.length < MIN_TOKEN_LENGTH) {
      fail(
        `auth.tokens.${owner} must be ${MIN_TOKEN_LENGTH}+ characters (try: openssl rand -hex 24)`,
      );
    }
    return { token, owner };
  });
  if (new Set(tokens.map((t) => t.token)).size !== tokens.length) {
    fail("auth.tokens: the same token is given to two owners");
  }
  const tokenSecret = config.auth.legacy_token_secret?.reveal().trim() || undefined;
  if (tokens.length === 0 && tokenSecret === undefined) {
    fail(
      "no way to call the server: set auth.tokens (owner = token; SESHI_AUTH__TOKENS__<OWNER>) or auth.legacy_token_secret",
    );
  }
  if (tokenSecret !== undefined && tokenSecret.length < MIN_SECRET_LENGTH) {
    fail(
      `auth.legacy_token_secret must be ${MIN_SECRET_LENGTH}+ characters (try: openssl rand -hex 32)`,
    );
  }

  const listen = parseListen(config.server.listen);
  if (!listen) fail(`server.listen '${config.server.listen}' is not host:port, :port or port`);

  const { store } = config;
  const credentials = store.credentials
    ? {
        accessKeyId: store.credentials.access_key_id.reveal(),
        secretAccessKey: store.credentials.secret_access_key.reveal(),
        ...(store.credentials.session_token
          ? { sessionToken: store.credentials.session_token.reveal() }
          : {}),
      }
    : undefined;

  return {
    tokens,
    tokenSecret,
    owners: [...new Set(tokens.map((t) => t.owner))],
    url: store.url,
    store: {
      ...(store.region ? { region: store.region } : {}),
      ...(store.endpoint ? { endpoint: store.endpoint } : {}),
      ...(store.account_id ? { accountId: store.account_id } : {}),
      ...(credentials ? { credentials } : {}),
    },
    format: store.format,
    redactionPacks: config.redaction.packs,
    hostname: listen.hostname,
    port: listen.port,
    filter: config.filter,
    limits: config.limits,
  };
}

/** The server config flags shared by `serve` and `config`: `--listen`, `--roles` and
 * `--set path=value` (repeatable), as loader flag values. Throws `ServeConfigError` for a
 * `--set` without `=`. */
export function configFlags(values: {
  listen?: string;
  roles?: string;
  set?: string[];
}): FlagValue[] {
  const flags: FlagValue[] = [];
  for (const item of values.set ?? []) {
    const at = item.indexOf("=");
    if (at < 1) fail(`--set takes path=value, got '${item}'`);
    flags.push({ name: "--set", path: item.slice(0, at).trim(), value: item.slice(at + 1) });
  }
  if (values.listen !== undefined) {
    flags.push({ name: "--listen", path: "server.listen", value: values.listen });
  }
  if (values.roles !== undefined) {
    flags.push({ name: "--roles", path: "server.roles", value: values.roles });
  }
  return flags;
}
