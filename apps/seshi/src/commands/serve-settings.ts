/** What `seshi serve` needs from a loaded server config, checked: nothing is read or opened
 * here, so `seshi config check` runs the same checks without starting anything. */

import { type AuthSettings, AuthSettingsError, authSettings } from "@seshi/auth";
import { type FlagValue, parseListen, type ServerConfig } from "@seshi/config";

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

export interface ServeSettings {
  /** `[auth]`, checked, secrets revealed (X5). */
  auth: AuthSettings;
  /** The owners of static tokens: their folders are probed at boot. */
  owners: string[];
  url: string;
  store: {
    region?: string;
    endpoint?: string;
    accountId?: string;
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  };
  /** The deployment the bucket must belong to (`store.deployment_id`, X1.4). */
  deploymentId: string | undefined;
  /** The organization the bucket must belong to (`store.org`, X1.4). */
  org: string | undefined;
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
  let auth: AuthSettings;
  try {
    auth = authSettings(config);
  } catch (err) {
    if (err instanceof AuthSettingsError) fail(err.message);
    throw err;
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
    auth,
    owners: [...new Set(auth.staticTokens.map((t) => t.owner))],
    url: store.url,
    store: {
      ...(store.region ? { region: store.region } : {}),
      ...(store.endpoint ? { endpoint: store.endpoint } : {}),
      ...(store.account_id ? { accountId: store.account_id } : {}),
      ...(credentials ? { credentials } : {}),
    },
    deploymentId: store.deployment_id,
    org: store.org,
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
    const path = item.slice(0, at).trim();
    // Named with its path, so a message or an origin says which --set it was.
    flags.push({ name: `--set ${path}`, path, value: item.slice(at + 1) });
  }
  if (values.listen !== undefined) {
    flags.push({ name: "--listen", path: "server.listen", value: values.listen });
  }
  if (values.roles !== undefined) {
    flags.push({ name: "--roles", path: "server.roles", value: values.roles });
  }
  return flags;
}
