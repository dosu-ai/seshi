/** A directory as a `Store`: the local target for development and single-machine use, and what
 * tests use (X6.1). Writes are temp + rename so a reader never sees a partial object.
 *
 * The ETag is the MD5 of the object's bytes in hex, as S3 reports it for a single-part PUT, so
 * an ETag read here can be compared, verified and passed back as `ifMatch` the same way.
 *
 * Conditional writes (X6.5) are emulated with a lock file per key, created exclusively
 * (`open(…, "wx")`): every write and delete of a key takes its lock, checks the condition
 * against the object on disk, renames the new object into place and releases the lock. That is
 * safe between processes on one machine only, as decided; a lock left by a process that died is
 * taken over once it is older than `STALE_LOCK_MS`. */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DeleteOptions,
  type ListOptions,
  type ListResult,
  type ObjectStat,
  PreconditionFailed,
  type PutOptions,
  type PutResult,
  type Store,
  type StoredObject,
  StoreError,
} from "./store";

/** Suffixes of the files the store keeps beside objects; never listed, never valid keys. */
const TMP_SUFFIX = ".tmp";
const LOCK_SUFFIX = ".~lock";

/** A lock older than this was left by a process that died mid-write. Writes hold a lock for
 * milliseconds. */
export const STALE_LOCK_MS = 10_000;
/** How long a writer waits for a key's lock before failing. */
const LOCK_WAIT_MS = 15_000;

function isCode(err: unknown, code: string): boolean {
  return (err as { code?: string } | null)?.code === code;
}

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export class FsStore implements Store {
  readonly root: string;
  readonly url: string;

  /** `dir` may be a path or a `file://` URL. */
  constructor(dir: string) {
    this.root = resolve(dir.startsWith("file://") ? fileURLToPath(dir) : dir);
    this.url = pathToFileURL(this.root).href;
  }

  private pathOf(key: string): string {
    if (
      key === "" ||
      key.startsWith("/") ||
      key.split("/").includes("..") ||
      key.endsWith(TMP_SUFFIX) ||
      key.endsWith(LOCK_SUFFIX)
    ) {
      throw new StoreError(`invalid key: ${key}`);
    }
    return join(this.root, ...key.split("/"));
  }

  private async read(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path));
    } catch (err) {
      if (isCode(err, "ENOENT") || isCode(err, "EISDIR")) return null;
      throw err;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathOf(key);
    try {
      const body = await this.read(path);
      return body === null ? null : { body, etag: md5(body) };
    } catch (err) {
      throw new StoreError(`read ${key}`, err);
    }
  }

  /** Run `fn` holding the key's lock file. */
  private async locked<T>(key: string, path: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${path}${LOCK_SUFFIX}`;
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
      try {
        const handle = await open(lock, "wx");
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        await handle.close();
        break;
      } catch (err) {
        if (!isCode(err, "EEXIST")) throw err;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new StoreError(`${key} is locked (${lock})`);
        await sleep(wait * (0.5 + Math.random()));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  private check(
    key: string,
    current: Uint8Array | null,
    condition: { ifMatch?: string; ifNoneMatch?: "*" },
  ): void {
    if (condition.ifNoneMatch === "*" && current !== null) {
      throw new PreconditionFailed(key, "an object already exists");
    }
    if (condition.ifMatch !== undefined) {
      if (current === null) throw new PreconditionFailed(key, "no object to replace");
      if (md5(current) !== condition.ifMatch) {
        throw new PreconditionFailed(key, "the object changed since it was read");
      }
    }
  }

  async put(key: string, body: Uint8Array, options: PutOptions = {}): Promise<PutResult> {
    const path = this.pathOf(key);
    const conditional = options.ifMatch !== undefined || options.ifNoneMatch !== undefined;
    try {
      return await this.locked(key, path, async () => {
        if (conditional) this.check(key, await this.read(path), options);
        const tmp = `${path}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;
        try {
          await writeFile(tmp, body);
          await rename(tmp, path);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
        return { etag: md5(body) };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError(`write ${key}`, err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const path = this.pathOf(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const body = await this.read(path);
      if (body === null) return null;
      return { size: body.length, etag: md5(body) };
    } catch (err) {
      if (isCode(err, "ENOENT")) return null;
      throw new StoreError(`stat ${key}`, err);
    }
  }

  async delete(key: string, options: DeleteOptions = {}): Promise<void> {
    const path = this.pathOf(key);
    try {
      await this.locked(key, path, async () => {
        if (options.ifMatch !== undefined) {
          const current = await this.read(path);
          if (current === null) return;
          this.check(key, current, { ifMatch: options.ifMatch });
        }
        try {
          await unlink(path);
        } catch (err) {
          if (!isCode(err, "ENOENT")) throw err;
        }
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError(`delete ${key}`, err);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const limit = options.limit ?? 1000;
    // The deepest directory the prefix fully names; walk from there and filter.
    const cut = prefix.lastIndexOf("/");
    const dir = cut < 0 ? this.root : join(this.root, ...prefix.slice(0, cut).split("/"));
    if (prefix.split("/").includes("..")) throw new StoreError(`invalid prefix: ${prefix}`);
    let keys: string[];
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      keys = entries
        .filter((e) => e.isFile() && !e.name.endsWith(TMP_SUFFIX) && !e.name.endsWith(LOCK_SUFFIX))
        .map((e) => relative(this.root, join(e.parentPath, e.name)).split(sep).join("/"))
        .filter((k) => k.startsWith(prefix))
        .sort();
    } catch (err) {
      if (isCode(err, "ENOENT")) return { keys: [], truncated: false };
      throw new StoreError(`list ${prefix}`, err);
    }
    if (options.startAfter !== undefined) {
      const after = options.startAfter;
      keys = keys.filter((k) => k > after);
    }
    return { keys: keys.slice(0, limit), truncated: keys.length > limit };
  }
}
