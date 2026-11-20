/** Generated from spec/schemas/metadata.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

import type {
  Claims,
  Continuation,
  Labels,
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

/** `seshi/metadata/1`: one session's live pointer, `owners/<owner>/sessions/<archive_id>/metadata.json`. Mutable, so every write is conditional (If-Match, X6.5). It names the head trace and the traces the session has had, how far the session's log has been normalized and the envelopes recently applied to it, who wrote the session and how its owner was established (X5.5), who may read it (X5.10), the identity claims the data made, what redaction did and where the data came from. */
export interface SessionMetadata {
  schema: "seshi/metadata/1";
  owner: string;
  /** sha256(owner + "\n" + format + "\n" + session_id). */
  archive_id: Sha256;
  session_id: string;
  /** The format the session is filed under: the format adapter its envelopes named (`claude-code`, `codex`, `cursor-cloud-api`, …), which reads it. Metadata written before 0.16 calls it `agent`; readers take `format ?? agent`. */
  format: string;
  /** The harness: what the trace's meta record says it came from (`claude-code`, `codex`, `cursor`); absent until a trace is stored. */
  source?: string;
  /** seshi's own label for the session: the repository's folder name for a laptop upload, the repository's name for Cursor Cloud. Independent of `repo`. */
  project?: string;
  branch?: string;
  /** The repository the session ran in, as its origin remote normalized to lowercase without credentials (`github.com/acme/app`; the first remote when there is no `origin`). Fixed by the first write that names one: a later remote change does not move the session. */
  repo?: string;
  /** The version of the harness (`source`), as the latest trace names it: the log's own, else the uploader's hint (`harness_version`). A log that names it (Claude Code, Codex) gives the version the session started on, kept as the session grows, so a session resumed under a newer version keeps the older one; a hint (Cursor's) is the version at the latest upload. */
  agent_version?: string;
  /** Every model the session used, deduplicated in the order first seen: each LLM call's `model`, and the meta record's `model` (or the uploader's hint) when no call names one. Summed over every write; a replace starts it over. */
  models?: string[];
  /** The session's labels: set by the first write that carries any; later writes with other labels leave them, a replace may change them. */
  labels?: Labels;
  parent_session_id?: string;
  /** `stored`, or `redacted` once tombstoned: a redacted session is never stored again. */
  status: "stored" | "redacted";
  /** The current trace's content hash; absent before one is stored and once redacted. A `stored` session without one is a stub (F3.4): model review dropped its first envelopes, and it holds only where its log ends (`normalized`) and who wrote it. Readers neither list nor serve a stub. */
  head?: Sha256;
  traces: SessionTraceRef[];
  normalized?: NormalizedState;
  dropped_prefix?: DroppedPrefix;
  /** Tool calls whose results the sensitive-call rules withhold, by call id, so a result that arrives in a later chunk than its call is withheld too. With `normalized`, the small state a chunk is normalized with (X6.3). */
  withheld_calls?: {
    [key: string]: "sensitive-file" | "secret-output";
  };
  /** The last envelopes applied to the session, oldest first, with what each answered: a resend with the same idempotency key gets the same answer and is not processed again (X4.7). Bounded; older entries fall off. */
  applied?: AppliedEnvelope[];
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
  /** What normalized the head trace (X4.9). Its `format_version` is the oldest that built any stored trace of the session: a chunk normalized by a newer adapter does not make the prefix current, a whole write does. */
  normalizer?: Normalizer;
  /** The hash of the uploader's retraction secret (F9.7), kept from the session's first upload. The secret sent in X-Seshi-Retract (a retraction, or an org-key replace) is checked against it. */
  retract_hash?: Sha256;
  /** When the session last did something: the latest record timestamp over its stored traces. Absent for a session written before it was recorded, and for one whose records carry no timestamps; readers then use `updated_at`. */
  active_at?: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionTraceRef {
  content_hash: Sha256;
  created_at: Timestamp;
  /** Record count of the stored trace. */
  records: number;
  continuation?: Continuation;
  /** sha256 of the rule set this trace was redacted with (as `RedactionSummary.rule_set`). The session's `redaction.rule_set` is the latest write's; a redaction backfill takes the session as current only when every trace was written under the current rules. Absent for a trace written before it was recorded, which counts as the session's. */
  rule_set?: Sha256;
}

/** How far a session's log has been normalized: the state the next chunk continues from, and what a whole upload must extend (X4.6). Counted in the log's records as regex redaction left them, before model review, so it follows the uploader's log. */
export interface NormalizedState {
  /** Bytes of the log normalized so far: where the next chunk starts (0 for a session assembled from spans). */
  bytes: number;
  /** How many records the whole session normalizes to, those bytes in. */
  records: number;
  prefix_sha256: Sha256;
  /** The prefix hash mid-stream (`PrefixHash.export()`), so the next chunk's records extend it. */
  hash_state: string;
}

/** The start of a session's log that model review dropped before anything of the session was stored (F3.4): what its stub held, kept once the session has a trace. A whole write that does not extend what is stored (a `rebuild`, a `replace`, an assembled session written again) leaves these records out, so the dropped text is never stored or reviewed again. Counts and a hash, never content. Absent for a session whose first envelope was stored. */
export interface DroppedPrefix {
  /** Bytes of the log the dropped records came from (0 for a session assembled from spans): a whole log's first `bytes` bytes are the dropped part, whatever the normalizer now makes of them. */
  bytes: number;
  /** How many records the dropped part normalized to when last written. */
  records: number;
  /** The prefix hash of those records as regex redaction left them (as `NormalizedState.prefix_sha256`). */
  prefix_sha256: Sha256;
}

/** One envelope applied to the session, and what it answered. */
export interface AppliedEnvelope {
  idempotency_key: string;
  at: Timestamp;
  /** `stored` (a new trace), `duplicate` (that trace was already stored), `unchanged` (nothing new in it) or `dropped` (model review dropped it). */
  status: "stored" | "duplicate" | "unchanged" | "dropped";
  /** The trace written, for `stored` and `duplicate`. */
  content_hash?: Sha256;
  /** Records in that trace. */
  records?: number;
  /** Events in that trace. */
  events?: number;
  records_total: number;
  prefix_sha256: Sha256;
  bytes_total: number;
}

/** metadata.schema.json as data, without its annotations: what `schemaProblems` checks against. */
export const JSON_SCHEMA = {
  $id: "metadata.schema.json",
  type: "object",
  properties: {
    schema: { const: "seshi/metadata/1" },
    owner: { type: "string", minLength: 1 },
    archive_id: { $ref: "common.schema.json#/$defs/Sha256" },
    session_id: { type: "string" },
    format: { type: "string" },
    source: { type: "string" },
    project: { type: "string" },
    branch: { type: "string" },
    repo: { type: "string" },
    agent_version: { type: "string" },
    models: { type: "array", items: { type: "string" } },
    labels: { $ref: "common.schema.json#/$defs/Labels" },
    parent_session_id: { type: "string" },
    status: { enum: ["stored", "redacted"] },
    head: { $ref: "common.schema.json#/$defs/Sha256" },
    traces: { type: "array", items: { $ref: "#/$defs/SessionTraceRef" } },
    normalized: { $ref: "#/$defs/NormalizedState" },
    dropped_prefix: { $ref: "#/$defs/DroppedPrefix" },
    withheld_calls: {
      type: "object",
      additionalProperties: { enum: ["sensitive-file", "secret-output"] },
    },
    applied: { type: "array", items: { $ref: "#/$defs/AppliedEnvelope" } },
    writer: { $ref: "common.schema.json#/$defs/Writer" },
    owner_basis: { $ref: "common.schema.json#/$defs/OwnerBasis" },
    visibility: { $ref: "common.schema.json#/$defs/Visibility" },
    claims: { $ref: "common.schema.json#/$defs/Claims" },
    redaction: { $ref: "common.schema.json#/$defs/RedactionSummary" },
    provenance: { $ref: "common.schema.json#/$defs/Provenance" },
    origin_agent: { type: "string" },
    native_session_id: { type: "string" },
    normalizer: { $ref: "common.schema.json#/$defs/Normalizer" },
    retract_hash: { $ref: "common.schema.json#/$defs/Sha256" },
    active_at: { $ref: "common.schema.json#/$defs/Timestamp" },
    created_at: { $ref: "common.schema.json#/$defs/Timestamp" },
    updated_at: { $ref: "common.schema.json#/$defs/Timestamp" },
  },
  required: [
    "schema",
    "owner",
    "archive_id",
    "session_id",
    "format",
    "status",
    "traces",
    "writer",
    "owner_basis",
    "visibility",
    "created_at",
    "updated_at",
  ],
  additionalProperties: false,
  $defs: {
    SessionTraceRef: {
      type: "object",
      properties: {
        content_hash: { $ref: "common.schema.json#/$defs/Sha256" },
        created_at: { $ref: "common.schema.json#/$defs/Timestamp" },
        records: { type: "integer", minimum: 0 },
        continuation: { $ref: "common.schema.json#/$defs/Continuation" },
        rule_set: { $ref: "common.schema.json#/$defs/Sha256" },
      },
      required: ["content_hash", "created_at", "records"],
      additionalProperties: false,
    },
    NormalizedState: {
      type: "object",
      properties: {
        bytes: { type: "integer", minimum: 0 },
        records: { type: "integer", minimum: 0 },
        prefix_sha256: { $ref: "common.schema.json#/$defs/Sha256" },
        hash_state: { type: "string" },
      },
      required: ["bytes", "records", "prefix_sha256", "hash_state"],
      additionalProperties: false,
    },
    DroppedPrefix: {
      type: "object",
      properties: {
        bytes: { type: "integer", minimum: 0 },
        records: { type: "integer", minimum: 0 },
        prefix_sha256: { $ref: "common.schema.json#/$defs/Sha256" },
      },
      required: ["bytes", "records", "prefix_sha256"],
      additionalProperties: false,
    },
    AppliedEnvelope: {
      type: "object",
      properties: {
        idempotency_key: { type: "string", minLength: 1, maxLength: 2048 },
        at: { $ref: "common.schema.json#/$defs/Timestamp" },
        status: { enum: ["stored", "duplicate", "unchanged", "dropped"] },
        content_hash: { $ref: "common.schema.json#/$defs/Sha256" },
        records: { type: "integer", minimum: 0 },
        events: { type: "integer", minimum: 0 },
        records_total: { type: "integer", minimum: 0 },
        prefix_sha256: { $ref: "common.schema.json#/$defs/Sha256" },
        bytes_total: { type: "integer", minimum: 0 },
      },
      required: [
        "idempotency_key",
        "at",
        "status",
        "records_total",
        "prefix_sha256",
        "bytes_total",
      ],
      additionalProperties: false,
    },
  },
};
