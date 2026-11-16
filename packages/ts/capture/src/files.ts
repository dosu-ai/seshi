import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Create `dir` (and its parents), readable only by this user. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write `text` to `path` as a file only this user can read, through a temporary file renamed
 * into place. */
export function writePrivateFile(path: string, text: string): void {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temp, 0o600);
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** A file's text; undefined when it does not exist. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export const REPO_FILE_MAX_BYTES = 64 * 1024;

export const GIT_CONFIG_MAX_BYTES = 4 * 1024 * 1024;

export type UntrustedRepoFileRead = { text: string } | { absent: true } | { invalid: string };

export function readUntrustedRepoFile(
  path: string,
  max = REPO_FILE_MAX_BYTES,
): UntrustedRepoFileRead {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { absent: true };
    return { invalid: `cannot be read (${code ?? (err as Error).message})` };
  }
  try {
    if (stat.isSymbolicLink()) stat = statSync(path);
  } catch {
    return { invalid: "is a link to nothing" };
  }
  if (!stat.isFile()) return { invalid: "is not a regular file" };
  if (stat.size > max) return { invalid: `is larger than ${max} bytes` };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { invalid: `cannot be read (${(err as NodeJS.ErrnoException).code ?? err})` };
  }
  try {
    // The file could have been swapped since the stat: judge what was opened.
    if (!fstatSync(fd).isFile()) return { invalid: "is not a regular file" };
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > max) return { invalid: `is larger than ${max} bytes` };
    return { text: buffer.subarray(0, length).toString("utf8") };
  } catch (err) {
    return { invalid: `cannot be read (${(err as NodeJS.ErrnoException).code ?? err})` };
  } finally {
    closeSync(fd);
  }
}

export const LOG_MAX_BYTES = 1024 * 1024;

/** Append one line to the capture log, stamped with the time. Never throws: a log that cannot
 * be written must not break a hook. */
export function appendLog(path: string, line: string, now: Date = new Date()): boolean {
  try {
    ensurePrivateDir(dirname(path));
    tryRotateLog(path);
    appendFileSync(path, `${now.toISOString()} ${line.replace(/\n/g, " ")}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function tryRotateLog(path: string): boolean {
  try {
    if (statSync(path).size <= LOG_MAX_BYTES) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

export function tryStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

export function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function tryReadJson(path: string): unknown {
  try {
    return JSON.parse(readText(path) ?? "null");
  } catch {
    return undefined;
  }
}

export function tryWritePrivateFile(path: string, text: string): boolean {
  try {
    writePrivateFile(path, text);
    return true;
  } catch {
    return false;
  }
}

export interface LockOptions {
  /** How long to wait for another holder, in milliseconds. Default 5 s. */
  timeoutMs?: number;
  /** A lock older than this is taken over (its holder died). Default 10 s. */
  staleMs?: number;
}

export class LockTimeout extends Error {
  constructor(readonly path: string) {
    super(`${path} is locked by another seshi process`);
    this.name = "LockTimeout";
  }
}

/** A lock file created exclusively, holding `token`. One whose holder died is judged by its age
 * and cleared; a holder removes it only while it still holds its token. */
export class LocalLock {
  constructor(
    readonly path: string,
    readonly token: string = randomBytes(8).toString("hex"),
  ) {}

  /** Create the lock; false when it exists. */
  tryTake(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
    try {
      writeFileSync(fd, this.token);
    } catch (err) {
      closeSync(fd);
      rmSync(this.path, { force: true });
      throw err;
    }
    closeSync(fd);
    return true;
  }

  /** Clear a lock last written more than `staleMs` before `now`. "held" when it is younger; "gone"
   * when it was cleared, or went or changed meanwhile (try again). */
  clearIfStale(staleMs: number, now: number): "held" | "gone" {
    try {
      if (now - statSync(this.path).mtimeMs <= staleMs) return "held";
      const aside = `${this.path}.${this.token}`;
      renameSync(this.path, aside);
      rmSync(aside, { force: true });
    } catch {}
    return "gone";
  }

  release(): boolean {
    try {
      if (readFileSync(this.path, "utf8") !== this.token) return false;
      rmSync(this.path, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Run `fn` holding `<path>.~lock` (a `LocalLock`), waiting up to `timeoutMs` for another holder
 * and taking over one older than `staleMs`. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const lock = new LocalLock(`${path}.~lock`);
  const timeout = options.timeoutMs ?? 5000;
  const stale = options.staleMs ?? 10_000;
  const started = Date.now();
  ensurePrivateDir(dirname(path));
  while (!lock.tryTake()) {
    if (lock.clearIfStale(stale, Date.now()) === "gone") continue;
    if (Date.now() - started > timeout) throw new LockTimeout(path);
    await Bun.sleep(5 + Math.floor(Math.random() * 20));
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
