import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { ensurePrivateDir, LocalLock, readText, writePrivateFile } from "./files";
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
    const lock = JSON.parse(readText(paths.uploaderLock) ?? "null") as UploaderLock | null;
    return lock && typeof lock.pid === "number" ? lock : undefined;
  } catch {
    return undefined;
  }
}

export function uploaderRunning(paths: CapturePaths, now: Date = new Date()): boolean {
  const lock = readUploaderLock(paths);
  if (!lock) return false;
  if (now.getTime() - Date.parse(lock.beat) > STALE_MS) return false;
  return lock.host !== hostname() || processAlive(lock.pid);
}

export class HeldUploaderLock {
  constructor(
    private readonly paths: CapturePaths,
    readonly lock: UploaderLock,
  ) {}

  held(): boolean {
    return readUploaderLock(this.paths)?.token === this.lock.token;
  }

  /** Renew the heartbeat; false when another uploader took the lock over (stop then). */
  beat(now: Date = new Date()): boolean {
    if (!this.held()) return false;
    this.lock.beat = now.toISOString();
    writePrivateFile(this.paths.uploaderLock, JSON.stringify(this.lock));
    return true;
  }

  release(): void {
    if (this.held()) rmSync(this.paths.uploaderLock, { force: true });
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
  if (!new LocalLock(paths.uploaderLock, JSON.stringify(lock)).tryTake()) {
    if (uploaderRunning(paths, now)) return null;
    if (!takeOverStaleLock(paths, lock, now)) return null;
  }
  const held = new HeldUploaderLock(paths, lock);
  return held.held() ? held : null;
}

export const TAKEOVER_STALE_MS = 10_000;

export function takeOverStaleLock(paths: CapturePaths, lock: UploaderLock, now: Date): boolean {
  const guard = new LocalLock(`${paths.uploaderLock}.takeover`, lock.token);
  if (!guard.tryTake()) {
    guard.clearIfStale(TAKEOVER_STALE_MS, now.getTime());
    return false;
  }
  try {
    if (uploaderRunning(paths, now)) return false;
    writePrivateFile(paths.uploaderLock, JSON.stringify(lock));
    return true;
  } finally {
    guard.release();
  }
}
