/** One uploader per machine (F9.1). The running uploader holds `uploader.json`: its process id
 * and a heartbeat it renews on every pass. A hook starts an uploader when there is none: no
 * file, a process that is gone, or a heartbeat older than `STALE_MS` (a hung uploader, or a
 * process id the system gave to another program). A newer uploader takes over a stale lock;
 * the old one finds on its next beat that the lock is no longer its own and stops. */

import { randomBytes } from "node:crypto";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { ensurePrivateDir, readText, writePrivateFile } from "./files";
import type { CapturePaths } from "./paths";

/** An uploader that has not beaten for this long is taken to be gone. */
export const STALE_MS = 2 * 60_000;

export interface UploaderLock {
  pid: number;
  host: string;
  token: string;
  started_at: string;
  beat: string;
}

/** Whether a process with this id is running here. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readUploaderLock(paths: CapturePaths): UploaderLock | undefined {
  try {
    const lock = JSON.parse(readText(paths.uploader) ?? "null") as UploaderLock | null;
    return lock && typeof lock.pid === "number" ? lock : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an uploader is running and alive now. */
export function uploaderRunning(paths: CapturePaths, now: Date = new Date()): boolean {
  const lock = readUploaderLock(paths);
  if (!lock) return false;
  if (now.getTime() - Date.parse(lock.beat) > STALE_MS) return false;
  return lock.host !== hostname() || processAlive(lock.pid);
}

/** The lock, held by this process. */
export class HeldUploaderLock {
  constructor(
    private readonly paths: CapturePaths,
    readonly lock: UploaderLock,
  ) {}

  /** Whether this process still holds it. */
  held(): boolean {
    return readUploaderLock(this.paths)?.token === this.lock.token;
  }

  /** Renew the heartbeat; false when another uploader took the lock over (stop then). */
  beat(now: Date = new Date()): boolean {
    if (!this.held()) return false;
    this.lock.beat = now.toISOString();
    writePrivateFile(this.paths.uploader, JSON.stringify(this.lock));
    return true;
  }

  release(): void {
    if (this.held()) rmSync(this.paths.uploader, { force: true });
  }
}

/** Take the lock; null when another live uploader holds it. */
export function acquireUploaderLock(
  paths: CapturePaths,
  now: Date = new Date(),
  pid: number = process.pid,
): HeldUploaderLock | null {
  ensurePrivateDir(paths.dir);
  const lock: UploaderLock = {
    pid,
    host: hostname(),
    token: randomBytes(8).toString("hex"),
    started_at: now.toISOString(),
    beat: now.toISOString(),
  };
  try {
    const fd = openSync(paths.uploader, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(lock));
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (uploaderRunning(paths, now)) return null;
    writePrivateFile(paths.uploader, JSON.stringify(lock));
  }
  const held = new HeldUploaderLock(paths, lock);
  return held.held() ? held : null;
}
