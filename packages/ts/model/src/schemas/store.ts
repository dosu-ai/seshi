/** The stored objects other languages read (X3.10): the layout marker, a session's
 * `metadata.json` and its change entries. Their types are generated from `spec/schemas/`
 * (`src/generated/`); this module names them and adds the constants and helpers code needs.
 * See `spec/layout.md`. */

import { SCHEMA_ID as CHANGE_SCHEMA_ID } from "../generated/change";
import type { CallerKind, LogEncoding, Writer } from "../generated/common";
import { SCHEMA_ID as LAYOUT_SCHEMA_ID } from "../generated/layout";
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
export const LAYOUT_SCHEMA = LAYOUT_SCHEMA_ID;

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
