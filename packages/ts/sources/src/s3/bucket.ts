import { open, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fetch } from "@seshi/model";
import {
  type AssumedCredentials,
  type AwsCredentialSource,
  type AzureKey,
  assumeRole,
  BucketHttpError,
  FetchAzureBlobClient,
  type FetchedObject,
  FetchGcsClient,
  FetchS3Client,
  type GcsKey,
  isAwsEndpoint,
  type ListedObject,
  parseAzureUrl,
  parseGcsUrl,
  parseS3Url,
  resolveAzureAccess,
  resolveGcsAccess,
  roleCredentials,
} from "@seshi/store";

export type SourceObject = ListedObject;

/** A page of the listing, in key order. */
export interface SourceListing {
  objects: SourceObject[];
  truncated: boolean;
}

export type SourceRead = FetchedObject;

/** The bucket refuses to let the source read this object: 403, or another final 4xx for this
 * one object (an archived object's `InvalidObjectState`, an SSE-C object's 400). */
export class ObjectDenied extends Error {
  constructor(
    readonly key: string,
    readonly status = 403,
    /** S3's error code, when the answer had one. */
    readonly code?: string,
  ) {
    super(
      `${key}: ${status === 403 ? "access denied" : `refused (${status}${code ? ` ${code}` : ""})`}`,
    );
    this.name = "ObjectDenied";
  }
}

/** The object is no longer the version the run listed: read it on the next run. */
export class ObjectChanged extends Error {
  constructor(readonly key: string) {
    super(`${key} changed since it was listed`);
    this.name = "ObjectChanged";
  }
}

export interface SourceBucket {
  readonly url: string;
  /** Where `key` sits, for provenance: `s3://bucket/key`, `r2://bucket/key`,
   * `az://container/key`, `gs://bucket/key`, `file:///path`. */
  locate(key: string): string;
  list(prefix: string, options: { startAfter?: string; limit: number }): Promise<SourceListing>;
  /** The object at `key` from byte `start` (0 by default), only while its ETag is `etag`:
   * `ObjectChanged` otherwise, null when it is gone. */
  read(key: string, options: { etag: string; start?: number }): Promise<SourceRead | null>;
}

export interface SourceCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3SourceOptions {
  url: string;
  region?: string;
  endpoint?: string;
  accountId?: string;
  /** Static keys; else the standard variables in `env` (`AWS_*`, `S3_*`; `R2_*` for r2://);
   * else, for s3:// on AWS's own endpoints, the role seshi runs as (an ECS task's, or the EC2
   * instance's). */
  credentials?: SourceCredentials;
  role?: { arn: string; externalId?: string; sessionName: string };
  roleCache?: Map<string, AssumedCredentials>;
  fetch: Fetch;
  env: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  stsEndpoint?: string;
}

const RENEW_BEFORE_MS = 5 * 60 * 1000;

export class S3SourceBucket implements SourceBucket {
  readonly url: string;
  private readonly scheme: "s3" | "r2";
  private readonly bucket: string;
  private client: FetchS3Client | undefined;
  /** The role's credentials, kept so they are renewed rather than fetched on every connect. */
  private role: AwsCredentialSource | undefined;

  constructor(private readonly options: S3SourceOptions) {
    const { scheme, bucket } = parseS3Url(options.url);
    this.url = options.url;
    this.scheme = scheme;
    this.bucket = bucket;
  }

  locate(key: string): string {
    return `${this.scheme}://${this.bucket}/${key}`;
  }

  private async connect(): Promise<FetchS3Client> {
    const { options } = this;
    const env = options.env;
    const endpoint = this.endpoint();
    const base = options.credentials ?? this.ambient(endpoint);
    let credentials: SourceCredentials | AwsCredentialSource = base;
    if (options.role) {
      if (this.scheme !== "s3") {
        throw new Error(
          `${this.url}: role applies to s3:// sources (AWS STS); R2 takes static keys`,
        );
      }
      // The base keys are asked for only when the role's must be renewed.
      credentials = await this.assumed(async () =>
        typeof base === "function" ? await base() : base,
      );
    } else if (this.client) {
      return this.client;
    }
    if (this.scheme === "r2" && !endpoint) {
      throw new Error(`${this.url}: an r2:// source needs account_id or endpoint`);
    }
    this.client = new FetchS3Client({
      bucket: this.bucket,
      region:
        options.region ??
        (this.scheme === "r2" ? "auto" : (env.S3_REGION ?? env.AWS_REGION ?? "us-east-1")),
      ...(endpoint ? { endpoint } : {}),
      credentials,
      fetch: options.fetch,
    });
    return this.client;
  }

