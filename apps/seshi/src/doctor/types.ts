import type { CaptureState, Decision, SessionState } from "@seshi/capture";
import type { ReviewDecision } from "@seshi/client";
import type { ChangeEntry, NormalizedRecord, SessionMetadata } from "@seshi/model";

export const EVIDENCE_SCHEMA = "seshi/doctor-evidence/1";

export interface Failure {
  code: string;
  message: string;
}

export type SecretlessStateEntry = Omit<SessionState, "secret"> & {
  secret?: { present: true; sha256: string };
};

export interface TranscriptFacts {
  path?: string;
  exists: boolean;
  size?: number;
  mtime?: string;
  identified_as?: string;
  error?: Failure;
  /** The file the uploader sends in its place, for an agent that adds to its transcript what its
   * hooks kept (Cursor's tool results): offsets and records are its. */
  uploaded?: { path: string; size: number };
}

/** The file whose bytes were sent for the session, and its size: the transcript, or the upload
 * composed from it. */
export function sentFile(t: TranscriptFacts): { path?: string; size: number } {
  return t.uploaded ?? { ...(t.path ? { path: t.path } : {}), size: t.size ?? 0 };
}

export interface SpoolFact {
  name: string;
  kind: string;
  at: string;
  event?: string;
}

export interface TraceEvidence {
  content_hash: string;
  listed_records: number;
  rule_set?: string;
  continuation?: { from_record: number; prefix_sha256: string };
  fetched: boolean;
  record_count?: number;
  starts_with_meta?: boolean;
  stored_hash?: string;
  records?: NormalizedRecord[];
  error?: Failure;
}

export interface ServerEvidence {
  mode: "server" | "serverless" | "none";
  where?: string;
  error?: Failure & { exit?: number };
  upload_id?: string;
  /** The format the server files the session under. */
  format?: string;
  metadata?: SessionMetadata | null;
  metadata_error?: Failure;
  pointer?: SessionMetadata | null;
  sees_stubs: boolean;
  retracted?: { upload_id: string; metadata: SessionMetadata | null; error?: Failure };
  traces: TraceEvidence[];
  reviews?: ReviewDecision[] | null;
  reviews_error?: Failure;
  changes?: { key: string; entry: ChangeEntry }[];
  changes_error?: Failure;
  search?: SearchEvidence;
}

export interface SearchEvidence {
  upload_id: string;
  expect: "found" | "absent";
  term?: string;
  term_from?: "stored trace" | "transcript";
  found?: boolean;
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
  at: string;
  agent: string;
  session_id: string;
  key: string;
  machine: MachineEvidence;
  local?: SecretlessStateEntry;
  parent?: { session_id: string; known: boolean };
  decision?: Decision;
  transcript: TranscriptFacts;
  spool: { entries: SpoolFact[]; error?: Failure };
  log: { lines: string[]; error?: Failure };
  server: ServerEvidence;
  capture?: { format: string; encoding: "jsonl" | "json"; chunkable: boolean };
}

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  detail?: string[];
  hint?: string;
}

export const SEVERITY: Readonly<Record<CheckStatus, number>> = { skip: 0, ok: 1, warn: 2, fail: 3 };

export function worst(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "skip");
}

export const MAX_LOG_LINES = 50;
