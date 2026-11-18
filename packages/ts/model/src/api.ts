import type { ShippedPrefix } from "./generated/envelope";
import type { RenderedTrace, RenderFormat } from "./schemas/renders";
import type {
  CallerKind,
  ChangeEntry,
  Claims,
  OwnerBasis,
  RawFormat,
  SessionMetadata,
  Visibility,
} from "./schemas/store";

export type { ShippedPrefix };

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
  /** What the client stored from the last answer for this session, if it was stored before.
   * The server's own state decides whether a whole upload extends the session; this is read
   * only for a session that has none. */
  shipped?: ShippedPrefix;
  /** A whole upload that does not extend the session rewrites it instead of being refused
   * (`SessionConflict`, X4.6). Only the session's original writer or an admin may. */
  replace?: boolean;
  /** Rebuild the session from this whole log and review it again, even when the log only
   * extends what is stored (X4.9): a replace, which needs the same permission. Never a chunk.
   * Without an `idempotency_key` each rebuild gets a fresh one. */
  rebuild?: boolean;
  /** Identifies this upload across resends (X4.7); derived from the session, the offset and
   * the text when omitted. A resend with the same key gets the same answer. */
  idempotency_key?: string;
  /** Who may read a new session (X5.10); the deployment's default when omitted. */
  visibility?: Visibility;
  /** Identity the data asserts (X5.5): git email and name, account ids. Kept from a fixed
   * allowlist; never decides ownership (X5.4). */
  claims?: Claims;
  /** The sha256 (hex) of the uploading machine's retraction secret for this session (F9.7).
   * Kept on the session the first time one is sent; the machine that holds the secret can
   * then retract the session with its normal upload credential. */
  retract_hash?: string;
}

/** A session to store: `SessionUpload` without the owner, which the backend knows. `format`
 * defaults to `jsonl`. */
export type Upload = Omit<SessionUpload, "owner" | "format"> & { format?: SessionUpload["format"] };

/** How an upload is sent, beside what it stores. */
export interface IngestOptions {
  /** The session's retraction secret (F9.7), sent with a `replace`: an org-key caller (X5.12)
   * replaces a session only with the secret whose hash it was first uploaded with, since anyone
   * holding the key can state the username. Over HTTP it goes in `X-Seshi-Retract`, never the
   * body; it is never stored. */
  retractSecret?: string;
}

export interface IngestResult {
  status: "stored" | "duplicate";
  archive_id: string;
  content_hash: string;
  session_id: string;
  records: number;
  events: number;
}

/** What the client keeps after the call, whatever was written: its shipped prefix, and where
 * the next chunk starts. A session the server holds nothing of (`filtered`, or `dropped` before
 * it had a trace) answers zeros: the next upload is the whole log again (X6.3). */
export interface ShippedState {
  records_total: number;
  prefix_sha256: string;
  /** Bytes of the log normalized so far: where the next chunk starts. */
  bytes_total: number;
}

/** The longest idempotency key an envelope may carry (X4.7), in characters. A session keeps its
 * last keys in `metadata.json`, which every write reads, so a key is bounded; an S3 poller's
 * bucket, object key (up to 1024 bytes) and ETag fit. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 2048;

/** `prefix_sha256` of no records: what a session the server holds nothing of answers. */
export const EMPTY_PREFIX_SHA256 =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" as const;

/** Whether a session's pointer is a stub (F3.4, revised 15 Nov 2026): model review dropped the
 * session's first envelope, so the pointer holds where its log ends and who wrote it, and no
 * trace. A stub has no `head` and is `stored`: readers neither list nor serve it (a tombstoned
 * session has no `head` either, but is `redacted`). */
export function isStub(metadata: Pick<SessionMetadata, "head" | "status">): boolean {
  return metadata.status === "stored" && metadata.head === undefined;
}

/** What storing a session answered.
 *
 * - `stored`: a new trace is the session's head. `duplicate`: that trace was already stored.
 * - `unchanged`: the session has a trace (or a stub) and the upload added nothing to it (lines
 *   the adapter drops, or a whole log with nothing past what is stored); the log position moved
 *   on.
 * - `filtered`: the session filter judged the session's first trace not worth storing (X4.10).
 *   Nothing is stored; send the whole log again once it has grown.
 * - `dropped`: model review dropped it (F3). Nothing of it is stored; the log position moves
 *   past it. A session with no trace yet keeps only a stub that says where its log ends
 *   (`isStub`, F3.4), so the next upload is a chunk from there. */
