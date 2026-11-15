/** What `seshi explore`'s API answers: JSON over GET, shared by the server (`api.ts`) and the
 * page (`page/`). Type-only imports, so the page's bundle carries none of the server's code. */

import type { CheckResult, CheckStatus, SessionEvidence } from "../doctor/types";

/** A check status, or `pending` while the full checks have not run yet. */
export type ListStatus = CheckStatus | "pending";

/** One row of the session list: what the state file and `decide` say, cheaply, and the worst
 * check status once the background checks reach it. */
export interface SessionSummary {
  agent: string;
  session_id: string;
  /** Where the agent ran last. */
  folder?: string;
  first_seen: string;
  last_seen?: string;
  /** `◉` capturing, `⏸` not (the status line's glyphs), with `decide`'s reason. */
  decision: { capture: boolean; glyph: string; level?: string; reason: string };
  /** The last answer's status (`stored`, `filtered`, …). */
  last_status?: string;
  /** The worst check status, and the first check at it. */
  worst: ListStatus;
  worst_check?: { id: string; title: string; summary: string };
  checked_at?: string;
}

export interface SessionList {
  since: string;
  server: { mode: "server" | "local" | "none"; where?: string; error?: string };
  sessions: SessionSummary[];
  /** How many sessions still wait for their checks. */
  pending: number;
  state_error?: string;
}

/** One session: its evidence (the stored traces' records left out, as `seshi doctor --json`
 * prints it; the records view has them) and its checks, failures first. */
export interface SessionDetail {
  evidence: SessionEvidence;
  checks: CheckResult[];
  worst: CheckStatus;
  glyph: string;
  timeline: TimelineEvent[];
}

export type TimelineKind =
  | "seen"
  | "spool"
  | "log"
  | "upload"
  | "error"
  | "change"
  | "review"
  | "toggle"
  | "pause"
  | "retraction"
  | "rebuild";

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  text: string;
}

/** Where a row sits in what was sent and kept. */
export type RowState =
  /** Local and stored agree. */
  | "same"
  /** Both have the record and they differ. */
  | "differs"
  /** Review dropped it from the first envelope; nothing stored. */
  | "dropped"
  /** Sent, but not in any stored trace. */
  | "missing"
  /** Past where the server's log ends: not sent (yet). */
  | "unsent"
  /** Past where a pause stopped the session: never sent. */
  | "frozen"
  /** Stored, with no local record at that index. */
  | "stored-only"
  /** Local only, with nothing stored to compare (no server, filtered, off). */
  | "local";

export interface RecordRow {
  index: number;
  state: RowState;
  /** The local record, re-normalized with the current adapter and redacted with the local
   * rules; never raw. */
  local?: unknown;
  /** The stored record, as the server stored it. */
  stored?: unknown;
  /** Which stored trace it came from (its position in the chain). */
  trace?: number;
  /** Redaction markers in the local and stored record, by rule. */
  markers?: Record<string, number>;
  /** The record is a withheld tool result. */
  withheld?: string;
}

/** The pipeline's stages for one session, with counts and gaps. */
export interface Pipeline {
  transcript: {
    bytes?: number;
    /** Transcript bytes sent, and where the server's log ends. */
    sent_bytes?: number;
    server_offset?: number;
    /** A pause stopped the session at this offset. */
    frozen_offset?: number;
    error?: string;
  };
  records: { count?: number; error?: string };
  redacted: {
    /** Records with a redaction marker. */
    records: number;
    markers: Record<string, number>;
    /** Tool results withheld (sensitive files, secret output). */
    withheld: number;
    rule_set: string;
    origin: string;
  };
  sent: {
    /** Local records up to where the server's log ends. */
    records?: number;
    /** The session filter, a toggle or a rule kept it back. */
    filtered?: boolean;
    last_status?: string;
  };
  stored: {
    records?: number;
    traces: number;
    /** Records review dropped from the first envelope. */
    dropped_prefix?: number;
    stub: boolean;
    withheld_calls?: number;
    status?: string;
  };
}

export interface RecordsView {
  pipeline: Pipeline;
  /** Index marks: the end of the review-dropped prefix, where a pause froze the session, where
   * the server's log ends. */
  marks: { dropped_until?: number; frozen_at?: number; sent_until?: number; stub: boolean };
  total: number;
  /** Rows matching the filter. */
  matching: number;
  offset: number;
  rows: RecordRow[];
  /** Counts by state over every row. */
  states: Partial<Record<RowState, number>>;
}

export type RowFilter = "all" | "mismatch" | "redacted" | "local" | "stored";
