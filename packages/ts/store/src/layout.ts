import { createHash, randomBytes } from "node:crypto";
import type { ChangeKind } from "@seshi/model";
import { StoreError } from "./store";

const PERSON_OWNER = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const SERVICE_OWNER = /^svc:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const CHANGE_SUFFIX = /^[0-9a-f]{8}$/;

export function assertOwner(owner: string): string {
  const ok = PERSON_OWNER.test(owner) || (SERVICE_OWNER.test(owner) && owner.length <= 4 + 64);
  if (!ok) throw new StoreError(`invalid owner: ${JSON.stringify(owner)}`);
  return owner;
}

export function isOwner(owner: string): boolean {
  try {
    assertOwner(owner);
    return true;
  } catch {
    return false;
  }
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

export function assertInstanceId(id: string): string {
  if (!INSTANCE_ID.test(id)) throw new StoreError(`invalid instance id: ${JSON.stringify(id)}`);
  return id;
}

export function assertDay(day: string): string {
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new StoreError(`invalid day: ${JSON.stringify(day)}`);
  }
  return day;
}

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

/** `sha256(owner + "\n" + format + "\n" + session_id)`, `format` being the format the session
 * is filed under. */
export function archiveId(owner: string, format: string, sessionId: string): string {
  return createHash("sha256").update(`${owner}\n${format}\n${sessionId}`, "utf8").digest("hex");
}

export const LAYOUT_KEY = "seshi.json";
export const LEGACY_LAYOUT_KEY = "sessionstorage.json";

export const PAST_FOLDER = "\u{10FFFF}";

export type RecordKind = "dropped" | "failed";

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
  healthAll: (sourceId: string) => `${keys.source(sourceId)}health/`,
  healthDay: (sourceId: string, day: string) => `${keys.healthAll(sourceId)}${assertDay(day)}/`,
  health: (sourceId: string, day: string, instance: string) =>
    `${keys.healthDay(sourceId, day)}${assertInstanceId(instance)}.json`,
  heartbeat: () => "worker/heartbeat.json",
  pendingAll: () => "assembly/pending/",
  pending: (archive: string) => `assembly/pending/${assertHash(archive, "archive id")}`,
  owners: () => "owners/",
  owner: (owner: string) => `owners/${assertOwner(owner)}`,
  probe: (owner: string) => `${keys.owner(owner)}/.probe`,
  session: (owner: string, archive: string) =>
    `${keys.owner(owner)}/sessions/${assertHash(archive, "archive id")}`,
  sessions: (owner: string) => `${keys.owner(owner)}/sessions/`,
  metadata: (owner: string, archive: string) => `${keys.session(owner, archive)}/metadata.json`,
  trace: (owner: string, archive: string, hash: string) =>
    `${keys.session(owner, archive)}/trace.${assertHash(hash, "content hash")}.json.gz`,
  spans: (owner: string, archive: string) => `${keys.session(owner, archive)}/spans/`,
  span: (owner: string, archive: string, traceId: string, spanId: string) =>
    `${keys.spans(owner, archive)}${assertSpanKey(traceId, spanId)}.json`,
  spanMessages: (owner: string, archive: string) => `${keys.spans(owner, archive)}messages/`,
  spanMessage: (owner: string, archive: string, hash: string) =>
    `${keys.spanMessages(owner, archive)}${assertHash(hash, "message hash")}.json`,
  reviews: (owner: string, archive: string) => `${keys.session(owner, archive)}/review/`,
  review: (owner: string, archive: string, n: number) => {
    if (!Number.isInteger(n) || n < 0 || n >= 10 ** REVIEW_DIGITS) {
      throw new StoreError(`invalid review number: ${n}`);
    }
    return `${keys.reviews(owner, archive)}${String(n).padStart(REVIEW_DIGITS, "0")}.json`;
  },
  changes: (owner: string) => `${keys.owner(owner)}/changes/`,
  change: (
    owner: string,
    at: string,
    archive: string,
    suffix: string,
    kind: ChangeKind,
    hash: string | null,
  ) =>
    `${keys.changes(owner)}${changeStamp(at)}-${assertHash(archive, "archive id")}-${assertChangeSuffix(suffix)}-${changeWhat(kind, hash)}.json`,
} as const;

function changeWhat(kind: ChangeKind, hash: string | null): string {
  if (kind === "tombstone") return "tombstone";
  if (kind === "visibility_changed") return "visibility";
  if (hash === null) throw new StoreError("a published change names its trace");
  return assertHash(hash, "content hash");
}

function assertChangeSuffix(suffix: string): string {
  if (!CHANGE_SUFFIX.test(suffix)) {
    throw new StoreError(`invalid change suffix: ${JSON.stringify(suffix)}`);
  }
  return suffix;
}

export function changeSuffix(): string {
  return randomBytes(4).toString("hex");
}

export interface ChangeKeyParts {
  /** The stamp, in epoch ms. */
  at: number;
  archive_id: string;
  suffix: string;
  kind: ChangeKind;
  /** The published trace; null for a tombstone or visibility change. */
  content_hash: string | null;
}

const CHANGE_NAME =
  /^(\d{8}T\d{6}\.\d{3}Z)-([0-9a-f]{64})-([0-9a-f]{8})-([0-9a-f]{64}|tombstone|visibility)\.json$/;

/** A change key's parts, from its name under `changes/` (or the whole key); null for anything
 * that is not a change key. */
export function parseChangeKey(key: string): ChangeKeyParts | null {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const m = CHANGE_NAME.exec(name);
  if (!m) return null;
  const [, stamp, archive, suffix, what] = m as unknown as [string, string, string, string, string];
  const at = stampTime(stamp);
  if (at === null) return null;
  if (what === "tombstone") {
    return { at, archive_id: archive, suffix, kind: "tombstone", content_hash: null };
  }
  if (what === "visibility") {
    return { at, archive_id: archive, suffix, kind: "visibility_changed", content_hash: null };
  }
  return { at, archive_id: archive, suffix, kind: "published", content_hash: what };
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

export function recordKeyHash(idempotencyKey: string): string {
  if (idempotencyKey === "") throw new StoreError("an idempotency key is required");
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 24);
}
