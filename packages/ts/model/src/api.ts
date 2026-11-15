/** The session API's types: what a client sends and gets back, whichever backend answers it (the
 * HTTP client in `@seshi/client`, or the pipeline over a store in `@seshi/pipeline`). They live
 * here, the lowest layer, so the HTTP client depends on nothing but this package (X3.2). */

import type { RenderedTrace, RenderFormat } from "./schemas/renders";
import type { ChangeEntry, RawFormat, SessionMetadata } from "./schemas/store";

/** The shape of `fetch` the HTTP client and the S3 driver need: a URL string and an init to a
 * `Response`. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Where a store is, as a reader would need to know it: never a secret. */
export interface StorageView {
  url: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
}

/** What earlier runs already shipped of a session. */
export interface ShippedPrefix {
  /** How many normalized records have shipped, from the start. */
  records: number;
  /** prefixSha256 of those records. */
  prefix_sha256: string;
}

/** A session to store, as the pipeline takes it. */
export interface SessionUpload {
  owner: string;
  /** The transcript's format name (`claude-code`, `codex`, …): one the deployment's format
   * registry knows. */
  agent: string;
  session_id: string;
  transcript: string;
  format: RawFormat;
  /** The byte offset of `transcript` in the session's log: 0 (the default) when it is the whole
   * log, else where the last upload ended, the `bytes_total` it answered. */
  offset?: number;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  fork_of?: string;
  /** What the client stored from the last answer for this session, if it was stored before. */
  shipped?: ShippedPrefix;
}

/** A session to store: `SessionUpload` without the owner, which the backend knows. `format`
 * defaults to `jsonl`. */
export type Upload = Omit<SessionUpload, "owner" | "format"> & { format?: SessionUpload["format"] };

export interface IngestResult {
  status: "stored" | "duplicate";
  archive_id: string;
  content_hash: string;
  session_id: string;
  records: number;
  events: number;
}

export type PutRawResult = { status: "stored" | "exists"; part: number };

/** What the client keeps after the call, whatever was written: its shipped prefix, and where
 * the next chunk starts. */
export interface ShippedState {
  records_total: number;
  prefix_sha256: string;
  /** Bytes of the log normalized so far: where the next chunk starts. */
  bytes_total: number;
}

export type NormalizeStoredResult =
  /** Stored, and nothing in it worth a trace: no head, or nothing new for it. */
  ({ status: "trivial" } & ShippedState) | (IngestResult & ShippedState);

export type StoreSessionResult = NormalizeStoredResult & { raw: PutRawResult };

/** A stored trace as it was asked for: the canonical trace, or a rendering of it. */
export type StoredTrace = RenderedTrace;

export interface ChangesPage {
  entries: { key: string; entry: ChangeEntry }[];
  /** Pass as `after` to continue. */
  cursor: string | undefined;
  truncated: boolean;
}

export interface ReadChangesOptions {
  /** The last key already processed; omit to start from the beginning. */
  after?: string;
  /** Alternative to `after`: start from this time (ISO 8601). Ignored when `after` is given. */
  since?: string;
  limit?: number;
}

export interface ListSessionsOptions {
  /** The cursor from the last page. */
  after?: string;
  limit?: number;
}

export interface SessionsPage {
  sessions: SessionMetadata[];
  cursor: string | undefined;
  truncated: boolean;
}

export interface Identity {
  owner: string;
  /** Where the sessions go, as a reader would need to know it. */
  storage: StorageView;
}

export interface SessionDB {
  /** Store a session, whole or as a chunk from `offset`. Throws `SessionRejected` for a
   * transcript that cannot be stored, `OffsetMismatch` for a chunk that does not start where
   * the log ends, `StoreError` when the store fails. */
  ingest(upload: Upload): Promise<StoreSessionResult>;
  /** The session's pointer, or null for one not stored. */
  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null>;
  /** The head trace, or the one named by `hash`, as the canonical trace (`seshi`, the default)
   * or rendered as `letta`, `otlp` or `atif`; null for a session not stored, stored raw only,
   * or redacted. */
  getTrace(
    agent: string,
    sessionId: string,
    hash?: string,
    format?: RenderFormat,
  ): Promise<StoredTrace | null>;
  listSessions(options?: ListSessionsOptions): Promise<SessionsPage>;
  /** Drop the session's objects and append a tombstone; null for one not stored. */
  tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null>;
  /** The change feed after a cursor. */
  changes(options?: ReadChangesOptions): Promise<ChangesPage>;
  /** Who this client is and where its sessions go. */
  me(): Promise<Identity>;
}
