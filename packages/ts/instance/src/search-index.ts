import { fileURLToPath } from "node:url";
import {
  type BucketCredentials,
  credentialsMismatch,
  type RevealedBucketCredentials,
  revealBucketCredentials,
  type ServerConfig,
} from "@seshi/config";
import { lanceBackend, type OpenIndex } from "@seshi/search";
import { resolveAzureAccess } from "@seshi/store";

/** Where the LanceDB index is and how it is reached: a URI LanceDB takes, with no credentials
 * in it, and its `storageOptions` (F10.9). */
export interface LanceLocation {
  uri: string;
  storageOptions: Record<string, string>;
}

/** What a bucket is reached with: `[store]`'s fields, or `[search.lance]`'s for its own uri. */
interface Access {
  region?: string;
  endpoint?: string;
  account_id?: string;
  account_name?: string;
  credentials?: BucketCredentials;
}

type Env = Readonly<Record<string, string | undefined>>;

const SEARCH_PREFIX = "search";

function under(url: string, ...parts: string[]): string {
  return [url.replace(/\/+$/, ""), ...parts].join("/");
}

function bucketOf(url: string): string {
  return url.replace(/^[a-z0-9]+:\/\//, "").split("/")[0] ?? "";
}

function schemeOf(url: string): string {
  return url.startsWith("/") ? "file" : (url.match(/^([a-z0-9]+):\/\//)?.[1] ?? "");
}

/** What `search.lance.uri` is reached with: `[search.lance]`'s own keys and endpoint, or, for
 * a uri in the store's bucket (another prefix) that names none, `[store]`'s. Without a uri,
 * `[store]`'s. */
function accessFor(config: ServerConfig): Access {
  const lance = config.search.lance;
  const store = config.store.url;
  if (lance.uri === undefined) return config.store;
  const own: Access = {
    ...(lance.region ? { region: lance.region } : {}),
    ...(lance.endpoint ? { endpoint: lance.endpoint } : {}),
    ...(lance.account_id ? { account_id: lance.account_id } : {}),
    ...(lance.account_name ? { account_name: lance.account_name } : {}),
    ...(lance.credentials ? { credentials: lance.credentials } : {}),
  };
  const sameBucket =
    schemeOf(lance.uri) === schemeOf(store) &&
    schemeOf(store) !== "file" &&
    bucketOf(lance.uri) === bucketOf(store);
  return Object.keys(own).length === 0 && sameBucket ? config.store : own;
}

/** The index's location for `config` (F10.9): `search/<deployment>` in the store's bucket with
 * `[store]`'s keys, or `search.lance.uri` (see `accessFor`). */
export function lanceLocation(config: ServerConfig, deployment: string, env: Env): LanceLocation {
  const url = config.search.lance.uri ?? under(config.store.url, SEARCH_PREFIX, deployment);
  return lanceUri(url, accessFor(config), env);
}

/** `search.lance.uri`'s keys and endpoint as `openStore` takes them (`seshi doctor`'s write
 * probe). */
export function revealedAccess(config: ServerConfig): {
  region?: string;
  endpoint?: string;
  accountId?: string;
  accountName?: string;
  credentials?: RevealedBucketCredentials;
} {
  const access = accessFor(config);
  return {
    ...(access.region ? { region: access.region } : {}),
    ...(access.endpoint ? { endpoint: access.endpoint } : {}),
    ...(access.account_id ? { accountId: access.account_id } : {}),
    ...(access.account_name ? { accountName: access.account_name } : {}),
    ...(access.credentials ? { credentials: revealBucketCredentials(access.credentials) } : {}),
  };
}

/** A store URL as LanceDB takes it, and the `storageOptions` that reach it, from `access` and
 * the same environment variables the store reads (`[store]`'s documented fallbacks). */
export function lanceUri(url: string, access: Access, env: Env): LanceLocation {
  const keys: RevealedBucketCredentials | undefined = access.credentials
    ? revealBucketCredentials(access.credentials)
    : undefined;
  const options: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") options[name] = value;
  };
  const scheme = schemeOf(url);
  if (scheme === "file") {
    return {
      uri: url.startsWith("/") ? url : fileURLToPath(url.replace(/^file:\/\/(?!\/)/, "file:///")),
      storageOptions: {},
    };
  }
  if (scheme === "s3" || scheme === "r2") {
    const r2 = scheme === "r2";
    const s3Keys = keys && "accessKeyId" in keys ? keys : undefined;
    const fromR2Env =
      r2 && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
        ? { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
        : undefined;
    const given = s3Keys ?? fromR2Env;
    set("aws_access_key_id", given?.accessKeyId ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID);
    set(
      "aws_secret_access_key",
      given?.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
    );
    set(
      "aws_session_token",
      s3Keys ? s3Keys.sessionToken : (env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN),
    );
    const accountId = access.account_id ?? (r2 ? env.R2_ACCOUNT_ID : undefined);
    const endpoint =
      access.endpoint ??
      (r2 && accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : (env.S3_ENDPOINT ?? env.AWS_ENDPOINT));
    set("aws_endpoint", endpoint);
    set(
      "aws_region",
      access.region ?? (r2 ? "auto" : (env.S3_REGION ?? env.AWS_REGION ?? "us-east-1")),
    );
    if (endpoint?.startsWith("http://")) set("allow_http", "true");
    return { uri: `s3://${url.slice(url.indexOf("://") + 3)}`, storageOptions: options };
  }
  if (scheme === "az") {
    // The account, endpoint and key exactly as the store finds them: config, then
    // AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY, AZURE_STORAGE_SAS_TOKEN and the connection
    // string, then workload identity.
    const azure = resolveAzureAccess(url, {
      ...(access.account_name ? { account: access.account_name } : {}),
      ...(access.endpoint ? { endpoint: access.endpoint } : {}),
      ...(keys && ("accountKey" in keys || "sasToken" in keys) ? { credentials: keys } : {}),
      env: { ...env },
    });
    set("azure_storage_account_name", azure.account);
    const credentials = azure.credentials;
    if ("accountKey" in credentials) set("azure_storage_account_key", credentials.accountKey);
    else if ("sasToken" in credentials) {
      set("azure_storage_sas_token", credentials.sasToken.replace(/^\?/, ""));
    } else {
      // Workload identity: LanceDB's client exchanges the same federated token itself.
      set("azure_federated_token_file", env.AZURE_FEDERATED_TOKEN_FILE);
      set("azure_client_id", env.AZURE_CLIENT_ID);
      set("azure_tenant_id", env.AZURE_TENANT_ID);
    }
    if (azure.endpoint) {
      set("azure_storage_endpoint", azure.endpoint);
      if (azure.endpoint.startsWith("http://")) set("allow_http", "true");
    }
    return { uri: url, storageOptions: options };
  }
  if (scheme === "gs") {
    // LanceDB's GCS client takes no endpoint option, and cannot write to fake-gcs-server
    // (checked on 25 November 2026, 1.49 to 1.56): an index beside an emulated or other GCS
    // endpoint would go to Google's instead. Refuse rather than write somewhere else.
    const endpoint = access.endpoint ?? env.STORAGE_EMULATOR_HOST;
    if (endpoint !== undefined && endpoint !== "" && !/storage\.googleapis\.com/.test(endpoint)) {
      throw new Error(
        `search.backend = "lance" cannot reach ${url} through ${endpoint}: LanceDB talks to Google Cloud Storage only, not an emulator or another endpoint; set search.lance.uri to a folder or another bucket`,
      );
    }
    // Without a key, LanceDB's client finds Application Default Credentials itself
    // (GOOGLE_APPLICATION_CREDENTIALS, or the metadata server), as the store does.
    if (keys && "serviceAccountKey" in keys) {
      set("google_service_account_key", keys.serviceAccountKey);
    }
    return { uri: url, storageOptions: options };
  }
  throw new Error(`search.lance: ${url} is not a store URL LanceDB takes`);
}

export interface SearchOpenOptions {
  deployment: string;
  env: Env;
  /** An API instance, or a CLI that only reads: never writes the index (F10.8). */
  readOnly: boolean;
}

/** Thrown when `[search] backend = "lance"` meets a binary built without LanceDB. */
export class LanceMissing extends Error {
  constructor() {
    super(
      'search.backend = "lance" needs the server build of seshi, which carries LanceDB: the container image (ghcr.io/dosu-ai/seshi), or the seshi-server-linux-* release archives. This binary has SQLite only.',
    );
    this.name = "LanceMissing";
  }
}

/** The index opener for `config`'s backend: undefined for SQLite (SearchService's own), the
 * LanceDB opener otherwise. */
export function searchOpener(
  config: ServerConfig,
  options: SearchOpenOptions,
): OpenIndex | undefined {
  if (config.search.backend !== "lance") return undefined;
  const open = lanceBackend();
  if (open === undefined) throw new LanceMissing();
  const where = lanceLocation(config, options.deployment, options.env);
  const lance = config.search.lance;
  return open({
    uri: where.uri,
    ...(Object.keys(where.storageOptions).length > 0
      ? { storageOptions: where.storageOptions }
      : {}),
    readConsistency: lance.read_consistency / 1000,
    optimizeEvery: lance.optimize,
    scrubEvery: lance.scrub,
    maxScoredRows: lance.max_scored_rows,
    maxRecentRows: lance.max_recent_rows,
    readOnly: options.readOnly,
  });
}

/** The environment variable a `sql` worker reads its storage options from: Lance's
 * `storage_options` as JSON, which it gives DuckDB's `lance` extension as a secret. */
export const SQL_STORAGE_ENV = "SESHI_SQL_STORAGE";
/** Where DuckDB's extensions are (`<dir>/<version>/<platform>/lance.duckdb_extension`), when not
 * beside the binary: `[search.sql] extensions`. */
export const DUCKDB_EXTENSIONS_ENV = "SESHI_DUCKDB_EXTENSIONS";

/** The `sql` workers' environment on a LanceDB index (docs/seshi/session-tools.md, "The lance
 * extension and the worker's credential"): the storage options of `[search.sql.storage]`, the
 * read-only credential, or without one the index's own (`ownCredential`, which the server
 * warns of for a bucket); and where DuckDB's extensions are (`[search.sql] extensions`). Undefined for
 * SQLite, whose workers hold nothing. The variables are the worker's own: never set in the
 * server's environment, where `SESHI_*` names settings. */
export function sqlWorkerEnv(
  config: ServerConfig,
  deployment: string,
  env: Env,
): { env: Record<string, string>; ownCredential: boolean } | undefined {
  if (config.search.backend !== "lance") return undefined;
  const storage = config.search.sql.storage;
  const url = config.search.lance.uri ?? under(config.store.url, SEARCH_PREFIX, deployment);
  const mismatch = credentialsMismatch(url, storage);
  if (mismatch) throw new Error(`search.sql.storage: ${mismatch}`);
  const where = storage
    ? // Only the read-only keys: none of the server's own, from config or its environment.
      lanceUri(url, { ...accessFor(config), credentials: storage }, withoutKeys(env))
    : lanceLocation(config, deployment, env);
  const folder = schemeOf(url) === "file";
  // A folder index needs no secret; a bucket gets one even without keys (the machine's own).
  const out: Record<string, string> = folder
    ? {}
    : { [SQL_STORAGE_ENV]: JSON.stringify(where.storageOptions) };
  // Application Default Credentials from a key file: the index's own credential on GCS.
  if (!storage && schemeOf(url) === "gs" && env.GOOGLE_APPLICATION_CREDENTIALS) {
    out.GOOGLE_APPLICATION_CREDENTIALS = env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  const extensions = config.search.sql.extensions;
  if (extensions) out[DUCKDB_EXTENSIONS_ENV] = extensions;
  // A folder index has no credential to narrow; a bucket's own credential can write.
  return { env: out, ownCredential: storage === undefined && !folder };
}

/** `env` without the keys the store and LanceDB read from it, so a read-only credential is not
 * topped up with the server's own (a session token beside another key, say). Endpoints and
 * regions stay. */
function withoutKeys(env: Env): Env {
  const keys =
    /^(AWS|S3|R2)_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$|^AZURE_STORAGE_(KEY|SAS_TOKEN|CONNECTION_STRING)$|^AZURE_(FEDERATED_TOKEN_FILE|CLIENT_ID|TENANT_ID|CLIENT_SECRET)$|^GOOGLE_(APPLICATION_CREDENTIALS|SERVICE_ACCOUNT.*)$/;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !keys.test(name)));
}