  private endpoint(): string | undefined {
    const { options } = this;
    return (
      options.endpoint ??
      (this.scheme === "r2" && options.accountId
        ? `https://${options.accountId}.r2.cloudflarestorage.com`
        : (options.env.S3_ENDPOINT ?? options.env.AWS_ENDPOINT))
    );
  }

  private ambient(endpoint: string | undefined): SourceCredentials | AwsCredentialSource {
    const env = this.options.env;
    const r2 =
      this.scheme === "r2" && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
        ? { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
        : undefined;
    const accessKeyId = r2?.accessKeyId ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      r2?.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      // A role's keys are for AWS: an S3-compatible service is never sent them.
      const aws = this.scheme === "s3" && isAwsEndpoint(endpoint);
      this.role ??= aws
        ? roleCredentials(env, { fetch: this.options.fetch, now: this.options.now })
        : undefined;
      if (this.role) return this.role;
      throw new Error(
        `${this.url} needs keys: credentials in the source, or ${
          this.scheme === "r2"
            ? "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in the environment"
            : aws
              ? "AWS_* / S3_* in the environment, or an ECS task role or EC2 instance role"
              : `AWS_* / S3_* in the environment; a role's keys are not sent to ${endpoint}`
        }`,
      );
    }
    const sessionToken = r2 ? undefined : (env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN);
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  private async assumed(base: () => Promise<SourceCredentials>): Promise<SourceCredentials> {
    const { role, roleCache, now } = this.options;
    if (!role) return base();
    const cacheKey = `${role.arn}\n${role.sessionName}`;
    const cached = roleCache?.get(cacheKey);
    if (cached && cached.expiration.getTime() - now().getTime() > RENEW_BEFORE_MS) {
      return cached;
    }
    const fresh = await assumeRole({
      roleArn: role.arn,
      sessionName: role.sessionName,
      ...(role.externalId !== undefined ? { externalId: role.externalId } : {}),
      credentials: await base(),
      ...(this.options.region ? { region: this.options.region } : {}),
      ...(this.options.stsEndpoint ? { endpoint: this.options.stsEndpoint } : {}),
      fetch: this.options.fetch,
      now,
    });
    roleCache?.set(cacheKey, fresh);
    return fresh;
  }

  async list(
    prefix: string,
    options: { startAfter?: string; limit: number },
  ): Promise<SourceListing> {
    const client = await this.connect();
    const page = await client.listObjects({
      prefix,
      maxKeys: options.limit,
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    });
    return { objects: page.objects, truncated: page.truncated };
  }

  async read(key: string, options: { etag: string; start?: number }): Promise<SourceRead | null> {
    return readOrRefuse(await this.connect(), key, options);
  }
}

/** A conditional, ranged read through either bucket client, its refusals as the poller wants
 * them: 412 (no longer the version listed) and 416 (it shrank below `start` since) are
 * `ObjectChanged`; 403 and other final 4xx answers for this object are `ObjectDenied`. */
async function readOrRefuse(
  client: Pick<FetchS3Client, "getObject">,
  key: string,
  options: { etag: string; start?: number },
): Promise<SourceRead | null> {
  try {
    return await client.getObject(key, {
      ifMatch: options.etag,
      ...(options.start ? { start: options.start } : {}),
    });
  } catch (err) {
    if (err instanceof BucketHttpError && (err.status === 412 || err.status === 416)) {
      throw new ObjectChanged(key);
    }
    if (err instanceof BucketHttpError && err.status === 403) throw new ObjectDenied(key);
    if (err instanceof BucketHttpError && isFinalRefusal(err.status)) {
      throw new ObjectDenied(key, err.status, err.code);
    }
    throw err;
  }
}

export interface AzureSourceOptions {
  url: string;
  account?: string;
  endpoint?: string;
  /** An account key or SAS token; else the standard `AZURE_STORAGE_*` variables in `env`, then
   * workload identity. */
  credentials?: AzureKey;
  fetch: Fetch;
  env: Readonly<Record<string, string | undefined>>;
}

/** A source bucket in Azure Blob Storage (`az://container/prefix`). */
export class AzureSourceBucket implements SourceBucket {
  readonly url: string;
  private readonly container: string;
  private client: FetchAzureBlobClient | undefined;

  constructor(private readonly options: AzureSourceOptions) {
    this.url = options.url;
    this.container = parseAzureUrl(options.url).container;
  }

  locate(key: string): string {
    return `az://${this.container}/${key}`;
  }

  /** Resolved on first use, so a source missing its account or keys fails its run, not the
   * server's start. */
  private connect(): FetchAzureBlobClient {
    if (this.client) return this.client;
    const { options } = this;
    const access = resolveAzureAccess(this.url, {
      ...(options.account ? { account: options.account } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      fetch: options.fetch,
      env: options.env,
    });
    this.client = new FetchAzureBlobClient({
      account: access.account,
      container: this.container,
      ...(access.endpoint ? { endpoint: access.endpoint } : {}),
      credentials: access.credentials,
      fetch: options.fetch,
    });
    return this.client;
  }

  async list(
    prefix: string,
    options: { startAfter?: string; limit: number },
  ): Promise<SourceListing> {
    const page = await this.connect().listObjects({
      prefix,
      maxKeys: options.limit,
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    });
    return { objects: page.objects, truncated: page.truncated };
  }

  async read(key: string, options: { etag: string; start?: number }): Promise<SourceRead | null> {
    return readOrRefuse(this.connect(), key, options);
  }
}

function isFinalRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class FolderSourceBucket implements SourceBucket {
  readonly url: string;
  private readonly root: string;

  constructor(url: string) {
    this.url = url;
    const root = url.startsWith("file://") ? fileURLToPath(url) : url;
    this.root = root.replace(/\/+$/, "") || "/";
  }

  locate(key: string): string {
    return `file://${join(this.root, key)}`;
  }

  private static fingerprint(info: { mtimeMs: number; size: number }): string {
    return `${Math.floor(info.mtimeMs).toString(16)}-${info.size.toString(16)}`;
  }

  async list(
    prefix: string,
    options: { startAfter?: string; limit: number },
  ): Promise<SourceListing> {
    let entries: string[];
    try {
      entries = (await readdir(this.root, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) =>
          join(e.parentPath, e.name)
            .slice(this.root.length + 1)
            .split(sep)
            .join("/"),
        );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { objects: [], truncated: false };
      throw err;
    }
    const keys = entries
      .filter((k) => k.startsWith(prefix))
      .filter((k) => options.startAfter === undefined || k > options.startAfter)
      .sort();
    const page = keys.slice(0, options.limit);
    const objects: SourceObject[] = [];
    for (const key of page) {
      const info = await stat(join(this.root, key)).catch(() => null);
      if (!info) continue;
      objects.push({
        key,
        size: info.size,
        etag: FolderSourceBucket.fingerprint(info),
        last_modified: info.mtime.toISOString(),
      });
    }
    return { objects, truncated: keys.length > page.length };
  }

  async read(key: string, options: { etag: string; start?: number }): Promise<SourceRead | null> {
    const path = join(this.root, key);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "EACCES" || code === "EPERM") throw new ObjectDenied(key);
      throw err;
    }
    try {
      const info = await handle.stat();
      if (FolderSourceBucket.fingerprint(info) !== options.etag) throw new ObjectChanged(key);
      const start = Math.min(options.start ?? 0, info.size);
      const body = new Uint8Array(info.size - start);
      let read = 0;
      while (read < body.length) {
        const { bytesRead } = await handle.read(body, read, body.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (read !== body.length) throw new ObjectChanged(key);
      return { body, etag: options.etag, start, size: info.size, metadata: {} };
    } finally {
      await handle.close();
    }
  }
}

export interface GcsSourceOptions {
  url: string;
  endpoint?: string;
  /** A service account key; else Application Default Credentials from `env`. */
  credentials?: GcsKey;
  fetch: Fetch;
  env: Readonly<Record<string, string | undefined>>;
}

/** A source bucket in Google Cloud Storage (`gs://bucket/prefix`). Its ETags are generations,
 * so a conditional read is on the generation listed. */
export class GcsSourceBucket implements SourceBucket {
  readonly url: string;
  private readonly bucket: string;
  private client: FetchGcsClient | undefined;

  constructor(private readonly options: GcsSourceOptions) {
    this.url = options.url;
    this.bucket = parseGcsUrl(options.url).bucket;
  }

  locate(key: string): string {
    return `gs://${this.bucket}/${key}`;
  }

  /** Resolved on first use, so a source with a bad key fails its run, not the server's start. */
  private connect(): FetchGcsClient {
    if (this.client) return this.client;
    const { options } = this;
    const access = resolveGcsAccess(this.url, {
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      fetch: options.fetch,
      env: options.env,
    });
    this.client = new FetchGcsClient({
      bucket: this.bucket,
      ...(access.endpoint ? { endpoint: access.endpoint } : {}),
      token: access.token,
      fetch: options.fetch,
    });
    return this.client;
  }

  async list(
    prefix: string,
    options: { startAfter?: string; limit: number },
  ): Promise<SourceListing> {
    const page = await this.connect().listObjects({
      prefix,
      maxKeys: options.limit,
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    });
    return { objects: page.objects, truncated: page.truncated };
  }

  async read(key: string, options: { etag: string; start?: number }): Promise<SourceRead | null> {
    return readOrRefuse(this.connect(), key, options);
  }
}
