/** Generated from spec/schemas/common.schema.json by scripts/model-types.ts (`bun run types`). Do not edit: change the schema and regenerate. */

/** A SHA-256 digest as 64 lowercase hex characters. */
export type Sha256 = string;

/** An RFC 3339 time in UTC, as seshi writes it (`2026-11-14T09:00:00.000Z`). */
export type Timestamp = string;

/** How an envelope arrived (X4.1): an upload from the CLI, a capture hook, an OTLP push, or one of the pollers. */
export type SourceKind = "upload" | "hook" | "otlp" | "datadog" | "s3" | "cursor-cloud";

/** A configured source's id, or `upload` for hooks and the CLI: words of lowercase letters and digits joined by single `-`. */
export type SourceId = string;

/** Which kind of credential made a call (X5.1, X5.9): `person` (IdP session token or org key with a stated username), `device` (write-only device token), `service` (a service account: a reader, an OTLP destination, a poller), `admin` (an admin token, or the session token of a person with the admin role), `static` (a token from config) or `local` (local mode, writing a bucket it owns, X3.5). */
export type CallerKind = "person" | "device" | "service" | "admin" | "static" | "local";

/** Who wrote something (X5.5): the caller's kind, the person or service account, the credential it used, and the source the data came through. */
export interface Writer {
  kind: CallerKind;
  /** The owner id of the person (X5.8), or `svc:<source-id>` for a service account. */
  principal: string;
  /** The id of the token or key used, when it has one; never the secret. */
  credential_id?: string;
  source_id: SourceId;
}

/** Why the session belongs to its owner (X5.5): `verified` (an IdP sign-in, or a credential the operator bound to the owner), `claimed` (an org-key caller stated the username, X5.12) or `service` (an org-level source's service account, X5.4). */
export type OwnerBasis = "verified" | "claimed" | "service";

/** How a log is encoded: one JSON value per line (`jsonl`), or one JSON document (`json`). */
export type LogEncoding = "jsonl" | "json";

/** Who may read a session (X5.10): `org`, every member; `owner`, only its owner. Admins and services see everything. */
export type Visibility = "org" | "owner";

/** Identity the data asserts, copied from a fixed allowlist (X5.5). Never decides ownership (X5.4); with no raw stored, this is the only place it survives. */
export interface Claims {
  /** An email the data names (`trajectory.user_email`). */
  email?: string;
  /** A display name the data names. */
  name?: string;
  /** A username the caller stated or the data names. */
  username?: string;
  /** The git `user.email` of the working copy. */
  git_email?: string;
  /** The git `user.name` of the working copy. */
  git_name?: string;
  /** Account ids by vendor (`anthropic`, `openai`, `cursor`, …), as the agent records them. */
  account_ids?: {
    [key: string]: string;
  };
}

/** Where in the source the data was read (X4.1): enough to fetch it again for reprocessing (X4.9), never the content. */
export interface SourceLocation {
  /** An S3 object's key. */
  object_key?: string;
  /** That object's ETag when it was read. */
  etag?: string;
  /** An API cursor or time window, as the poller writes it. */
  cursor?: string;
}

/** Which source a write came from and how it was read: the route, the configured source, the format adapter that normalized it and where in the source it was. */
export interface Provenance {
  source: SourceKind;
  source_id: SourceId;
  /** The format adapter the payload was normalized with (`claude-code`, `otlp-genai`, …). */
  format?: string;
  location?: SourceLocation;
}

/** Which code normalized the records, so `seshi reprocess` can pick the sessions an adapter fix affects (X4.9). */
export interface Normalizer {
  name: string;
  version: string;
}

/** Marks a trace that is the tail of an already-stored session. */
export interface Continuation {
  /** Index of the first record of this trace (after its meta record) within the session's full record list. */
  from_record: number;
  /** `prefixSha256` of the session's records before it: sha256 of their canonical JSON. */
  prefix_sha256: Sha256;
}

/** What redaction did, never what it matched (F2): the rule set that ran, and how many times each rule fired. */
export interface RedactionSummary {
  /** sha256 of the rule set that ran (built-in rules plus the operator's packs). */
  rule_set: Sha256;
  /** Matches by rule id. */
  counts: {
    [key: string]: number;
  };
}
