import type { Fetch } from "@seshi/model";
import { type AzureCredentials, AzureHttpError, FetchAzureBlobClient } from "./azure-fetch";
import { workloadIdentityFromEnv } from "./azure-identity";
import {
  AccessDenied,
  type DeleteOptions,
  type ListedKey,
  type ListOptions,
  type ListResult,
  type ObjectStat,
  PreconditionFailed,
  type PutOptions,
  type PutResult,
  type Store,
  type StoredObject,
  StoreError,
  storeFailure,
} from "./store";

/** A storage account key or SAS token given in config; anything else comes from `env`. */
export type AzureKey = { accountKey: string } | { sasToken: string };

export interface AzureAccessOptions {
  /** The storage account; else `AZURE_STORAGE_ACCOUNT`, else the connection string's. */
  account?: string;
  /** The blob endpoint (Azurite: `http://127.0.0.1:10000/devstoreaccount1`); else the
   * connection string's, else `https://<account>.blob.core.windows.net`. */
  endpoint?: string;
  /** Omit to read the standard variables from `env`: `AZURE_STORAGE_KEY`,
   * `AZURE_STORAGE_SAS_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`, and last workload identity
   * (`AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`). */
  credentials?: AzureKey;
  fetch?: Fetch;
  /** Where the standard Azure variables are read from; `process.env` by default. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface AzureAccess {
  account: string;
  endpoint?: string;
  credentials: AzureCredentials;
}

export function parseAzureUrl(url: string): { container: string; prefix: string } {
  const match = /^az:\/\/([^/]+)(?:\/(.*))?$/.exec(url);
  if (!match) throw new StoreError(`not an az:// URL: ${url}`);
  const [, container, rawPrefix] = match;
  const prefix = (rawPrefix ?? "").replace(/^\/+|\/+$/g, "");
  return { container: container as string, prefix };
}

/** Azurite's account, its well-known key (published by Microsoft, in every Azure SDK) and its
 * default blob endpoint: what `UseDevelopmentStorage=true` stands for. */
const DEVELOPMENT_STORAGE = {
  AccountName: "devstoreaccount1",
  AccountKey:
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  BlobEndpoint: "http://127.0.0.1:10000/devstoreaccount1",
};

/** The parts of an Azure Storage connection string (`AccountName=…;AccountKey=…;…`), with
 * `UseDevelopmentStorage=true` spelled out. */
function connectionString(value: string | undefined): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of (value ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) parts[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return parts.UseDevelopmentStorage?.toLowerCase() === "true"
    ? { ...DEVELOPMENT_STORAGE, ...parts }
    : parts;
}

/** `AZURE_STORAGE_CONNECTION_STRING`'s parts when it is for `account` (or `account` is not
 * known yet); nothing when it names another account, whose key and endpoint are not this one's. */
function connectionFor(
  env: Readonly<Record<string, string | undefined>>,
  account: string | undefined,
): Record<string, string> {
  const conn = connectionString(env.AZURE_STORAGE_CONNECTION_STRING);
  return account && conn.AccountName && conn.AccountName !== account ? {} : conn;
}

/** The account key or SAS token in the environment: `AZURE_STORAGE_KEY`, then
 * `AZURE_STORAGE_SAS_TOKEN`, then the connection string's (when it is for `account`). */
export function azureKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  account?: string,
): AzureKey | undefined {
  const conn = connectionFor(env, account);
  const accountKey = env.AZURE_STORAGE_KEY ?? conn.AccountKey;
  if (accountKey) return { accountKey };
  const sasToken = env.AZURE_STORAGE_SAS_TOKEN ?? conn.SharedAccessSignature;
  return sasToken ? { sasToken } : undefined;
}

/** Which account, endpoint and credentials an `az://` URL is reached with: what config gives,
 * else the standard Azure variables, as the Azure SDKs and CLI read them. `label` names the
 * bucket in errors. */
export function resolveAzureAccess(label: string, options: AzureAccessOptions = {}): AzureAccess {
  const env = options.env ?? process.env;
  const account =
    options.account ??
    env.AZURE_STORAGE_ACCOUNT ??
    connectionString(env.AZURE_STORAGE_CONNECTION_STRING).AccountName;
  if (!account) {
    throw new StoreError(
      `${label} needs a storage account name ([store] account_name, or AZURE_STORAGE_ACCOUNT in the environment)`,
    );
  }
  const conn = connectionFor(env, account);
  const suffix = conn.EndpointSuffix;
  const endpoint =
    options.endpoint ??
    conn.BlobEndpoint ??
    (suffix
      ? `${conn.DefaultEndpointsProtocol ?? "https"}://${account}.blob.${suffix}`
      : undefined);
  const credentials: AzureCredentials | undefined =
    options.credentials ??
    azureKeyFromEnv(env, account) ??
    (() => {
      const token = workloadIdentityFromEnv(env, options.fetch ? { fetch: options.fetch } : {});
      return token ? { token } : undefined;
    })();
  if (!credentials) {
    throw new StoreError(
      `${label} needs credentials: an account key or SAS token (credentials, or AZURE_STORAGE_KEY / AZURE_STORAGE_SAS_TOKEN / AZURE_STORAGE_CONNECTION_STRING in the environment), or workload identity (AZURE_FEDERATED_TOKEN_FILE, AZURE_CLIENT_ID, AZURE_TENANT_ID)`,
    );
  }
  return { account, ...(endpoint ? { endpoint } : {}), credentials };
}

