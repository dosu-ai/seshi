import { open, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fetch } from "@seshi/model";
import {
  type AssumedCredentials,
  assumeRole,
  type FetchedObject,
  FetchS3Client,
  type ListedObject,
  parseS3Url,
  S3HttpError,
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
  /** Where `key` sits, for provenance: `s3://bucket/key`, `r2://bucket/key`, `file:///path`. */
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
  /** Static keys; else the standard variables in `env` (`AWS_*`, `S3_*`; `R2_*` for r2://). */
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
    const base = options.credentials ?? this.ambient();
    let credentials: SourceCredentials = base;
    if (options.role) {
      if (this.scheme !== "s3") {
        throw new Error(
          `${this.url}: role applies to s3:// sources (AWS STS); R2 takes static keys`,
        );
      }
      credentials = await this.assumed(base);
    } else if (this.client) {
      return this.client;
    }
    const endpoint =
      options.endpoint ??
      (this.scheme === "r2" && options.accountId
        ? `https://${options.accountId}.r2.cloudflarestorage.com`
        : (env.S3_ENDPOINT ?? env.AWS_ENDPOINT));
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

  private ambient(): SourceCredentials {
    const env = this.options.env;
    const r2 =
      this.scheme === "r2" && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
        ? { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
        : undefined;
    const accessKeyId = r2?.accessKeyId ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      r2?.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `${this.url} needs keys: credentials in the source, or ${
          this.scheme === "r2" ? "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY" : "AWS_* / S3_*"
        } in the environment`,
      );
    }
    const sessionToken = r2 ? undefined : (env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN);
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  private async assumed(base: SourceCredentials): Promise<SourceCredentials> {
    const { role, roleCache, now } = this.options;
    if (!role) return base;
    const cacheKey = `${role.arn}\n${role.sessionName}`;
    const cached = roleCache?.get(cacheKey);
    if (cached && cached.expiration.getTime() - now().getTime() > RENEW_BEFORE_MS) {
      return cached;
    }
    const fresh = await assumeRole({
      roleArn: role.arn,
      sessionName: role.sessionName,
      ...(role.externalId !== undefined ? { externalId: role.externalId } : {}),
      credentials: base,
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
    const client = await this.connect();
    try {
      return await client.getObject(key, {
        ifMatch: options.etag,
        ...(options.start ? { start: options.start } : {}),
      });
    } catch (err) {
      // 412: no longer the version listed. 416: it shrank below `start` since.
      if (err instanceof S3HttpError && (err.status === 412 || err.status === 416)) {
        throw new ObjectChanged(key);
      }
      if (err instanceof S3HttpError && err.status === 403) throw new ObjectDenied(key);
      if (
        err instanceof S3HttpError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 408 &&
        err.status !== 429
      ) {
        throw new ObjectDenied(key, err.status, err.code);
      }
      throw err;
    }
  }
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

  private static etag(info: { mtimeMs: number; size: number }): string {
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
        etag: FolderSourceBucket.etag(info),
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
      if (FolderSourceBucket.etag(info) !== options.etag) throw new ObjectChanged(key);
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
