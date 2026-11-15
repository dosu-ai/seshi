/** The key layout: the contract between every writer and every reader. See `spec/layout.md`.
 *
 * ```
 * seshi.json                                                   layout marker (X1.4)
 * tokens/<id>.json                                             hashed seshi tokens (X5.9)
 * sources/<source_id>/checkpoint.json                          poller cursor (X7)
 * sources/<source_id>/dropped/<stamp>-<key_hash>.json          envelopes review dropped (X6.4)
 * sources/<source_id>/failed/<stamp>-<key_hash>.json           envelopes that failed (X4.8)
 * worker/heartbeat.json                                        the worker's last run (X7.5)
 * assembly/pending/<archive_id>                                sessions with new spans (X7.4)
 * owners/<owner>/.probe                                        a writer's write check
 * owners/<owner>/sessions/<archive_id>/metadata.json           the session's pointer
 * owners/<owner>/sessions/<archive_id>/trace.<content_hash>.json.gz   seshi/trace/1
 * owners/<owner>/sessions/<archive_id>/raw.<n>.<jsonl|json>.gz        raw part (until 04)
 * owners/<owner>/sessions/<archive_id>/spans/<trace_id>-<span_id>.json   span records (F4)
 * owners/<owner>/sessions/<archive_id>/review/<n>.json         model review decisions (F3)
 * owners/<owner>/changes/<stamp>-<content_hash|tombstone|visibility>.json   change feed
 * ```
 *
 * Every segment a caller supplies is checked here, so no key can escape its folder. */

import { createHash } from "node:crypto";
import type { ChangeKind, RawFormat } from "@seshi/model";
import { StoreError } from "./store";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A configured source's id, as `@seshi/config` accepts them, or `upload`. */
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;

/** An owner name is one path segment: letters, digits, `.`, `_`, `-`. */
export function assertOwner(owner: string): string {
  if (!OWNER.test(owner)) throw new StoreError(`invalid owner: ${JSON.stringify(owner)}`);
  return owner;
}

export function assertSourceId(id: string): string {
  if (!SOURCE_ID.test(id) || id.length > 64) {
    throw new StoreError(`invalid source id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function assertTokenId(id: string): string {
  if (!TOKEN_ID.test(id)) throw new StoreError(`invalid token id: ${JSON.stringify(id)}`);
  return id;
}

/** An archive id or content hash: 64 lowercase hex characters. */
export function assertHash(value: string, what = "hash"): string {
  if (!HEX64.test(value)) throw new StoreError(`invalid ${what}: ${JSON.stringify(value)}`);
  return value;
}

function assertSpanKey(traceId: string, spanId: string): string {
  if (!HEX.test(traceId) || !HEX.test(spanId) || traceId.length > 32 || spanId.length > 16) {
    throw new StoreError(`invalid span id: ${traceId}/${spanId}`);
  }
  return `${traceId}-${spanId}`;
}

/** `sha256(owner + "\n" + agent + "\n" + session_id)`: deterministic, so every upload for one
 * session lands in one directory; derived, so no native id or path appears in a key. */
export function archiveId(owner: string, agent: string, sessionId: string): string {
  return createHash("sha256").update(`${owner}\n${agent}\n${sessionId}`, "utf8").digest("hex");
}

/** The seshi layout marker. */
export const LAYOUT_KEY = "seshi.json";
/** The marker a sessiondb (pre-seshi) prefix holds; seshi refuses such a prefix (X1.5). */
export const LEGACY_LAYOUT_KEY = "sessionstorage.json";

/** Drop and failure records: one per envelope that was not stored (X6.4). */
export type RecordKind = "dropped" | "failed";

/** Review decisions are numbered from 0 and zero-padded, so a listing is in order. */
const REVIEW_DIGITS = 8;

export const keys = {
  marker: () => LAYOUT_KEY,
  tokens: () => "tokens/",
  token: (id: string) => `tokens/${assertTokenId(id)}.json`,
  source: (id: string) => `sources/${assertSourceId(id)}/`,
  checkpoint: (id: string) => `${keys.source(id)}checkpoint.json`,
  records: (kind: RecordKind, sourceId: string) => `${keys.source(sourceId)}${kind}/`,
  record: (kind: RecordKind, sourceId: string, at: string, idempotencyKey: string) =>
    `${keys.records(kind, sourceId)}${changeStamp(at)}-${recordKeyHash(idempotencyKey)}.json`,
  heartbeat: () => "worker/heartbeat.json",
  pendingAll: () => "assembly/pending/",
  pending: (archive: string) => `assembly/pending/${assertHash(archive, "archive id")}`,
  owner: (owner: string) => `owners/${assertOwner(owner)}`,
  probe: (owner: string) => `${keys.owner(owner)}/.probe`,
  session: (owner: string, archive: string) =>
    `${keys.owner(owner)}/sessions/${assertHash(archive, "archive id")}`,
  sessions: (owner: string) => `${keys.owner(owner)}/sessions/`,
  metadata: (owner: string, archive: string) => `${keys.session(owner, archive)}/metadata.json`,
  trace: (owner: string, archive: string, hash: string) =>
    `${keys.session(owner, archive)}/trace.${assertHash(hash, "content hash")}.json.gz`,
  raw: (owner: string, archive: string, part: number, format: RawFormat) =>
    `${keys.session(owner, archive)}/raw.${part}.${format}.gz`,
  spans: (owner: string, archive: string) => `${keys.session(owner, archive)}/spans/`,
  span: (owner: string, archive: string, traceId: string, spanId: string) =>
    `${keys.spans(owner, archive)}${assertSpanKey(traceId, spanId)}.json`,
  reviews: (owner: string, archive: string) => `${keys.session(owner, archive)}/review/`,
  review: (owner: string, archive: string, n: number) => {
    if (!Number.isInteger(n) || n < 0 || n >= 10 ** REVIEW_DIGITS) {
      throw new StoreError(`invalid review number: ${n}`);
    }
    return `${keys.reviews(owner, archive)}${String(n).padStart(REVIEW_DIGITS, "0")}.json`;
  },
  changes: (owner: string) => `${keys.owner(owner)}/changes/`,
  change: (owner: string, at: string, kind: ChangeKind, hash: string | null) =>
    `${keys.changes(owner)}${changeStamp(at)}-${changeSuffix(kind, hash)}.json`,
} as const;

/** A change key's last segment: the trace's hash for a publish, else the kind. */
function changeSuffix(kind: ChangeKind, hash: string | null): string {
  if (kind === "tombstone") return "tombstone";
  if (kind === "visibility_changed") return "visibility";
  if (hash === null) throw new StoreError("a published change names its trace");
  return assertHash(hash, "content hash");
}

/** The change-key timestamp: RFC 3339 UTC to the millisecond with `:` dropped, so keys sort by
 * time and are valid on every filesystem. `2026-10-21T21:04:05.123Z` → `20261021T210405.123Z`. */
export function changeStamp(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new StoreError(`invalid timestamp: ${at}`);
  return d.toISOString().replaceAll("-", "").replaceAll(":", "");
}

/** The time a stamp (`changeStamp`) stands for, in epoch ms; null for a key that does not start
 * with one. */
export function stampTime(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z/.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms),
  );
}

/** A record's key segment for an idempotency key: its sha256, shortened. The key itself may hold
 * object keys or session ids, so it never appears in a key. */
export function recordKeyHash(idempotencyKey: string): string {
  if (idempotencyKey === "") throw new StoreError("an idempotency key is required");
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 24);
}
