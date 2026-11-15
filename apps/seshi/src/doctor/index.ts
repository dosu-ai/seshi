/** The session checks engine: `gatherEvidence` (what is known about one session from its
 * transcript, this machine's capture state and what was stored) and `runChecks` (what that
 * says). Used by `seshi doctor`, and meant for `seshi explore` too: both steps take their
 * loaders in `DoctorDeps`, and the evidence is plain JSON. */

export {
  chainCheck,
  changesCheck,
  decisionCheck,
  offsetsCheck,
  PENDING_STUCK_MS,
  prefixCheck,
  presenceCheck,
  queueCheck,
  recordsCheck,
  residueCheck,
  runChecks,
  SPOOL_STUCK_MS,
  searchCheck,
  secretCheck,
  stalenessCheck,
  transcriptCheck,
} from "./checks";
export {
  type AgentInfo,
  attempt,
  type DoctorDeps,
  type FileReader,
  failureOf,
  type Normalizer,
  type Redaction,
  type Residue,
  type ServerView,
} from "./deps";
export {
  distinctiveTerm,
  type GatherOptions,
  gatherEvidence,
  localEntry,
  retractedUploadId,
  type Target,
} from "./evidence";
export { type RealDepsOptions, realDeps, residueOf, ruleRedaction } from "./real";
export { serverView } from "./server";
export {
  type CheckResult,
  type CheckStatus,
  EVIDENCE_SCHEMA,
  type Failure,
  type LocalEntry,
  MAX_LOG_LINES,
  SEVERITY,
  type SearchEvidence,
  type ServerEvidence,
  type SessionEvidence,
  type TraceEvidence,
  type TranscriptFacts,
  worst,
} from "./types";
