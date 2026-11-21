import type { Fetch, StorageView } from "@seshi/model";
import { type AzureKey, AzureStore } from "./azure";
import { FsStore } from "./fs";
import { type GcsKey, GcsStore } from "./gcs";
import type { S3Credentials } from "./s3";
import { S3Store } from "./s3";
import { type Store, StoreError } from "./store";

export type { StorageView };

/** The URL schemes a store may have, as said in messages. */
export const STORE_SCHEMES = "s3://, r2://, az://, gs:// or file://";

/** Keys given in config: an S3 access key for `s3://` and `r2://`, an account key or SAS token
 * for `az://`, a service account key for `gs://`. */
export type StoreCredentials = S3Credentials | AzureKey | GcsKey;

export interface OpenStoreOptions {
  region?: string;
  accountId?: string;
  /** The Azure storage account (`az://`). */
  accountName?: string;
  endpoint?: string;
  credentials?: StoreCredentials;
  fetch?: Fetch;
  /** Where to read the per-scheme extras from when not given; `process.env` by default. */
  env?: Record<string, string | undefined>;
}

export function isStoreUrl(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("/") || /^(s3|r2|az|gs):\/\//.test(url);
}

function isS3Credentials(credentials: StoreCredentials): credentials is S3Credentials {
  return "accessKeyId" in credentials;
}

function isGcsKey(credentials: StoreCredentials): credentials is GcsKey {
  return "serviceAccountKey" in credentials;
}

export function openStore(
  url: string,
  options: OpenStoreOptions = {},
): { store: Store; storage: StorageView } {
  if (url.startsWith("file://") || url.startsWith("/")) {
    const store = new FsStore(url);
    return { store, storage: { url: store.url } };
  }
  const { credentials } = options;
  if (url.startsWith("gs://")) {
    if (credentials && !isGcsKey(credentials)) {
      throw new StoreError(`${url}: a gs:// store takes a service account key`);
    }
    const store = GcsStore.fromUrl(url, {
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(credentials ? { credentials } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    return { store, storage: { url, ...(store.endpoint ? { endpoint: store.endpoint } : {}) } };
  }
  if (url.startsWith("az://")) {
    if (credentials && (isS3Credentials(credentials) || isGcsKey(credentials))) {
      throw new StoreError(`${url}: an az:// store takes an account key or SAS token`);
    }
    const store = AzureStore.fromUrl(url, {
      ...(options.accountName ? { account: options.accountName } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(credentials ? { credentials } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    return {
      store,
      storage: {
        url,
        account_name: store.account,
        ...(store.endpoint ? { endpoint: store.endpoint } : {}),
      },
    };
  }
  if (/^(s3|r2):\/\//.test(url)) {
    if (credentials && !isS3Credentials(credentials)) {
      throw new StoreError(`${url}: takes an access key id and secret access key`);
    }
    const env = options.env ?? process.env;
    const region = options.region ?? env.AWS_REGION ?? env.S3_REGION;
    const accountId = options.accountId ?? env.R2_ACCOUNT_ID;
    const endpoint = options.endpoint ?? env.S3_ENDPOINT;
    if (url.startsWith("r2://") && !accountId && !endpoint) {
      throw new StoreError("r2:// needs an account id (R2_ACCOUNT_ID) or an endpoint");
    }
    const store = S3Store.fromUrl(url, {
      region,
      accountId,
      endpoint,
      credentials,
      fetch: options.fetch,
      env,
    });
    return {
      store,
      storage: {
        url,
        ...(region ? { region } : {}),
        ...(accountId ? { account_id: accountId } : {}),
        ...(endpoint ? { endpoint } : {}),
      },
    };
  }
  throw new StoreError(`a store URL is ${STORE_SCHEMES}, got ${url}`);
}
