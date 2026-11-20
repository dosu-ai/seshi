import { posix, win32 } from "node:path";
import { type CaptureHost, captureDir } from "@seshi/kit";

export { captureDir };

export interface CapturePaths {
  dir: string;
  state: string;
  spool: string;
  uploaderLock: string;
  rules: string;
  redactionRules: string;
  /** The server's capture rules, as the uploader last fetched them (`org-rules.ts`). */
  orgRules: string;
  log: string;
  /** The last conversation prompted, per agent and folder (an editor's indicator reads it). */
  recent: string;
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
    orgRules: at(dir, "capture-rules.json"),
    log: at(dir, "capture.log"),
    recent: at(dir, "recent"),
  };
}
