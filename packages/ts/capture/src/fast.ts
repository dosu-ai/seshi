/** `@seshi/capture/fast`: what `seshi hook` and `seshi statusline` load at start-up (X3.3).
 * Nothing here loads the HTTP client or the config schema: the rules come from the cache, and
 * the config loader is imported only when the CLI config changed. `bun run check:hook` holds
 * this to it. */

export { appendLog } from "./files";
export { type HookOutcome, type HookRun, runHook } from "./hook";
export { type CapturePaths, captureDir, capturePaths } from "./paths";
export { placeOf } from "./place";
export { type Decision, decide } from "./rules";
export { captureRules, type RulesSnapshot } from "./rules-cache";
export { appendSpool, spoolCount } from "./spool";
export {
  type CaptureState,
  isPaused,
  otherFolders,
  readState,
  StateUnreadable,
  sessionKey,
  sessionToggle,
} from "./state";
export { MAX_PROBLEMS, type StatusLine, type StatusProblem, statusLine } from "./status";
export { uploaderRunning } from "./uploader-lock";
