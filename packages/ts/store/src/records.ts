import type { SourceKind, SourceLocation } from "@seshi/model";
import { createJson, readJson } from "./json";
import { changeStamp, keys, type RecordKind, stampTime } from "./layout";
import type { ReviewFailure } from "./objects";
import { isPreconditionFailed, type Store } from "./store";

export const DROPPED_SCHEMA = "seshi/dropped/1" as const;
export const FAILED_SCHEMA = "seshi/failed/1" as const;

export const DEFAULT_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RecordBase {
  at: string;
  /** The source id (`upload` for hooks and the CLI). */
  source: string;
  source_kind?: SourceKind;
  /** The owner the envelope resolved to, when it got that far. */
  owner?: string;
  session_key?: string;
  idempotency_key: string;
  provenance?: SourceLocation;
}

export interface DroppedRecord extends RecordBase {
  schema: typeof DROPPED_SCHEMA;
  /** `review_drop` (the decision model said drop) or `review_failed` (F3.4). */
  reason: "review_drop" | "review_failed";
  policy: string;
  policy_hash: string;
  decision_model: string;
  /** The redactor, when the drop came from its step failing. */
  redactor_model?: string;
  /** For `review_failed`: which step failed and how (F3.4, F3.8); never content. */
  failure?: ReviewFailure;
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
