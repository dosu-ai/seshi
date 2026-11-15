/** Generated from spec/schemas/change.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

import type { Continuation, OwnerBasis, Sha256, Timestamp, Visibility, Writer } from "./common";

/** The `schema` value of every ChangeEntry object. */
export const SCHEMA_ID = "seshi/change/1" as const;

/** `seshi/change/1`: one entry of an owner's change feed, `owners/<owner>/changes/<stamp>-<content_hash|tombstone|visibility>.json`. Append-only; readers tail the feed by key. Every entry records its writer (X5.5). */
export interface ChangeEntry {
  schema: "seshi/change/1";
  /** `published`: a new trace is the head. `tombstone`: the session's traces were removed (see `reason`). `visibility_changed`: who may read it changed (X5.10). */
  kind: "published" | "tombstone" | "visibility_changed";
  at: Timestamp;
  owner: string;
  archive_id: Sha256;
  session_id: string;
  /** The trace the entry is about; for a tombstone or a visibility change, the head at the time (null when there was none). */
  content_hash: Sha256 | null;
  continuation?: Continuation;
  /** On `published`: the trace replaces the session's earlier traces instead of extending them (X4.6), and they were removed; a reader drops what it held of the session. Absent otherwise. */
  replace?: true;
  writer: Writer;
  /** How the session's owner was established (X5.5), as metadata records it. */
  owner_basis?: OwnerBasis;
  /** Why a session was tombstoned: `deleted` by its owner or an admin, `retracted` by the machine that uploaded it (F9.7), or `redacted` by an operator. On a `published` entry with `replace`, `redacted` says a redaction backfill rewrote the session's traces with new rules (F2.5); absent on other publishes. */
  reason?: "deleted" | "retracted" | "redacted";
  /** On `visibility_changed`: the new visibility. */
  visibility?: Visibility;
}
