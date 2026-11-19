import type { ConnectorLogger, Cursor } from "@seshi/kit";

export const MANIFEST_VERSION = 1;

export const SESSION_REDACTED = "redacted";
export type ObjectFailure = typeof SESSION_REDACTED | (string & {});

export const HOLD_BEFORE_ANY_KEY = "";

export interface ObjectEntry {
  etag: string;
  size: number;
  modified?: string;
  format?: string;
  session?: string;
  /** How many bytes of the object the session holds (the pipeline's `bytes_total`): an
   * append-only log continues from here (X4.4). 0 while nothing is stored, as after the
   * session filter: the next version goes whole again. */
  offset: number;
  tail?: string;
  gz?: boolean;
  failed?: ObjectFailure;
}

export interface Manifest {
  v: typeof MANIFEST_VERSION;
  objects: Record<string, ObjectEntry>;
  /** Where an unfinished listing resumes: the last key handled. Absent between passes. */
  after?: string;
  watch_from?: string;
  hold?: string;
  listed_at?: string;
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
    if (
      entry.failed === SESSION_REDACTED ||
      (Number.isFinite(modified) && modified < since.getTime())
    ) {
      objects[key] = entry;
    }
  }
  const rewound: Manifest = { v: MANIFEST_VERSION, objects };
  if (manifest.listed_at !== undefined) rewound.listed_at = manifest.listed_at;
  rewound.epoch = (manifest.epoch ?? 0) + 1;
  return rewound;
}
