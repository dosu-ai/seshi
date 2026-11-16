import type { CheckResult, CheckStatus, SessionEvidence } from "../doctor/types";

export type ListStatus = CheckStatus | "pending";

export interface SessionSummary {
  agent: string;
  session_id: string;
  folder?: string;
  first_seen: string;
  last_seen?: string;
  decision: { capture: boolean; glyph: string; level?: string; reason: string };
  last_status?: string;
  worst: ListStatus;
  worst_check?: { id: string; title: string; summary: string };
  checked_at?: string;
}

export interface SessionList {
  since: string;
  server: { mode: "server" | "local" | "none"; where?: string; error?: string };
  sessions: SessionSummary[];
  pending: number;
  state_error?: string;
}

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

export type RowState =
  | "same"
  | "differs"
  | "dropped"
  | "missing"
  | "unsent"
  | "frozen"
  | "stored-only"
  | "local";

export interface RecordRow {
  index: number;
  state: RowState;
  local?: unknown;
  stored?: unknown;
  trace?: number;
  markers?: Record<string, number>;
  withheld?: string;
}

export interface Pipeline {
  transcript: {
    bytes?: number;
    sent_bytes?: number;
    server_offset?: number;
    frozen_offset?: number;
    error?: string;
  };
  records: { count?: number; error?: string };
  redacted: {
    records: number;
    markers: Record<string, number>;
    withheld: number;
    rule_set: string;
    origin: string;
  };
  sent: {
    records?: number;
    filtered?: boolean;
    last_status?: string;
  };
  stored: {
    records?: number;
    traces: number;
    dropped_prefix?: number;
    stub: boolean;
    withheld_calls?: number;
    status?: string;
  };
}

export interface RecordsView {
  pipeline: Pipeline;
  marks: { dropped_until?: number; frozen_at?: number; sent_until?: number; stub: boolean };
  total: number;
  matching: number;
  offset: number;
  rows: RecordRow[];
  states: Partial<Record<RowState, number>>;
}

export type RowFilter = "all" | "mismatch" | "redacted" | "local" | "stored";
