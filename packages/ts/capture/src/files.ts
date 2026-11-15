/** File plumbing for the capture folder: private files written whole (temporary file, then
 * rename, so a reader never sees half of one), a lock file for read-modify-write, and the log.
 * Only `node:` modules: the hook loads this. */

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

/** The most `readBounded` reads of a repo's own file (`.seshi/config.toml`, the `.git` pointer,
 * `HEAD`, git's `config`): far more than any real one holds. */
export const REPO_FILE_MAX_BYTES = 64 * 1024;

/** A file a repo controls, read without trusting it: its text; `absent` when it is not there;
 * `invalid` (why) when it is anything but a regular file of at most `max` bytes. */
export type BoundedRead = { text: string } | { absent: true } | { invalid: string };

/** Read a file a checkout may have planted (a link to `/dev/zero`, a FIFO, a folder, a huge
 * file) without hanging or throwing: `lstat` it (and `stat`, through a link), open it without
 * blocking, `fstat` the descriptor and require a regular file, and read at most `max` bytes. */
export function readBounded(path: string, max = REPO_FILE_MAX_BYTES): BoundedRead {
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

/** The log stops growing past this: it is moved to `<log>.1` and started again. */
export const LOG_MAX_BYTES = 1024 * 1024;

/** Append one line to the capture log, stamped with the time. Never throws: a log that cannot
 * be written must not break a hook. */
export function appendLog(path: string, line: string, now: Date = new Date()): void {
  try {
    ensurePrivateDir(dirname(path));
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {}
    appendFileSync(path, `${now.toISOString()} ${line.replace(/\n/g, " ")}\n`, { mode: 0o600 });
  } catch {
    // Nowhere left to say it.
  }
}

export interface LockOptions {
  /** How long to wait for another holder, in milliseconds. Default 5 s. */
  timeoutMs?: number;
  /** A lock older than this is taken over (its holder died). Default 10 s. */
  staleMs?: number;
}

/** The lock could not be taken in time. */
export class LockTimeout extends Error {
  constructor(readonly path: string) {
    super(`${path} is locked by another seshi process`);
    this.name = "LockTimeout";
  }
}

/** Run `fn` holding `<path>.~lock`, a file created exclusively with a random token in it. A lock
 * left by a process that died is taken over after `staleMs`, by renaming it aside (only one
 * waiter wins the rename); a holder removes only a lock that still holds its token. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const lock = `${path}.~lock`;
  const token = randomBytes(8).toString("hex");
  const timeout = options.timeoutMs ?? 5000;
  const stale = options.staleMs ?? 10_000;
  const started = Date.now();
  ensurePrivateDir(dirname(path));
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, token);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > stale) {
        const aside = `${lock}.${token}`;
        renameSync(lock, aside);
        rmSync(aside, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() - started > timeout) throw new LockTimeout(path);
    await Bun.sleep(5 + Math.floor(Math.random() * 20));
  }
  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {}
  }
}
