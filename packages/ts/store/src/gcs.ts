import type { Fetch } from "@seshi/model";
import {
  applicationDefaultToken,
  credentialsFileToken,
  type GcsTokenSource,
  parseCredentialsFile,
} from "./gcs-auth";
import { FetchGcsClient, GcsHttpError } from "./gcs-fetch";
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

/** A service account key given in config: the JSON key file's contents. Anything else comes
 * from `env` (Application Default Credentials). */
export interface GcsKey {
  serviceAccountKey: string;
}

export interface GcsAccessOptions {
  /** The JSON API's root; else `STORAGE_EMULATOR_HOST`, else `https://storage.googleapis.com`. */
  endpoint?: string;
  /** Omit for Application Default Credentials from `env`: `GOOGLE_APPLICATION_CREDENTIALS`,
   * then gcloud's application-default file, then the metadata server (GKE Workload Identity,
   * Compute Engine). With `STORAGE_EMULATOR_HOST` set and no key, requests carry none. */
  credentials?: GcsKey;
  fetch?: Fetch;
  /** Where the standard Google variables are read from; `process.env` by default. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface GcsAccess {
  endpoint?: string;
  token: GcsTokenSource;
}

export function parseGcsUrl(url: string): { bucket: string; prefix: string } {
  const match = /^gs:\/\/([^/]+)(?:\/(.*))?$/.exec(url);
  if (!match) throw new StoreError(`not a gs:// URL: ${url}`);
  const [, bucket, rawPrefix] = match;
  const prefix = (rawPrefix ?? "").replace(/^\/+|\/+$/g, "");
  return { bucket: bucket as string, prefix };
}

/** `STORAGE_EMULATOR_HOST` as Google's client libraries read it: a host:port, or a URL. */
function emulatorRoot(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

/** Which endpoint and credentials a `gs://` URL is reached with: what config gives, else
 * Application Default Credentials, as Google's client libraries find them. `label` names the
 * bucket in errors. */
export function resolveGcsAccess(label: string, options: GcsAccessOptions = {}): GcsAccess {
  const env = options.env ?? process.env;
  const emulator = emulatorRoot(env.STORAGE_EMULATOR_HOST);
  const endpoint = options.endpoint ?? emulator;
  const tokenOptions = options.fetch ? { fetch: options.fetch } : {};
  let token: GcsTokenSource;
  if (options.credentials) {
    token = credentialsFileToken(
      parseCredentialsFile(options.credentials.serviceAccountKey, `${label}'s service account key`),
      tokenOptions,
    );
  } else if (!emulator) {
    token = applicationDefaultToken(env, tokenOptions);
  }
  return { ...(endpoint ? { endpoint } : {}), token };
}

export interface GcsStoreOptions extends GcsAccessOptions {
  bucket: string;
  prefix?: string;
}

function denied(err: unknown): boolean {
  return err instanceof GcsHttpError && (err.status === 403 || err.status === 401);
}

function conditionFailed(err: unknown): boolean {
  return err instanceof GcsHttpError && err.status === 412;
}

/** A store in a Google Cloud Storage bucket (`gs://bucket/prefix`): every operation the S3
 * store has, with the same conditions, made on the object's generation, which this store gives
 * as its ETag. A generation is not an MD5 of the body, so `publish` verifies a write by reading
 * it back. */
export class GcsStore implements Store {
  readonly url: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly endpoint: string | undefined;
  private readonly client: FetchGcsClient;

  constructor(options: GcsStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.url = `gs://${this.bucket}${this.prefix ? `/${this.prefix}` : ""}`;
    const access = resolveGcsAccess(this.url, options);
    this.endpoint = access.endpoint;
    this.client = new FetchGcsClient({
      bucket: this.bucket,
      ...(access.endpoint ? { endpoint: access.endpoint } : {}),
      token: access.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  static fromUrl(url: string, options: Omit<GcsStoreOptions, "bucket" | "prefix"> = {}): GcsStore {
    return new GcsStore({ ...options, ...parseGcsUrl(url) });
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
          options.ifNoneMatch ? "an object already exists" : "the object changed or is gone",
        );
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
