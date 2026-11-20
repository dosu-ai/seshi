/** Generated from spec/schemas/change.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

import type { Continuation, OwnerBasis, Sha256, Timestamp, Visibility, Writer } from "./common";

/** The `schema` value of every ChangeEntry object. */
export const SCHEMA_ID = "seshi/change/1" as const;

/** `seshi/change/1`: one entry of an owner's change feed, `owners/<owner>/changes/<stamp>-<archive_id>-<suffix>-<content_hash|tombstone|visibility>.json` (unique: a random suffix). Append-only; written before the session pointer moves, so an entry may name a change that did not happen (readers read the current metadata). Readers tail the feed by key. Every entry records its writer (X5.5). */
export interface ChangeEntry {
  schema: "seshi/change/1";
  /** `published`: a new trace is the head. `tombstone`: the session's traces were removed (see `reason`). `visibility_changed`: who may read it changed (X5.10). */
  kind: "published" | "tombstone" | "visibility_changed";
  at: Timestamp;
  owner: string;
  archive_id: Sha256;
  session_id: string;
  /** The format the session is filed under (its metadata's `format`), which every session route takes. Entries written before 0.15 have none; the change feeds fill it from the session's metadata when they serve them. */
  format: string;
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

/** change.schema.json as data, without its annotations: what `schemaProblems` checks against. */
export const JSON_SCHEMA = {
  $id: "change.schema.json",
  type: "object",
  properties: {
    schema: { const: "seshi/change/1" },
    kind: { enum: ["published", "tombstone", "visibility_changed"] },
    at: { $ref: "common.schema.json#/$defs/Timestamp" },
    owner: { type: "string", minLength: 1 },
    archive_id: { $ref: "common.schema.json#/$defs/Sha256" },
    session_id: { type: "string" },
    format: { type: "string", minLength: 1 },
    content_hash: { oneOf: [{ $ref: "common.schema.json#/$defs/Sha256" }, { type: "null" }] },
    continuation: { $ref: "common.schema.json#/$defs/Continuation" },
    replace: { const: true },
    writer: { $ref: "common.schema.json#/$defs/Writer" },
    owner_basis: { $ref: "common.schema.json#/$defs/OwnerBasis" },
    reason: { enum: ["deleted", "retracted", "redacted"] },
    visibility: { $ref: "common.schema.json#/$defs/Visibility" },
  },
  required: [
    "schema",
    "kind",
    "at",
    "owner",
    "archive_id",
    "session_id",
    "format",
    "content_hash",
    "writer",
  ],
  additionalProperties: false,
};
