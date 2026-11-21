import type { Fetch } from "@seshi/model";
import { FetchS3Client, S3HttpError } from "./s3-fetch";
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

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3StoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  accountId?: string;
  /** Explicit endpoint for S3-compatible stores; overrides `region` / `accountId` resolution. */
  endpoint?: string;
  /** Omit to read the standard variables from `env`: `S3_*` / `AWS_*`, and for `r2://`
   * `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` first. */
  credentials?: S3Credentials;
  scheme?: "s3" | "r2";
  fetch?: Fetch;
  /** Where the standard S3 variables are read from when not given; `process.env` by default. */
  env?: Record<string, string | undefined>;
}

export function parseS3Url(url: string): { scheme: "s3" | "r2"; bucket: string; prefix: string } {
  const match = /^(s3|r2):\/\/([^/]+)(?:\/(.*))?$/.exec(url);
  if (!match) throw new StoreError(`not an s3:// or r2:// URL: ${url}`);
  const [, scheme, bucket, rawPrefix] = match;
  const prefix = (rawPrefix ?? "").replace(/^\/+|\/+$/g, "");
  return { scheme: scheme as "s3" | "r2", bucket: bucket as string, prefix };
}

function denied(err: unknown): boolean {
  return err instanceof S3HttpError && err.status === 403;
}

function conditionFailed(err: unknown): boolean {
  return (
    err instanceof S3HttpError &&
    (err.status === 412 || (err.status === 409 && err.code === "ConditionalRequestConflict"))
  );
}

export class S3Store implements Store {
  readonly url: string;
  readonly bucket: string;
  readonly prefix: string;
  private readonly client: FetchS3Client;

  constructor(options: S3StoreOptions) {
    const scheme = options.scheme ?? (options.accountId ? "r2" : "s3");
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.url = `${scheme}://${this.bucket}${this.prefix ? `/${this.prefix}` : ""}`;

    const env = options.env ?? process.env;
    const fromEnv =
      scheme === "r2" && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
        ? { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
        : {};
    const credentials: Partial<S3Credentials> = options.credentials ?? fromEnv;
    const accessKeyId = credentials.accessKeyId ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      credentials.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
    const sessionToken =
      credentials.sessionToken ??
      (options.credentials ? undefined : (env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN));
    if (!accessKeyId || !secretAccessKey) {
      throw new StoreError(
        `${this.url} needs an access key id and secret (credentials, or ${
          scheme === "r2" ? "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY" : "AWS_* / S3_*"
        } in the environment)`,
      );
    }
    const endpoint =
      options.endpoint ??
      (scheme === "r2" && options.accountId
        ? `https://${options.accountId}.r2.cloudflarestorage.com`
        : (env.S3_ENDPOINT ?? env.AWS_ENDPOINT));
    this.client = new FetchS3Client({
      bucket: this.bucket,
      // R2 signs with region `auto`.
      region:
        options.region ??
        (scheme === "r2" ? "auto" : (env.S3_REGION ?? env.AWS_REGION ?? "us-east-1")),
      endpoint,
      credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
      fetch: options.fetch,
    });
  }

  static fromUrl(
    url: string,
    options: Omit<S3StoreOptions, "bucket" | "prefix" | "scheme"> = {},
  ): S3Store {
    const { scheme, bucket, prefix } = parseS3Url(url);
    return new S3Store({ ...options, scheme, bucket, prefix });
  }

  private keyOf(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  /** S3 answers a read of an object that is not there with 403, not 404, when the key's
   * `s3:ListBucket` does not cover the read: no grant at all, or one limited by an `s3:prefix`
   * condition, which a GET or HEAD does not carry (F11). A listing of exactly that key does
   * carry it: when the listing is allowed and finds nothing, the object is missing; otherwise
   * the 403 stands. */
  private async missing(key: string): Promise<boolean> {
    const full = this.keyOf(key);
    try {
      const listed = await this.client.list({ prefix: full, maxKeys: 1 });
      return !listed.keys.includes(full);
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      return await this.client.get(this.keyOf(key));
    } catch (err) {
      if (denied(err)) {
        if (await this.missing(key)) return null;
        throw new AccessDenied("read", key, err);
      }
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
      // S3 answers If-Match on a key with no object with 404 NoSuchKey (R2 with 412): either
      // way the version read is gone, which is a failed condition, as the folder store says.
      if (options.ifMatch !== undefined && err instanceof S3HttpError && err.status === 404) {
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
      if (denied(err)) {
        if (await this.missing(key)) return null;
        throw new AccessDenied("stat", key, err);
      }
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
    if (options.details) return this.listDetailed(prefix, options);
    try {
      const response = await this.client.list({
        prefix: this.keyOf(prefix),
        maxKeys: options.limit ?? 1000,
        startAfter: options.startAfter === undefined ? undefined : this.keyOf(options.startAfter),
      });
      const strip = this.prefix ? this.prefix.length + 1 : 0;
      return { keys: response.keys.map((k) => k.slice(strip)), truncated: response.truncated };
    } catch (err) {
      if (denied(err)) throw new AccessDenied("list", prefix, err);
      throw storeFailure(`list ${prefix}`, err);
    }
  }

  private async listDetailed(prefix: string, options: ListOptions): Promise<ListResult> {
    try {
      const response = await this.client.listObjects({
        prefix: this.keyOf(prefix),
        maxKeys: options.limit ?? 1000,
        startAfter: options.startAfter === undefined ? undefined : this.keyOf(options.startAfter),
      });
      const strip = this.prefix ? this.prefix.length + 1 : 0;
      const objects = response.objects.map((o): ListedKey => {
        const at = o.last_modified === undefined ? Number.NaN : Date.parse(o.last_modified);
        return {
          key: o.key.slice(strip),
          size: o.size,
          ...(o.etag ? { etag: o.etag } : {}),
          ...(Number.isFinite(at) ? { modified: new Date(at).toISOString() } : {}),
        };
      });
      return { keys: objects.map((o) => o.key), truncated: response.truncated, objects };
    } catch (err) {
      if (denied(err)) throw new AccessDenied("list", prefix, err);
      throw storeFailure(`list ${prefix}`, err);
    }
  }
}
