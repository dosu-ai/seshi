/** Generated from spec/schemas/metadata.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

import type {
  Claims,
  Continuation,
  Normalizer,
  OwnerBasis,
  Provenance,
  RedactionSummary,
  Sha256,
  Timestamp,
  Visibility,
  Writer,
} from "./common";

/** The `schema` value of every SessionMetadata object. */
export const SCHEMA_ID = "seshi/metadata/1" as const;

/** `seshi/metadata/1`: one session's live pointer, `owners/<owner>/sessions/<archive_id>/metadata.json`. Mutable, so every write is conditional (If-Match, X6.5). It names the head trace and the traces the session has had, how far a chunked log has been normalized, who wrote the session and how its owner was established (X5.5), who may read it (X5.10), the identity claims the data made, what redaction did and where the data came from. */
export interface SessionMetadata {
  schema: "seshi/metadata/1";
  owner: string;
  /** sha256(owner + "\n" + agent + "\n" + session_id). */
  archive_id: Sha256;
  session_id: string;
  /** The format the session is filed under. */
  agent: string;
  /** What the trace's meta record says it came from; absent until a trace is stored. */
  source?: string;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  /** `stored`, or `redacted` once tombstoned: a redacted session is never stored again. */
  status: "stored" | "redacted";
  /** The current trace's content hash; absent before one is stored and once redacted. */
  head?: Sha256;
  traces: SessionTraceRef[];
  /** Raw transcript parts. Transitional: 04 stops storing raw (X6.3). */
  raw: RawPart[];
  raw_format?: RawFormat;
  normalized?: NormalizedState;
  /** Tool calls whose results are withheld, by id, so a result in a later chunk than its call is replaced too. */
  withheld_calls?: {
    [key: string]: "sensitive-file" | "secret-output";
  };
  /** Who first wrote the session: the original writer, who with an admin may replace it (X4.6). Each write's own writer is on its change entry. */
  writer: Writer;
  owner_basis: OwnerBasis;
  visibility: Visibility;
  claims?: Claims;
  /** Redaction over the session's stored traces: the rule set that last ran and the matches by rule, summed over every write. */
  redaction?: RedactionSummary;
  /** Where the latest write came from. */
  provenance?: Provenance;
  /** The agent that ran the session (`claude-code`), whatever route it arrived by, so readers can collapse a session that arrived twice (X4.5). */
  origin_agent?: string;
  /** The session's id in the agent that ran it (X4.5). */
  native_session_id?: string;
  /** What normalized the head trace (X4.9). */
  normalizer?: Normalizer;
  /** Reserved for F9.7: the hash of the uploading machine's retraction secret. */
  retract_hash?: Sha256;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionTraceRef {
  content_hash: Sha256;
  created_at: Timestamp;
  /** Record count of the stored trace. */
  records: number;
  continuation?: Continuation;
}

/** How a raw transcript part is encoded: one JSON value per line, or one JSON document. */
export type RawFormat = "jsonl" | "json";

export interface RawPart {
  part: number;
  format: RawFormat;
  /** Bytes as stored (gzip). */
  size: number;
  sha256: Sha256;
  created_at: Timestamp;
  /** The byte offset of the part's first byte in its log. */
  offset: number;
  /** How many of the log's bytes it covers, before redaction. */
  length: number;
}

/** How far a session's log has been normalized: the state the next chunk continues from. */
export interface NormalizedState {
  /** Bytes of the log normalized so far. */
  bytes: number;
  /** How many records the whole session normalizes to, those bytes in. */
  records: number;
  prefix_sha256: Sha256;
  /** The prefix hash mid-stream (`PrefixHash.export()`), so the next chunk's records extend it. */
  hash_state: string;
}
