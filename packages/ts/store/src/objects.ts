/** Typed accessors for the objects X6.4 adds beside the sessions: token records, source
 * checkpoints, the worker heartbeat, span-assembly pending markers and model review decisions.
 * Only the binary reads them, so their types are code-first here rather than generated from
 * `spec/schemas/` (X3.10). The branches that use them (05 tokens, 08 review, 09 assembly,
 * 06/10/11 workers and pollers) own their fields and may add to them.
 *
 * Mutable ones are written conditionally (X6.5): token records are created with If-None-Match,
 * checkpoints and pending-marker deletes use If-Match, so a second worker's write fails with
 * `PreconditionFailed` instead of overwriting (X7.3). */

import { randomBytes } from "node:crypto";
import type { Claims, OwnerBasis, Visibility } from "@seshi/model";
import { createJson, putJson, readJson, replaceJson, updateJson, type Versioned } from "./json";
import { assertOwner, keys } from "./layout";
import type { Store } from "./store";

// --- tokens -------------------------------------------------------------------

export const TOKEN_SCHEMA = "seshi/token/1" as const;

/** The kinds of stored token (X5.9). Session tokens are signed, not stored, and static tokens
 * live in config. */
export type TokenKind = "org" | "admin" | "device" | "service";

/** One seshi token (X5.9), stored by id and never in clear: `hash` is what the server compares
 * a presented token's hash with (`sha256:<hex>` of the whole token, `@seshi/auth`). */
export interface TokenRecord {
  schema: typeof TOKEN_SCHEMA;
  id: string;
  hash: string;
  /** `device`, `service`, `admin` or `org` (the org key). */
  kind: TokenKind;
  /** The person's owner id or `svc:<source-id>`; `*` for the org key, which has no owner (its
   * caller states one, X5.12). */
  owner: string;
  scopes: string[];
  /** A note for people listing tokens (`laptop`, `otlp destination`). */
  label?: string;
  /** Who created it: the admin, the exchange (X5.2) or `seshi admin init`. */
  created_by?: { kind: string; principal: string; credential_id?: string };
  /** A device token's machine, as the CLI names it (X5.2): signing in again from it renews the
   * token and revokes the old one. */
  machine?: { id: string; name?: string };
  /** Identity the IdP verified when the token was issued (email, name), copied into what the
   * token writes (X5.5). */
  claims?: Claims;
  /** The default visibility for what the token writes (X5.10). */
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

/** Token ids, in order, a page at a time. */
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

// --- checkpoints --------------------------------------------------------------

export const CHECKPOINT_SCHEMA = "seshi/checkpoint/1" as const;

/** A poller's position in its source: a time window, an API cursor or an S3 manifest. */
export interface Checkpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  source: string;
  updated_at: string;
  /** The poller's own state; its shape is the poller's. */
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

// --- worker heartbeat ---------------------------------------------------------

export const HEARTBEAT_SCHEMA = "seshi/heartbeat/1" as const;

/** What the worker writes every minute (X7.5); status reads it to spot a stopped worker, or a
 * second one (the instance id keeps changing). */
export interface Heartbeat {
  schema: typeof HEARTBEAT_SCHEMA;
  /** A random id per running process. */
  instance: string;
  version: string;
  roles: string[];
  started_at: string;
  at: string;
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

// --- span assembly ------------------------------------------------------------

export const PENDING_SCHEMA = "seshi/pending/1" as const;

/** `assembly/pending/<archive_id>`: a session has spans not yet assembled (X7.4). Touched on
 * every batch; the assembler deletes it with If-Match after publishing, so a batch that arrived
 * meanwhile leaves it in place. */
export interface PendingMarker {
  schema: typeof PENDING_SCHEMA;
  owner: string;
  archive_id: string;
  /** When the last batch arrived: the assembler waits for a quiet period after it (F4.4). */
  touched_at: string;
  /** Random per touch, so every touch changes the marker's ETag. Without it two touches in one
   * millisecond write the same bytes (the same MD5 ETag), and the assembler's If-Match delete
   * would clear a marker a batch touched after the assembler read it. */
  touch: string;
}

/** Record that `archive` has new spans; returns the marker's ETag. */
export function touchPending(
  store: Store,
  owner: string,
  archive: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const marker: PendingMarker = {
    schema: PENDING_SCHEMA,
    owner: assertOwner(owner),
    archive_id: archive,
    touched_at: now().toISOString(),
    touch: randomBytes(8).toString("hex"),
  };
  return putJson(store, keys.pending(archive), marker);
}

export function readPending(
  store: Store,
  archive: string,
): Promise<Versioned<PendingMarker> | null> {
  return readJson<PendingMarker>(store, keys.pending(archive));
}

/** Archive ids with pending spans, in order, a page at a time. */
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

// --- model review decisions ---------------------------------------------------

export const REVIEW_SCHEMA = "seshi/review/1" as const;

/** One finding of the redactor: where and what kind, never the matched text (F3.8). */
export interface ReviewFinding {
  /** The record's index in the trace. */
  record: number;
  /** The field the text was in (`content`, `tool_calls[0].args`, …). */
  field: string;
  category: string;
  /** `redact` the text, or `withhold` the whole tool result. */
  action: "redact" | "withhold";
}

/** `owners/<o>/sessions/<a>/review/<n>.json`: what model review decided for the `n`th write
 * that was stored (F3). Drops are recorded under `sources/<id>/dropped/` instead. */
export interface ReviewRecord {
  schema: typeof REVIEW_SCHEMA;
  n: number;
  at: string;
  /** The trace the write produced. */
  content_hash: string;
  policy: string;
  policy_hash: string;
  /** `allow`, `redact` (findings applied; possibly none), or `skipped` (review failed and
   * `on_failure = "skip"`, F3.4). */
  decision: "allow" | "redact" | "skipped";
  decision_model: string;
  redactor_model?: string;
  findings: ReviewFinding[];
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

/** Every review decision of a session, in order. */
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
