import { SCHEMA_ID as CHANGE_SCHEMA_ID } from "../generated/change";
import type { CallerKind, LogEncoding, Writer } from "../generated/common";
import { SCHEMA_ID as METADATA_SCHEMA_ID } from "../generated/metadata";

export type { ChangeEntry } from "../generated/change";
export type {
  CallerKind,
  Claims,
  Continuation,
  LogEncoding,
  Normalizer,
  OwnerBasis,
  Provenance,
  RedactionSummary,
  Sha256,
  SourceId,
  SourceKind,
  SourceLocation,
  Timestamp,
  Visibility,
  Writer,
} from "../generated/common";
export type { LayoutMarker } from "../generated/layout";
export type {
  AppliedEnvelope,
  DroppedPrefix,
  NormalizedState,
  SessionMetadata,
  SessionTraceRef,
} from "../generated/metadata";

/** How a transcript is encoded (`jsonl` or `json`): the envelope's `LogEncoding`, by the name
 * the raw-transcript redaction passes and the session API have always used. */
export type RawFormat = LogEncoding;

export const METADATA_SCHEMA = METADATA_SCHEMA_ID;
export const CHANGE_SCHEMA = CHANGE_SCHEMA_ID;
/** The layout marker this seshi writes when a command sets the mode or a minimum version
 * (F11.7). */
export const LAYOUT_SCHEMA = "seshi/layout/2" as const;
/** The first layout marker schema: no mode, no minimum version. Still read, and still what a
 * new prefix gets unless a command sets one of schema 2's fields, so older seshi keep working. */
export const LAYOUT_SCHEMA_V1 = "seshi/layout/1" as const;
/** Every layout marker schema this seshi reads. */
export const LAYOUT_SCHEMAS: readonly string[] = [LAYOUT_SCHEMA_V1, LAYOUT_SCHEMA];

/** Which mode a bucket is used in (F11.8). */
export type BucketMode = "server" | "serverless";

/** The marker a sessiondb (pre-seshi) prefix holds, `sessionstorage.json`. Seshi does not read
 * such a prefix: no migration is planned (X1.5). */
export const LEGACY_LAYOUT_SCHEMA = "sessionstorage/layout/1" as const;

export type SessionStatus = "stored" | "redacted";

export type ChangeKind = "published" | "tombstone" | "visibility_changed";

/** Why a session was tombstoned. */
export type TombstoneReason = "deleted" | "retracted" | "redacted";

/** The source id hooks and the CLI upload under (X6.4). */
export const UPLOAD_SOURCE = "upload" as const;

/** The writer of a session written in local mode, or by code that names no caller: the owner
 * itself, through the upload route. */
export function localWriter(owner: string, kind: CallerKind = "local"): Writer {
  return { kind, principal: owner, source_id: UPLOAD_SOURCE };
}
