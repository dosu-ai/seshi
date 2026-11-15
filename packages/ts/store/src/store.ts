/** The storage interface the server writes through. Keys are relative to the
 * store's root (a directory, or a bucket prefix) and use `/`. Two implementations: `fs` and
 * `s3` (AWS S3 and Cloudflare R2, plus anything S3-compatible with an explicit endpoint).
 *
 * Mutable objects (metadata, checkpoints, markers, token records) are written with conditional
 * writes (X6.5): `get` returns the object's ETag, `put` takes `ifMatch` (replace only that
 * version) or `ifNoneMatch: "*"` (create only), and a failed condition throws
 * `PreconditionFailed`. `updateObject` is the read-modify-write loop over them. */

import { StoreError } from "@seshi/model";

export interface ObjectStat {
  size: number;
  /** The object's ETag, unquoted, as the backend reports it. For a single-part PUT on S3, R2
   * and MinIO this is the MD5 of the body in hex, and the folder store uses the same MD5, which
   * `publish` uses to verify without reading the object back. Absent only when a backend
   * reports none. */
  etag?: string;
}

/** An object and the version it was read at: pass `etag` as `ifMatch` to replace exactly
 * this version. */
export interface StoredObject {
  body: Uint8Array;
  /** Unquoted. */
  etag: string;
}

export interface PutOptions {
  contentType?: string;
  /** Write only if the object's current ETag is this one (unquoted). Fails with
   * `PreconditionFailed` when the object changed or is gone. */
  ifMatch?: string;
  /** `"*"`: write only if no object is at the key. Fails with `PreconditionFailed` when one
   * is. */
  ifNoneMatch?: "*";
}

export interface PutResult {
  /** The new object's ETag (unquoted), when the backend reports it. */
  etag?: string;
}

export interface DeleteOptions {
  /** Delete only if the object's current ETag is this one; `PreconditionFailed` otherwise. A
   * missing object is not an error, as for an unconditional delete. */
  ifMatch?: string;
}

export interface ListOptions {
  /** Keys lexicographically after this one (exclusive), as S3's `StartAfter`. */
  startAfter?: string;
  limit?: number;
  /** Also say when each object was last written (`objects`): S3's `LastModified`, a file's
   * mtime. The folder store reads each listed file's mtime for it, so ask only when needed. */
  details?: boolean;
}

/** One listed object, with what the listing says of it. */
export interface ListedKey {
  key: string;
  /** When the object was last written, ISO 8601, as the backend reports it (S3's
   * `LastModified`, the file's mtime). Absent when the backend does not say, or the object went
   * between the listing and the look. */
  modified?: string;
  size?: number;
}

export interface ListResult {
  keys: string[];
  truncated: boolean;
  /** With `details`: each of `keys`, in the same order, with its last change. */
  objects?: ListedKey[];
}

export interface Store {
  /** `file:///…`, `s3://bucket/prefix`, `r2://bucket/prefix`. */
  readonly url: string;
  /** The object and its ETag, or null when there is none. */
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string, options?: DeleteOptions): Promise<void>;
  /** Keys under `prefix`, in lexicographic order. */
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
}

/** Defined in `@seshi/model` so the HTTP client throws the same class without depending on
 * this package. */
export { StoreError };

/** A conditional write or delete whose condition did not hold: the object changed since it was
 * read (`ifMatch`), or one already exists (`ifNoneMatch: "*"`). Re-read and try again, or give
 * up (a second worker's checkpoint write, X7.3). */
export class PreconditionFailed extends StoreError {
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`precondition failed for ${key}: ${detail}`);
    this.name = "PreconditionFailed";
    this.key = key;
  }
}

export function isPreconditionFailed(err: unknown): err is PreconditionFailed {
  return err instanceof PreconditionFailed;
}

/** The bytes at `key`, or null: `get` without the ETag. */
export async function getBytes(store: Store, key: string): Promise<Uint8Array | null> {
  return (await store.get(key))?.body ?? null;
}

/** What an `updateObject` step decides: the new bytes, or `null` to leave the object as it is
 * (nothing to change). */
export type UpdateStep = (current: StoredObject | null) => Uint8Array | null;

export interface UpdateOptions {
  contentType?: string;
  /** How many times to re-read and retry after a `PreconditionFailed`; default 8. */
  retries?: number;
  /** Waits between tries, for tests; default a short jittered backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface UpdateResult {
  /** Whether a new version was written. */
  written: boolean;
  /** The object as it now stands: what was written, or what `step` left alone (null when
   * there is none). */
  current: StoredObject | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read-modify-write with retry (X6.5): read the object, let `step` compute the next version
 * from it, and write that with `ifMatch` (or `ifNoneMatch: "*"` when there was none). When
 * another writer got there first the write fails with 412; the loop reads again and asks
 * `step` again, so `step` must be a pure function of what it is given. Throws the last
 * `PreconditionFailed` once `retries` are spent. */
export async function updateObject(
  store: Store,
  key: string,
  step: UpdateStep,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const retries = options.retries ?? 8;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const current = await store.get(key);
    const next = step(current);
    if (next === null) return { written: false, current };
    try {
      const put = await store.put(key, next, {
        contentType: options.contentType,
        ...(current ? { ifMatch: current.etag } : { ifNoneMatch: "*" }),
      });
      return { written: true, current: { body: next, etag: put.etag ?? "" } };
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt >= retries) throw err;
      await sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }
}
