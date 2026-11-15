/** `@seshi/capture`, layer 5 (X3.2): everything that captures sessions on a machine (F9). The
 * spool hooks write to, the uploader that drains it with the offset and continuation protocol,
 * the sweep, the capture rules and the one decision function, the state file, the status line's
 * words, and retraction (F9.7). It uses `@seshi/client`, `@seshi/config`, `@seshi/kit` and
 * `@seshi/model`, never `@seshi/instance`: `apps/seshi` hands it a `SessionSink` (HTTP, or local
 * mode's Instance) and the credential.
 *
 * `seshi hook` and `seshi statusline` import `@seshi/capture/fast` instead, which loads none of
 * the HTTP client or the config schema. */

export {
  appendLog,
  ensurePrivateDir,
  LockTimeout,
  readText,
  withLock,
  writePrivateFile,
} from "./files";
export { type HookOutcome, type HookRun, runHook, shellWord } from "./hook";
export { type CapturePaths, captureDir, capturePaths } from "./paths";
export {
  findRepo,
  gitRemotes,
  headBranch,
  parseRepoConfig,
  placeOf,
  REPO_CONFIG,
} from "./place";
export {
  type CaptureRules,
  DEFAULT_RULES,
  type DecideInput,
  type Decision,
  decide,
  folderRule,
  type Level,
  normalizeRemote,
  type PathRule,
  type Place,
  type RepoConfig,
  remoteMatches,
  within,
} from "./rules";
export { captureRules, loadRules, type RulesSnapshot } from "./rules-cache";
export {
  type HttpSinkOptions,
  httpSink,
  type RetractOutcome,
  RetractRefused,
  type SessionSink,
  SignInNeeded,
  type UploadCredential,
} from "./sink";
export {
  appendSpool,
  readSpool,
  removeSpool,
  SPOOL_VERSION,
  type SpoolEntry,
  type SpoolItem,
  spoolCount,
} from "./spool";
export {
  type CaptureState,
  emptyState,
  isPaused,
  newSecret,
  type Problem,
  readState,
  type SessionState,
  STATE_SCHEMA,
  StateUnreadable,
  sessionKey,
  type Toggle,
  updateState,
  uploadId,
} from "./state";
export {
  MAX_PROBLEMS,
  type StatusLine,
  type StatusProblem,
  sessionWord,
  statusLine,
} from "./status";
export {
  type FoundTranscript,
  HEAD_BYTES,
  identifySafely,
  readHead,
  sweepAgent,
  sweepRoot,
  transcriptFiles,
} from "./sweep";
export {
  type GitIdentity,
  gitIdentity,
  NO_PREREDACTION,
  type PassOptions,
  type PassSummary,
  type PreRedactInput,
  type PreRedactor,
  retractHash,
  Uploader,
  type UploaderOptions,
} from "./uploader";
export {
  acquireUploaderLock,
  HeldUploaderLock,
  processAlive,
  readUploaderLock,
  STALE_MS,
  type UploaderLock,
  uploaderRunning,
} from "./uploader-lock";
