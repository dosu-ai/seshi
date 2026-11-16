import type { Fetch, StorageView } from "@seshi/model";
import { FsStore } from "./fs";
import type { S3Credentials } from "./s3";
import { S3Store } from "./s3";
import { type Store, StoreError } from "./store";

export type { StorageView };

export interface OpenStoreOptions {
  region?: string;
  accountId?: string;
  endpoint?: string;
  credentials?: S3Credentials;
  fetch?: Fetch;
  /** Where to read the per-scheme extras from when not given; `process.env` by default. */
  env?: Record<string, string | undefined>;
}

export function isStoreUrl(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("/") || /^(s3|r2):\/\//.test(url);
}

export function openStore(
  url: string,
  options: OpenStoreOptions = {},
): { store: Store; storage: StorageView } {
  if (url.startsWith("file://") || url.startsWith("/")) {
    const store = new FsStore(url);
    return { store, storage: { url: store.url } };
  }
  if (/^(s3|r2):\/\//.test(url)) {
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
      credentials: options.credentials,
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
  throw new StoreError(`a store URL is s3://, r2:// or file://, got ${url}`);
}