export interface AzureStoreOptions extends AzureAccessOptions {
  container: string;
  prefix?: string;
}

function denied(err: unknown): boolean {
  return err instanceof AzureHttpError && err.status === 403;
}

/** 412 `ConditionNotMet`, or 409 `BlobAlreadyExists` for `If-None-Match: *` over a blob. */
function conditionFailed(err: unknown): boolean {
  return (
    err instanceof AzureHttpError &&
    (err.status === 412 || (err.status === 409 && err.code === "BlobAlreadyExists"))
  );
}

/** A store in an Azure Blob Storage container (`az://container/prefix`): every operation the S3
 * store has, with the same conditions. Azure's ETags are not an MD5 of the body, so `publish`
 * verifies a write by reading it back. */
export class AzureStore implements Store {
  readonly url: string;
  readonly container: string;
  readonly prefix: string;
  readonly account: string;
  readonly endpoint: string | undefined;
  private readonly client: FetchAzureBlobClient;

  constructor(options: AzureStoreOptions) {
    this.container = options.container;
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.url = `az://${this.container}${this.prefix ? `/${this.prefix}` : ""}`;
    const access = resolveAzureAccess(this.url, options);
    this.account = access.account;
    this.endpoint = access.endpoint;
    this.client = new FetchAzureBlobClient({
      account: access.account,
      container: this.container,
      ...(access.endpoint ? { endpoint: access.endpoint } : {}),
      credentials: access.credentials,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  static fromUrl(
    url: string,
    options: Omit<AzureStoreOptions, "container" | "prefix"> = {},
  ): AzureStore {
    return new AzureStore({ ...options, ...parseAzureUrl(url) });
  }

  private keyOf(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      return await this.client.get(this.keyOf(key));
    } catch (err) {
      if (denied(err)) throw new AccessDenied("read", key, err);
      throw storeFailure(`read ${key}`, err);
    }
  }

  async put(key: string, body: Uint8Array, options: PutOptions = {}): Promise<PutResult> {
    try {
      return await this.client.put(
        this.keyOf(key),
        body,
        options.contentType ?? "application/octet-stream",
        { ifMatch: options.ifMatch, ifNoneMatch: options.ifNoneMatch },
      );
    } catch (err) {
      if (conditionFailed(err)) {
        throw new PreconditionFailed(
          key,
          options.ifNoneMatch ? "an object already exists" : "the object changed since it was read",
        );
      }
      if (options.ifMatch !== undefined && err instanceof AzureHttpError && err.status === 404) {
        throw new PreconditionFailed(key, "no object to replace");
      }
      if (denied(err)) throw new AccessDenied("write", key, err);
      throw storeFailure(`write ${key}`, err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      return await this.client.head(this.keyOf(key));
    } catch (err) {
      if (denied(err)) throw new AccessDenied("stat", key, err);
      throw storeFailure(`stat ${key}`, err);
    }
  }

  async delete(key: string, options: DeleteOptions = {}): Promise<void> {
    try {
      await this.client.delete(this.keyOf(key), { ifMatch: options.ifMatch });
    } catch (err) {
      if (conditionFailed(err)) {
        throw new PreconditionFailed(key, "the object changed since it was read");
      }
      if (denied(err)) throw new AccessDenied("delete", key, err);
      throw storeFailure(`delete ${key}`, err);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    try {
      const response = await this.client.listObjects({
        prefix: this.keyOf(prefix),
        maxKeys: options.limit ?? 1000,
        ...(options.startAfter === undefined ? {} : { startAfter: this.keyOf(options.startAfter) }),
      });
      const strip = this.prefix ? this.prefix.length + 1 : 0;
      const objects = response.objects.map(
        (o): ListedKey => ({
          key: o.key.slice(strip),
          size: o.size,
          ...(o.etag ? { etag: o.etag } : {}),
          ...(o.last_modified ? { modified: o.last_modified } : {}),
        }),
      );
      const keys = objects.map((o) => o.key);
      return options.details
        ? { keys, truncated: response.truncated, objects }
        : { keys, truncated: response.truncated };
    } catch (err) {
      if (denied(err)) throw new AccessDenied("list", prefix, err);
      throw storeFailure(`list ${prefix}`, err);
    }
  }
}
