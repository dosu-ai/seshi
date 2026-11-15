/** The S3 poller's checkpoint (F6.2): a manifest of the objects it has seen, keyed by object
 * key, and where an unfinished listing resumes. Saved with If-Match through the scheduler
 * (X7.3), so a second worker's run is discarded rather than mixed in. */

import type { ConnectorLogger, Cursor } from "@seshi/kit";

export const MANIFEST_VERSION = 1;

/** What the poller knows of one object (F6.2): the version it last handled, and what the
 * session it feeds holds of it. */
export interface ObjectEntry {
  /** The version last handled: an unchanged ETag and size is skipped without a read. */
  etag: string;
  size: number;
  /** When the source says it last changed (for `seshi reprocess --since`). */
  modified?: string;
  /** The format it was read as; kept, so the session (whose archive id depends on it) stays
   * the same when the object grows. */
  format?: string;
  /** The session key it was submitted under; kept for the same reason. */
  session?: string;
  /** How many bytes of the object the session holds (the pipeline's `bytes_total`): an
   * append-only log continues from here (X4.4). 0 while nothing is stored, as after the
   * session filter: the next version goes whole again. */
  offset: number;
  /** A digest of the up to 4 KiB before `offset`: a grown object continues only when they are
   * unchanged, else it is read whole and replaces the session (F6.3). */
  tail?: string;
  /** Gzip-compressed: always read whole (its bytes cannot be continued by offset). */
  gz?: boolean;
  /** The code of a permanent failure of this version: not tried again until it changes.
   * `redacted` (an admin deleted the session in seshi, F6.4) is never tried again. */
  failed?: string;
}

/** The checkpoint's cursor. */
export interface Manifest {
  v: typeof MANIFEST_VERSION;
  objects: Record<string, ObjectEntry>;
  /** Where an unfinished listing resumes: the last key handled. Absent between passes. */
  after?: string;
  /** With `ordered_keys` (F6.2): listing starts after this key. The newest key stays watched
   * (it may still grow) until a newer one appears; older keys are dropped from the manifest. */
  watch_from?: string;
  /** With `ordered_keys`, during a pass: the key listed just before the first object skipped
   * because it changed while read (`""` for none before it), so `watch_from` stays before
   * it and the next pass reads it again. */
  hold?: string;
  /** When the last complete listing ended. */
  listed_at?: string;
  /** Which reading of the source this is: set when a manifest starts (the first run, or after
   * a rewind to the start) and bumped by every rewind to a time. A whole object's idempotency
   * key carries it, so an object read again after `seshi reprocess` is normalized again rather
   * than answered from the session's applied envelopes (X4.7, X4.9). */
  epoch?: number;
}

/** A map keyed by object keys, with no prototype: a key such as `__proto__` is just a key. */
function objectMap(): Record<string, ObjectEntry> {
  return Object.create(null) as Record<string, ObjectEntry>;
}

export function emptyManifest(): Manifest {
  return { v: MANIFEST_VERSION, objects: objectMap() };
}

function isEntry(value: unknown): value is ObjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.etag === "string" &&
    typeof e.size === "number" &&
    typeof e.offset === "number" &&
    e.offset >= 0
  );
}

/** The manifest in a checkpoint's cursor. One this version cannot read starts over (every
 * object is read again; sessions that did not change answer `unchanged`), with a warning. */
export function readManifest(cursor: Cursor | null, log: ConnectorLogger): Manifest {
  if (cursor === null) return emptyManifest();
  if (cursor.v !== MANIFEST_VERSION || typeof cursor.objects !== "object" || !cursor.objects) {
    log.warn("the checkpoint is not an S3 manifest this version reads; listing from the start");
    return emptyManifest();
  }
  const objects = objectMap();
  for (const [key, entry] of Object.entries(cursor.objects as Record<string, unknown>)) {
    if (isEntry(entry)) objects[key] = entry;
  }
  const manifest: Manifest = { v: MANIFEST_VERSION, objects };
  for (const field of ["after", "watch_from", "hold", "listed_at"] as const) {
    const value = cursor[field];
    if (typeof value === "string") manifest[field] = value;
  }
  if (typeof cursor.epoch === "number" && Number.isSafeInteger(cursor.epoch)) {
    manifest.epoch = cursor.epoch;
  }
  return manifest;
}

/** `manifest` with what `seshi reprocess --since` reads again (X4.9): every object that
 * changed at or after `since`, or whose change time is unknown, is forgotten, so the next run
 * reads it whole (a session that did not change answers `unchanged`; one the normalizer now
 * reads differently is replaced, F6.3). The epoch moves on, so those reads are not answered
 * from the session's applied envelopes. With `ordered_keys` the listing starts from the
 * beginning again, since keys say nothing of time. Objects whose session an admin deleted are
 * kept: they stay deleted. */
export function rewindManifest(manifest: Manifest, since: Date): Manifest {
  const objects = objectMap();
  for (const [key, entry] of Object.entries(manifest.objects)) {
    const modified = entry.modified ? Date.parse(entry.modified) : Number.NaN;
    // A session an admin deleted stays deleted (F6.4): reading it again would only be refused.
    if (entry.failed === "redacted" || (Number.isFinite(modified) && modified < since.getTime())) {
      objects[key] = entry;
    }
  }
  const rewound: Manifest = { v: MANIFEST_VERSION, objects };
  if (manifest.listed_at !== undefined) rewound.listed_at = manifest.listed_at;
  // A new reading: what is read again gets new idempotency keys, so it is normalized again.
  rewound.epoch = (manifest.epoch ?? 0) + 1;
  return rewound;
}
