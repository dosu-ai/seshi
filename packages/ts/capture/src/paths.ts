/** Where capture keeps its files on a machine (F9.1): `~/.local/state/seshi/` on macOS and Linux
 * (`$XDG_STATE_HOME/seshi` when set), `%LOCALAPPDATA%\seshi\` on Windows. The folder holds the
 * state file, the spool, the uploader's lock and the logs. Pure: the environment, home folder
 * and platform come in as arguments. */

import { join, win32 } from "node:path";
import type { CaptureHost } from "@seshi/kit";

export interface CapturePaths {
  /** The folder itself. */
  dir: string;
  /** The one state file per machine: toggles, pause, upload positions, retraction secrets,
   * problems (F9.5). */
  state: string;
  /** One file per hook event waiting for the uploader. */
  spool: string;
  /** Held by the running uploader: its process id and when it last looked at the spool. */
  uploader: string;
  /** The capture rules the CLI config held when it last changed (the hook's fast path). */
  rules: string;
  /** The org's redaction rules as the uploader last fetched them, with their ETag, so an
   * unchanged rule set costs a 304 (F2.4). Written by `apps/seshi`'s pre-redactor. */
  redactionRules: string;
  /** Errors from hooks and the uploader: hooks never print, so they go here (F9.1). */
  log: string;
}

/** The capture folder for this user. */
export function captureDir(host: CaptureHost): string {
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA || win32.join(host.home, "AppData", "Local");
    return win32.join(local, "seshi");
  }
  const base = host.env.XDG_STATE_HOME || join(host.home, ".local", "state");
  return join(base, "seshi");
}

export function capturePaths(host: CaptureHost): CapturePaths {
  const dir = captureDir(host);
  const at = host.platform === "win32" ? win32.join : join;
  return {
    dir,
    state: at(dir, "state.json"),
    spool: at(dir, "spool"),
    uploader: at(dir, "uploader.json"),
    rules: at(dir, "rules.json"),
    redactionRules: at(dir, "redaction-rules.json"),
    log: at(dir, "capture.log"),
  };
}
