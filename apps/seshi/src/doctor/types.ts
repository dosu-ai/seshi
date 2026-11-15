/** The data model of `seshi doctor` and, later, `seshi explore`: what is known about one
 * captured session from its three views, and what the checks make of it.
 *
 * - (a) the raw transcript on this machine (`transcript`);
 * - (b) this machine's capture state: the state file's entry, the decision and why, the spool,
 *   the uploader's log lines (`local`, `decision`, `spool`, `log`, `machine`);
 * - (c) what the server, or the local bucket, stored (`server`).
 *
 * Only a laptop holds all three, so the doctor runs there. `SessionEvidence` is plain JSON (a UI
 * renders it as it is); `CheckResult`s are computed from it alone plus the loaders in
 * `DoctorDeps`, so a test fakes every one. Nothing here reads a file or the network. */

import type { CaptureState, Decision, SessionState } from "@seshi/capture";
import type { ReviewDecision } from "@seshi/client";
import type { ChangeEntry, NormalizedRecord, SessionMetadata } from "@seshi/model";

export const EVIDENCE_SCHEMA = "seshi/doctor-evidence/1";

/** A part the doctor could not fetch: recorded in the evidence, never thrown. */
export interface Failure {
  code: string;
  message: string;
}

/** The state file's entry for the session, without the retraction secret (which never leaves
 * the machine, not even in `--json`); `secret` says whether there is one and its hash, which is
 * what the server keeps (`metadata.retract_hash`). */
export type LocalEntry = Omit<SessionState, "secret"> & {
  secret?: { present: true; sha256: string };
};

export interface TranscriptFacts {
  path?: string;
  exists: boolean;
  size?: number;
  mtime?: string;
  /** Who the agent says the file belongs to (`identify` on its head): the uploader refuses to
   * send a file that is not this session's. Undefined when it could not tell. */
  identified_as?: string;
  error?: Failure;
}

export interface SpoolFact {
  name: string;
  kind: string;
  at: string;
  event?: string;
}

/** One trace the session's metadata names, as fetched. `records` is the canonical records
 * themselves (the residue and search checks read them); `seshi doctor --json` leaves them out. */
export interface TraceEvidence {
  content_hash: string;
  /** From `metadata.traces`. */
  listed_records: number;
  rule_set?: string;
  continuation?: { from_record: number; prefix_sha256: string };
  fetched: boolean;
  /** Records in the fetched trace. */
  record_count?: number;
  /** Its first record is a meta record. */
  starts_with_meta?: boolean;
  /** The `content_hash` the fetched object says it has. */
  stored_hash?: string;
  records?: NormalizedRecord[];
  error?: Failure;
}

export interface ServerEvidence {
  /** Where the doctor asked: a server, the local bucket (local mode), or nowhere. */
  mode: "server" | "local" | "none";
  where?: string;
  /** Why it could not ask at all (not signed in, the config, the server unreachable). */
  error?: Failure & { exit?: number };
  /** The session id it asked for: the agent's own, or `<id>~<n>` after retractions. */
  upload_id?: string;
  /** The server's agent (the capture agent's format). */
  agent?: string;
  /** `GET /v1/sessions/:agent/:id`; null when the server holds nothing it will show. */
  metadata?: SessionMetadata | null;
  metadata_error?: Failure;
  /** The pointer as stored, stubs included (local mode reads the bucket; a server never serves
   * a stub, so this is absent there). */
  pointer?: SessionMetadata | null;
  /** Whether a stub can be seen at all here. */
  sees_stubs: boolean;
  /** The upload id before the last retraction, and what the server holds of it. */
  retracted?: { upload_id: string; metadata: SessionMetadata | null; error?: Failure };
  traces: TraceEvidence[];
  reviews?: ReviewDecision[] | null;
  reviews_error?: Failure;
  /** The owner's change entries for this session (since it was created). */
  changes?: { key: string; entry: ChangeEntry }[];
  changes_error?: Failure;
  /** `--deep`: a search for a distinctive term from the session. */
  search?: SearchEvidence;
}

export interface SearchEvidence {
  /** Which upload id it looked for, and whether that session should be found. */
  upload_id: string;
  expect: "found" | "absent";
  term?: string;
  /** Where the term came from. */
  term_from?: "stored trace" | "transcript";
  found?: boolean;
  /** Results of the query (any session). */
  results?: number;
  index_caught_up_at?: string;
  error?: Failure;
}

export interface MachineEvidence {
  state_error?: Failure;
  paused?: CaptureState["paused"];
  problems?: CaptureState["problems"];
  uploader?: CaptureState["uploader"] & { running: boolean };
}

export interface SessionEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  /** When it was gathered. */
  at: string;
  /** The capture agent (`claude-code`, `codex`, `cursor`). */
  agent: string;
  session_id: string;
  /** The state file's key. */
  key: string;
  machine: MachineEvidence;
  /** The state file's entry; absent for a session this machine never saw. */
  local?: LocalEntry;
  /** The entry's parent, when it is a subagent. */
  parent?: { session_id: string; known: boolean };
  /** What `decide` says now, with the same inputs every caller uses. */
  decision?: Decision;
  transcript: TranscriptFacts;
  spool: { entries: SpoolFact[]; error?: Failure };
  /** The capture log's lines that name the session, oldest first (at most `MAX_LOG_LINES`). */
  log: { lines: string[]; error?: Failure };
  server: ServerEvidence;
  /** What the decision and the transcript need to be read: the agent's encoding and whether
   * it is sent in chunks; absent for an agent this binary does not capture. */
  capture?: { format: string; encoding: "jsonl" | "json"; chunkable: boolean };
}

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** One line. */
  summary: string;
  /** More lines, when there is more to say. */
  detail?: string[];
  /** What to do about it. */
  hint?: string;
}

/** How bad a status is, for the worst of several. */
export const SEVERITY: Readonly<Record<CheckStatus, number>> = { skip: 0, ok: 1, warn: 2, fail: 3 };

export function worst(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "skip");
}

export const MAX_LOG_LINES = 50;