export type StoreSessionResult =
  | ({ status: "unchanged" | "filtered" | "dropped" } & ShippedState)
  | (IngestResult & ShippedState);

/** A stored trace as it was asked for: the canonical trace, or a rendering of it. */
export type StoredTrace = RenderedTrace;

export interface ChangesPage {
  entries: { key: string; entry: ChangeEntry }[];
  /** Pass as `after` to continue. */
  cursor: string | undefined;
  truncated: boolean;
}

/** A page of the cross-owner change feed (`GET /v1/changes/all`): every owner's entries, by
 * stamp, then owner, then key. */
export interface AllChangesPage {
  entries: { owner: string; key: string; entry: ChangeEntry }[];
  /** Opaque. Pass as `after` to continue; absent when the page is empty. */
  cursor?: string;
  truncated: boolean;
  /** Every owner's feed had been read up to this time when the page was served: entries
   * stamped later wait until it moves past them. */
  through: string;
}

export interface ReadChangesOptions {
  /** The last key already processed (the cross-owner feed: the last page's `cursor`); omit
   * to start from the beginning. */
  after?: string;
  /** Alternative to `after`: start from this time (ISO 8601). Ignored when `after` is given. */
  since?: string;
  limit?: number;
}

export interface ListSessionsOptions {
  /** The cursor from the last page. */
  after?: string;
  limit?: number;
  /** Whose sessions: the caller's own when omitted. Another owner's sessions are listed as
   * far as visibility allows (X5.10). Only the HTTP backend reads it. */
  owner?: string;
}

export interface SessionsPage {
  sessions: SessionMetadata[];
  cursor: string | undefined;
  truncated: boolean;
}

/** A session of the caller's that an older normalizer built (X4.9): its format's adapter has
 * changed since, so the session should be sent again whole with `rebuild`. */
export interface StaleSession {
  /** The format it is filed under. */
  agent: string;
  session_id: string;
  /** The format version that built it (`normalizer.format_version`); absent when not recorded. */
  built_with?: string;
  /** The format's current normalizer version. */
  current: string;
}

export interface StaleSessionsPage {
  sessions: StaleSession[];
  /** Pass as `after` to continue. */
  cursor: string | undefined;
  /** More sessions to look through: a page can be empty and still be truncated. */
  truncated: boolean;
}

export interface Identity {
  owner: string;
  /** Where the sessions go, as a reader would need to know it. */
  storage: StorageView;
  /** Which kind of credential the caller holds (X5.1); the server says, local mode omits it. */
  kind?: CallerKind;
  /** `member`, `admin` or `service` (X5.3). */
  role?: "member" | "admin" | "service";
  /** What the credential may do (X5.3). */
  scopes?: string[];
  owner_basis?: OwnerBasis;
  /** The id of the token used, when it has one; never the secret. */
  credential_id?: string;
  /** The visibility what the caller writes gets when the request sets none (X5.10). */
  visibility?: Visibility;
  /** When the credential stops working, if it does. */
  expires_at?: string;
}

export interface SessionDB {
  /** Store a session, whole or as a chunk from `offset`. Throws `SessionRejected` for a
   * transcript that cannot be stored, `OffsetMismatch` for a chunk that does not start where
   * the log ends, `Forbidden` for a `replace` the caller may not make, `StoreError` when the
   * store fails. */
  ingest(upload: Upload, options?: IngestOptions): Promise<StoreSessionResult>;
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
  /** The caller's own sessions an older normalizer built (X4.9), a page at a time. */
  staleSessions(options?: { after?: string; limit?: number }): Promise<StaleSessionsPage>;
  /** Drop the session's objects and append a tombstone; null for one not stored. */
  tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null>;
  /** The change feed after a cursor. */
  changes(options?: ReadChangesOptions): Promise<ChangesPage>;
  /** Who this client is and where its sessions go. */
  me(): Promise<Identity>;
}
