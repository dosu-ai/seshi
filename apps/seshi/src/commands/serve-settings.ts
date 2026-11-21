import { type AuthSettings, AuthSettingsError, authSettings } from "@seshi/auth";
import {
  type FlagValue,
  parseListen,
  type RevealedBucketCredentials,
  revealBucketCredentials,
  type ServerConfig,
} from "@seshi/config";
import { ServeConfigError } from "../cli/failures";

function fail(message: string): never {
  throw new ServeConfigError(message);
}

export interface ServeSettings {
  auth: AuthSettings;
  owners: string[];
  url: string;
  store: {
    region?: string;
    endpoint?: string;
    accountId?: string;
    accountName?: string;
    credentials?: RevealedBucketCredentials;
  };
  deploymentId: string | undefined;
  org: string | undefined;
  redactionPacks: string[];
  hostname: string;
  port: number;
  roles: ServerConfig["server"]["roles"];
  filter: ServerConfig["filter"];
  limits: ServerConfig["limits"];
}

export function serveSettings(config: ServerConfig): ServeSettings {
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
  const credentials = store.credentials ? revealBucketCredentials(store.credentials) : undefined;

  return {
    auth,
    owners: [...new Set(auth.staticTokens.map((t) => t.owner))],
    url: store.url,
    store: {
      ...(store.region ? { region: store.region } : {}),
      ...(store.endpoint ? { endpoint: store.endpoint } : {}),
      ...(store.account_id ? { accountId: store.account_id } : {}),
      ...(store.account_name ? { accountName: store.account_name } : {}),
      ...(credentials ? { credentials } : {}),
    },
    deploymentId: store.deployment_id,
    org: store.org,
    redactionPacks: config.redaction.packs,
    hostname: listen.hostname,
    port: listen.port,
    roles: config.server.roles,
    filter: config.filter,
    limits: config.limits,
  };
}

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
