import { randomBytes } from "node:crypto";
import type { Claims, Envelope, OwnerBasis, Visibility } from "@seshi/model";
import { createJson, putJson, readJson, replaceJson, updateJson, type Versioned } from "./json";
import { assertOwner, keys } from "./layout";
import type { Store } from "./store";

export const TOKEN_SCHEMA = "seshi/token/1" as const;

export type TokenKind = "org" | "admin" | "device" | "service";

/** One seshi token (X5.9), stored by id and never in clear: `hash` is what the server compares
 * a presented token's hash with (`sha256:<hex>` of the whole token, `@seshi/auth`). */
export interface TokenRecord {
  schema: typeof TOKEN_SCHEMA;
  id: string;
  hash: string;
  kind: TokenKind;
  /** The person's owner id or `svc:<source-id>`; `*` for the org key, which has no owner (its
   * caller states one, X5.12). */
  owner: string;
  scopes: string[];
  label?: string;
  created_by?: { kind: string; principal: string; credential_id?: string };
  machine?: { id: string; name?: string };
  claims?: Claims;
  visibility?: Visibility;
  owner_basis?: OwnerBasis;
  created_at: string;
  /** Null for a token that does not expire. */
  expires_at: string | null;
  revoked: boolean;
  revoked_at?: string;
  [key: string]: unknown;
}

export function readToken(store: Store, id: string): Promise<Versioned<TokenRecord> | null> {
  return readJson<TokenRecord>(store, keys.token(id));
}

/** Store a new token record; `PreconditionFailed` when the id is taken (If-None-Match). */
export function createToken(store: Store, record: TokenRecord): Promise<string> {
  return createJson(store, keys.token(record.id), record);
}

/** Change a token record (revoke it, renew it) with If-Match and retry; `step` returns null to
 * leave it alone. Null when there is no such token. */
export async function updateToken(
  store: Store,
  id: string,
  step: (current: TokenRecord) => TokenRecord | null,
): Promise<TokenRecord | null> {
  const result = await updateJson<TokenRecord>(store, keys.token(id), (current) =>
    current === null ? null : step(current),
  );
  return result.value;
}

export async function listTokens(
  store: Store,
  options: { after?: string; limit?: number } = {},
): Promise<{ ids: string[]; cursor: string | undefined; truncated: boolean }> {
  const prefix = keys.tokens();
  const page = await store.list(prefix, {
    startAfter: options.after === undefined ? undefined : keys.token(options.after),
    limit: options.limit,
  });
  const ids = page.keys
    .filter((k) => k.endsWith(".json"))
    .map((k) => k.slice(prefix.length, -".json".length));
  return { ids, cursor: ids.at(-1), truncated: page.truncated };
}

export const CHECKPOINT_SCHEMA = "seshi/checkpoint/1" as const;

export interface Checkpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  source: string;
  updated_at: string;
  cursor: Record<string, unknown>;
}

export function readCheckpoint(
  store: Store,
  sourceId: string,
): Promise<Versioned<Checkpoint> | null> {
  return readJson<Checkpoint>(store, keys.checkpoint(sourceId));
}

/** Save a checkpoint over the version read at `etag` (If-Match), or as the first one when
 * `etag` is null (If-None-Match). A `PreconditionFailed` means another worker moved it: discard
 * the run (X7.3). Returns the new ETag. */
export function writeCheckpoint(
  store: Store,
  sourceId: string,
  cursor: Record<string, unknown>,
  etag: string | null,
  now: () => Date = () => new Date(),
): Promise<string> {
  const checkpoint: Checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    source: sourceId,
    updated_at: now().toISOString(),
    cursor,
  };
  const key = keys.checkpoint(sourceId);
  return etag === null
    ? createJson(store, key, checkpoint)
    : replaceJson(store, key, checkpoint, etag);
}

/** Remove a checkpoint as read at `etag` (If-Match), so the source's next run starts as its
 * first did (`seshi reprocess`, X4.9). `PreconditionFailed` when a run moved it since. */
export function deleteCheckpoint(store: Store, sourceId: string, etag: string): Promise<void> {
  return store.delete(keys.checkpoint(sourceId), { ifMatch: etag });
}

export const HEARTBEAT_SCHEMA = "seshi/heartbeat/1" as const;

export interface JobRecord {
  last_started?: string;
  last_finished?: string;
  /** `ok`, `error`, or `discarded` (another worker moved its checkpoint, X7.3). */
  last_outcome?: "ok" | "error" | "discarded";
  last_ok?: string;
  /** Its last error, with when it happened; kept until a later run succeeds. */
  last_error?: { at: string; message: string };
  runs: number;
  failures: number;
  last_summary?: Record<string, number>;
}

