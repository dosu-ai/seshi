import { posix, win32 } from "node:path";
import type { CaptureHost } from "@seshi/kit";

export interface CapturePaths {
  dir: string;
  state: string;
  spool: string;
  uploaderLock: string;
  rules: string;
  redactionRules: string;
  log: string;
  /** The last conversation prompted, per agent and folder (an editor's indicator reads it). */
  recent: string;
}

export function captureDir(host: CaptureHost): string {
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA || win32.join(host.home, "AppData", "Local");
    return win32.join(local, "seshi");
  }
  const base = host.env.XDG_STATE_HOME || posix.join(host.home, ".local", "state");
  return posix.join(base, "seshi");
}

export function capturePaths(host: CaptureHost): CapturePaths {
  const dir = captureDir(host);
  const at = host.platform === "win32" ? win32.join : posix.join;
  return {
    dir,
    state: at(dir, "state.json"),
    spool: at(dir, "spool"),
    uploaderLock: at(dir, "uploader.json"),
    rules: at(dir, "rules.json"),
    redactionRules: at(dir, "redaction-rules.json"),
    log: at(dir, "capture.log"),
    recent: at(dir, "recent"),
  };
}
