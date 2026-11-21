import { createHash, randomBytes } from "node:crypto";
import {
  link,
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

const TMP_SUFFIX = ".tmp";
const LOCK_SUFFIX = ".~lock";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const STALE_LOCK_MS = 10_000;
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
      throw storeFailure(`read ${key}`, err);
    }
  }

  private async locked<T>(key: string, path: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${path}${LOCK_SUFFIX}`;
    const token = `${process.pid} ${randomBytes(8).toString("hex")} ${new Date().toISOString()}\n`;
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
      try {
        const handle = await open(lock, "wx", FILE_MODE);
        try {
          await handle.writeFile(token);
        } finally {
          await handle.close();
        }
        break;
      } catch (err) {
        if (!isCode(err, "EEXIST")) throw err;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS && (await this.takeOver(lock))) {
          continue;
        }
        if (Date.now() > deadline) throw new StoreError(`${key} is locked (${lock})`);
        await sleep(wait * (0.5 + Math.random()));
      }
    }
    try {
      return await fn();
    } finally {
      await this.release(lock, token);
    }
  }

  private async takeOver(lock: string): Promise<boolean> {
    const aside = `${lock}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;
    try {
      await rename(lock, aside);
    } catch (err) {
      if (isCode(err, "ENOENT")) return true;
      throw err;
    }
    const info = await stat(aside).catch(() => null);
    if (info && Date.now() - info.mtimeMs <= STALE_LOCK_MS) {
      try {
        await link(aside, lock);
      } catch (err) {
        if (!isCode(err, "EEXIST")) throw err;
      }
      await rm(aside, { force: true });
      return false;
    }
    await rm(aside, { force: true });
    return true;
  }

  private async release(lock: string, token: string): Promise<void> {
    const held = await readFile(lock, "utf8").catch(() => null);
    if (held === token) await rm(lock, { force: true });
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
          await writeFile(tmp, body, { mode: FILE_MODE });
          await rename(tmp, path);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
        return { etag: md5(body) };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw storeFailure(`write ${key}`, err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const path = this.pathOf(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const body = await this.read(path);
      if (body === null) return null;
      return { size: body.length, etag: md5(body), modified: info.mtime.toISOString() };
    } catch (err) {
      if (isCode(err, "ENOENT")) return null;
      throw storeFailure(`stat ${key}`, err);
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
      throw storeFailure(`delete ${key}`, err);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const limit = options.limit ?? 1000;
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
      throw storeFailure(`list ${prefix}`, err);
    }
    if (options.startAfter !== undefined) {
      const after = options.startAfter;
      keys = keys.filter((k) => k > after);
    }
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    if (!options.details) return { keys: page, truncated };
    const objects = await Promise.all(
      page.map(async (key): Promise<ListedKey> => {
        const info = await stat(join(this.root, ...key.split("/"))).catch(() => null);
        return info ? { key, modified: info.mtime.toISOString(), size: info.size } : { key };
      }),
    );
    return { keys: page, truncated, objects };
  }
}
