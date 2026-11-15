/** Generated from spec/schemas/envelope.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

import type {
  CallerKind,
  Claims,
  LogEncoding,
  OwnerBasis,
  Sha256,
  SourceId,
  SourceKind,
  SourceLocation,
  Timestamp,
  Visibility,
} from "./common";

/** The `schema` value of every Envelope object. */
export const SCHEMA_ID = "seshi/envelope/1" as const;

/** `seshi/envelope/1`: the only input to the pipeline (X4.1). Every source builds one: the HTTP routes from requests, integrations through the submit() context. It carries the payload, which session it is, who sent it and whom it belongs to, and enough provenance to fetch it again. Never stored: the pipeline normalizes, redacts, filters and reviews it in memory and writes the trace (X4.3). */
export interface Envelope {
  schema: "seshi/envelope/1";
  source: SourceKind;
  source_id: SourceId;
  /** The format adapter for the payload (`claude-code`, `codex`, `otlp-genai`, …). */
  format: string;
  /** The session's id as the source names it (the agent's session id; `anthropic.session.id` for OTLP). */
  session_key: string;
  payload: Payload;
  caller: Caller;
  claims?: Claims;
  /** The owner the session belongs to, resolved from the caller (X5.4, X5.8). */
  owner: string;
  owner_basis: OwnerBasis;
  /** Identifies the envelope across resends (X4.7): a resend with the same key gets the same answer and is processed once. Session, byte offset and a digest of the text for a hook or upload; bucket, key and ETag for S3; trace and span ids for OTLP and Datadog; agent and run id for Cursor Cloud. */
  idempotency_key: string;
  provenance?: SourceLocation;
  received_at: Timestamp;
  /** The visibility the request asked for, if any (X5.10). */
  visibility?: Visibility;
  /** A whole upload that may replace the session rather than extend it (X4.6). Only the session's original writer or an admin may set it. */
  replace?: boolean;
  /** A whole upload that rebuilds the session from the whole log and reviews it again, even when the log only extends what is stored (X4.9): the session is replaced as with `replace`, which it needs the same permission as. The uploader sends it for sessions the server marks stale, and `seshi capture resend` by hand. */
  rebuild?: boolean;
  /** What the uploader says shipped of the session before, from an earlier answer. The server's own state decides whether a whole upload extends the session; this is used only for a session that has none. */
  shipped?: ShippedPrefix;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  fork_of?: string;
  /** The hash of the uploader's retraction secret (F9.7), sent with a session's first upload. */
  retract_hash?: Sha256;
}

/** An append-only log (X4.2), whole or a chunk from `offset`, or a batch of spans for the span assembler. */
export type Payload = LogPayload | SpanPayload;

export interface LogPayload {
  kind: "log";
  encoding: LogEncoding;
  /** The log's text from `offset`. */
  text: string;
  /** The byte offset of `text` in the session's log: 0 for the whole log. */
  offset: number;
}

/** A batch of spans for the span assembler (X4.2, F4.4): the call returns once they are in the span store, and the assembler publishes the session later. */
export interface SpanPayload {
  kind: "spans";
  /** OTLP spans in their JSON mapping, as received or as a poller built them. */
  spans: Record<string, unknown>[];
  /** The batch's OTLP resource attributes (`service.name`, …) in their JSON mapping, when the spans came with one. */
  resource?: Record<string, unknown>[];
}

export interface ShippedPrefix {
  /** How many normalized records shipped, from the start. */
  records: number;
  prefix_sha256: Sha256;
}

/** The verified principal that sent the envelope and the credential it used; pollers act as their source's service account (X5.4). */
export interface Caller {
  kind: CallerKind;
  principal: string;
  credential_id?: string;
}

/** envelope.schema.json as data, without its annotations: what `schemaProblems` checks against. */
export const JSON_SCHEMA = {
  $id: "envelope.schema.json",
  type: "object",
  properties: {
    schema: { const: "seshi/envelope/1" },
    source: { $ref: "common.schema.json#/$defs/SourceKind" },
    source_id: { $ref: "common.schema.json#/$defs/SourceId" },
    format: { type: "string", minLength: 1 },
    session_key: { type: "string", minLength: 1 },
    payload: { $ref: "#/$defs/Payload" },
    caller: { $ref: "#/$defs/Caller" },
    claims: { $ref: "common.schema.json#/$defs/Claims" },
    owner: { type: "string", minLength: 1 },
    owner_basis: { $ref: "common.schema.json#/$defs/OwnerBasis" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 2048 },
    provenance: { $ref: "common.schema.json#/$defs/SourceLocation" },
    received_at: { $ref: "common.schema.json#/$defs/Timestamp" },
    visibility: { $ref: "common.schema.json#/$defs/Visibility" },
    replace: { type: "boolean" },
    rebuild: { type: "boolean" },
    shipped: { $ref: "#/$defs/ShippedPrefix" },
    project: { type: "string" },
    branch: { type: "string" },
    parent_session_id: { type: "string" },
    fork_of: { type: "string" },
    retract_hash: { $ref: "common.schema.json#/$defs/Sha256" },
  },
  required: [
    "schema",
    "source",
    "source_id",
    "format",
    "session_key",
    "payload",
    "caller",
    "owner",
    "owner_basis",
    "idempotency_key",
    "received_at",
  ],
  additionalProperties: false,
  $defs: {
    Payload: { oneOf: [{ $ref: "#/$defs/LogPayload" }, { $ref: "#/$defs/SpanPayload" }] },
    LogPayload: {
      type: "object",
      properties: {
        kind: { const: "log" },
        encoding: { $ref: "common.schema.json#/$defs/LogEncoding" },
        text: { type: "string" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["kind", "encoding", "text", "offset"],
      additionalProperties: false,
    },
    SpanPayload: {
      type: "object",
      properties: {
        kind: { const: "spans" },
        spans: { type: "array", items: { type: "object" } },
        resource: { type: "array", items: { type: "object" } },
      },
      required: ["kind", "spans"],
      additionalProperties: false,
    },
    ShippedPrefix: {
      type: "object",
      properties: {
        records: { type: "integer", minimum: 0 },
        prefix_sha256: { $ref: "common.schema.json#/$defs/Sha256" },
      },
      required: ["records", "prefix_sha256"],
      additionalProperties: false,
    },
    Caller: {
      type: "object",
      properties: {
        kind: { $ref: "common.schema.json#/$defs/CallerKind" },
        principal: { type: "string", minLength: 1 },
        credential_id: { type: "string", minLength: 1 },
      },
      required: ["kind", "principal"],
      additionalProperties: false,
    },
  },
};
