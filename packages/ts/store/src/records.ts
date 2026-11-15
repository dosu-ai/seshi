/** Drop and failure records (X6.4): one per envelope that was not stored, saying that it
 * arrived and why, never what it contained. Both kinds share the base fields and live under
 * separate prefixes, so each is listed, counted and retained on its own:
 *
 * - `sources/<id>/dropped/`: model review dropped it, or review failed with
 *   `on_failure = "drop"` (F3.4); adds the policy, its hash and the decision model.
 * - `sources/<id>/failed/`: a permanent pipeline failure such as an unknown format or an
 *   adapter error (X4.8); adds the error code and message.
 *
 * Keys start with the time (`changeStamp`), so a listing is in time order and retention stops
 * at the first record young enough to keep. Uploads from hooks and the CLI use the source id
 * `upload`. Sessions removed by the session filter are only counted, never recorded. */

import type { SourceKind, SourceLocation } from "@seshi/model";
import { createJson, readJson } from "./json";
import { changeStamp, keys, type RecordKind, stampTime } from "./layout";
import { isPreconditionFailed, type Store } from "./store";

export const DROPPED_SCHEMA = "seshi/dropped/1" as const;
export const FAILED_SCHEMA = "seshi/failed/1" as const;

/** How long records are kept when config does not say: 30 days, as `[records]` defaults. */
export const DEFAULT_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What every record says. */
export interface RecordBase {
  /** When the envelope was given up on. */
  at: string;
  /** The source id (`upload` for hooks and the CLI). */
  source: string;
  /** How it arrived. */
  source_kind?: SourceKind;
  /** The owner the envelope resolved to, when it got that far. */
  owner?: string;
  /** The session as the source names it. */
  session_key?: string;
  /** The envelope's idempotency key (X4.7): what `seshi reprocess` asks the source for. */
  idempotency_key: string;
  /** Where in the source it was. */
  provenance?: SourceLocation;
}

export interface DroppedRecord extends RecordBase {
  schema: typeof DROPPED_SCHEMA;
  /** `review_drop` (the decision model said drop) or `review_failed` (F3.4). */
  reason: "review_drop" | "review_failed";
  policy: string;
  policy_hash: string;
  decision_model: string;
}

export interface FailedRecord extends RecordBase {
  schema: typeof FAILED_SCHEMA;
  /** The pipeline's error code (`unsupported_agent`, `too_large`, `invalid`, …). */
  code: string;
  /** What went wrong, in words; never content. */
  message: string;
}

export type DropOrFailure = DroppedRecord | FailedRecord;

/** Write a drop record; returns its key. Writing the same envelope twice at the same
 * millisecond is a no-op. */
export function writeDropped(store: Store, record: Omit<DroppedRecord, "schema">): Promise<string> {
  return write(store, "dropped", { schema: DROPPED_SCHEMA, ...record });
}

/** Write a failure record; returns its key. */
export function writeFailed(store: Store, record: Omit<FailedRecord, "schema">): Promise<string> {
  return write(store, "failed", { schema: FAILED_SCHEMA, ...record });
}

async function write(store: Store, kind: RecordKind, record: DropOrFailure): Promise<string> {
  const key = keys.record(kind, record.source, record.at, record.idempotency_key);
  try {
    await createJson(store, key, record);
  } catch (err) {
    if (!isPreconditionFailed(err)) throw err;
  }
  return key;
}

export interface ListRecordsOptions {
  /** The last key already seen. */
  after?: string;
  /** Only records at or after this time (ISO 8601). Ignored when `after` is given. */
  since?: string;
  limit?: number;
}

export interface RecordsPage<T> {
  records: { key: string; record: T }[];
  cursor: string | undefined;
  truncated: boolean;
}

/** A source's drop or failure records, oldest first, a page at a time. */
export async function listRecords<K extends RecordKind>(
  store: Store,
  kind: K,
  sourceId: string,
  options: ListRecordsOptions = {},
): Promise<RecordsPage<K extends "dropped" ? DroppedRecord : FailedRecord>> {
  type T = K extends "dropped" ? DroppedRecord : FailedRecord;
  const prefix = keys.records(kind, sourceId);
  // A key at `since` (`<stamp>-<hash>.json`) sorts after the bare stamp, so it is included.
  const startAfter =
    options.after ??
    (options.since !== undefined ? `${prefix}${changeStamp(options.since)}` : undefined);
  const page = await store.list(prefix, { startAfter, limit: options.limit });
  const records: { key: string; record: T }[] = [];
  for (const key of page.keys) {
    const found = await readJson<T>(store, key);
    if (found) records.push({ key, record: found.value });
  }
  return { records, cursor: page.keys.at(-1), truncated: page.truncated };
}

/** How many records a source has of one kind (a full listing; for status and source health). */
export async function countRecords(
  store: Store,
  kind: RecordKind,
  sourceId: string,
): Promise<number> {
  const prefix = keys.records(kind, sourceId);
  let count = 0;
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after });
    count += page.keys.length;
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return count;
  }
}

/** Delete a source's records of one kind older than `retentionMs` (config's
 * `records.dropped_retention` / `records.failed_retention`; 30 days by default). Keys are in
 * time order, so it stops at the first record young enough to keep. Returns how many it
 * deleted. */
export async function pruneRecords(
  store: Store,
  kind: RecordKind,
  sourceId: string,
  options: { retentionMs?: number; now?: () => Date } = {},
): Promise<number> {
  const retention = options.retentionMs ?? DEFAULT_RECORD_RETENTION_MS;
  const cutoff = (options.now ?? (() => new Date()))().getTime() - retention;
  const prefix = keys.records(kind, sourceId);
  let deleted = 0;
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after });
    for (const key of page.keys) {
      const at = stampTime(key.slice(prefix.length));
      if (at === null) continue;
      if (at >= cutoff) return deleted;
      await store.delete(key);
      deleted++;
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return deleted;
  }
}

/** The source ids that have records of either kind, from a listing of `sources/`. */
export async function sourcesWithRecords(store: Store): Promise<string[]> {
  const ids = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await store.list("sources/", { startAfter: after });
    for (const key of page.keys) {
      const m = /^sources\/([^/]+)\/(dropped|failed)\//.exec(key);
      if (m) ids.add(m[1] as string);
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return [...ids].sort();
  }
}