export interface Heartbeat {
  schema: typeof HEARTBEAT_SCHEMA;
  /** The writing process: unique per run (`<instance id>-<random>`). */
  instance: string;
  host?: string;
  version: string;
  roles: string[];
  started_at: string;
  at: string;
  /** How often it writes, in milliseconds: status calls a heartbeat older than three of these
   * stopped. */
  interval_ms?: number;
  jobs?: Record<string, JobRecord>;
  others?: { instance: string; at: string }[];
}
export function readHeartbeat(store: Store): Promise<Versioned<Heartbeat> | null> {
  return readJson<Heartbeat>(store, keys.heartbeat());
}

/** Last writer wins: the heartbeat says who ran last. */
export function writeHeartbeat(
  store: Store,
  heartbeat: Omit<Heartbeat, "schema">,
): Promise<string> {
  return putJson(store, keys.heartbeat(), { schema: HEARTBEAT_SCHEMA, ...heartbeat });
}

export const PENDING_SCHEMA = "seshi/pending/1" as const;

export interface PendingMarker {
  schema: typeof PENDING_SCHEMA;
  owner: string;
  archive_id: string;
  touched_at: string;
  touch: string;
  source_id?: string;
  envelope?: PendingEnvelope;
  final?: boolean;
}

export type PendingEnvelope = Omit<Envelope, "payload">;

export interface PendingDetails {
  source_id?: string;
  envelope?: PendingEnvelope;
  final?: boolean;
}

/** Record that `archive` has new spans; returns the marker's ETag. */
export function touchPending(
  store: Store,
  owner: string,
  archive: string,
  now: () => Date = () => new Date(),
  details: PendingDetails = {},
): Promise<string> {
  const marker: PendingMarker = {
    schema: PENDING_SCHEMA,
    owner: assertOwner(owner),
    archive_id: archive,
    touched_at: now().toISOString(),
    touch: randomBytes(8).toString("hex"),
    ...(details.source_id ? { source_id: details.source_id } : {}),
    ...(details.envelope ? { envelope: details.envelope } : {}),
    ...(details.final ? { final: true } : {}),
  };
  return putJson(store, keys.pending(archive), marker);
}

export function readPending(
  store: Store,
  archive: string,
): Promise<Versioned<PendingMarker> | null> {
  return readJson<PendingMarker>(store, keys.pending(archive));
}

export async function listPending(
  store: Store,
  options: { after?: string; limit?: number } = {},
): Promise<{ archives: string[]; cursor: string | undefined; truncated: boolean }> {
  const prefix = keys.pendingAll();
  const page = await store.list(prefix, {
    startAfter: options.after === undefined ? undefined : keys.pending(options.after),
    limit: options.limit,
  });
  const archives = page.keys.map((k) => k.slice(prefix.length));
  return { archives, cursor: archives.at(-1), truncated: page.truncated };
}

/** Remove the marker as read at `etag` (If-Match); `PreconditionFailed` when a batch touched it
 * since, which keeps it for the next pass. */
export function clearPending(store: Store, archive: string, etag: string): Promise<void> {
  return store.delete(keys.pending(archive), { ifMatch: etag });
}

export const REVIEW_SCHEMA = "seshi/review/1" as const;

export interface ReviewFinding {
  /** The record's index in the trace. */
  record: number;
  field: string;
  category: string;
  action: "redact" | "withhold";
}

export interface ReviewRecord {
  schema: typeof REVIEW_SCHEMA;
  n: number;
  at: string;
  content_hash: string;
  policy: string;
  policy_hash: string;
  /** `allow`, `redact` (findings applied; possibly none), or `skipped` (review failed and
   * `on_failure = "skip"`, F3.4). */
  decision: "allow" | "redact" | "skipped";
  decision_model: string;
  redactor_model?: string;
  findings: ReviewFinding[];
  /** Findings the redactor returned that named no text of the envelope (a record or field it
   * was not given, or text that is not there), so nothing was removed for them. */
  unmatched?: number;
  /** How many parts the envelope was split into to fit the model's input (F3.7). */
  parts?: number;
  failure?: ReviewFailure;
}

export interface ReviewFailure {
  step: "decision" | "redactor";
  /** `timeout`, `network`, `http_<status>`, `invalid_answer`, `refusal`, `truncated`, … */
  code: string;
  /** Calls made, the retries included. */
  attempts: number;
}

/** Store the decision for write `n`; `PreconditionFailed` when `n` is taken. */
export function writeReview(
  store: Store,
  owner: string,
  archive: string,
  record: Omit<ReviewRecord, "schema">,
): Promise<string> {
  return createJson(store, keys.review(owner, archive, record.n), {
    schema: REVIEW_SCHEMA,
    ...record,
  });
}

export async function listReviews(
  store: Store,
  owner: string,
  archive: string,
): Promise<ReviewRecord[]> {
  const prefix = keys.reviews(owner, archive);
  const out: ReviewRecord[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after });
    for (const key of page.keys) {
      const found = await readJson<ReviewRecord>(store, key);
      if (found) out.push(found.value);
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return out;
  }
}
