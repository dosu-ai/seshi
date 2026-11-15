/** What the server's auth, token and admin routes take and answer, as `spec/openapi.yaml`
 * documents them. The client depends only on `@seshi/model` (X3.2), and these objects are not
 * stored ones, so they are written here from the document rather than imported from the
 * packages that produce them. */

import type { OwnerBasis, Visibility } from "@seshi/model";

export type Scope =
  | "sessions:write"
  | "sessions:read"
  | "sessions:delete"
  | "search"
  | "sources:admin"
  | "tokens:admin";

export type TokenKind = "org" | "admin" | "device" | "service";

/** `GET /v1/auth/config`: which ways in the server takes (X5.7). */
export interface AuthConfig {
  version: string;
  /** The org key is accepted (X5.12). */
  org_key: boolean;
  /** The IdP to sign in through, or null without one. */
  oidc: { issuer: string; client_id: string; audience: string; scopes: string[] } | null;
  session_token_seconds: number;
  /** How recent a session token must be to delete (X5.3). */
  delete_fresh_seconds: number;
}

/** `POST /v1/auth/exchange`'s body. */
export interface ExchangeRequest {
  id_token: string;
  nonce?: string;
  /** The first sign-in from this machine, or a renewal of its device token (X5.2). */
  machine?: { id: string; name?: string };
  /** The device token's default visibility (X5.10). */
  visibility?: Visibility;
}

export interface ExchangeResult {
  session_token: string;
  expires_at: string;
  owner: string;
  role: "member" | "admin";
  scopes: Scope[];
  device_token?: { token: string; id: string; expires_at: string };
}

/** `POST /v1/tokens`' body (X5.9). */
export interface TokenRequest {
  kind: TokenKind;
  /** A person's owner id, for `admin` and `device`. */
  owner?: string;
  /** For `service`: its name, or the configured source it writes for. */
  service?: string;
  scopes?: Scope[];
  visibility?: Visibility;
  /** RFC 3339. */
  expires_at?: string;
  label?: string;
}

/** A token record without its hash. */
export interface TokenInfo {
  schema: "seshi/token/1";
  id: string;
  kind: TokenKind;
  /** The owner id, or `*` for the org key. */
  owner: string;
  scopes: Scope[];
  visibility?: Visibility;
  owner_basis?: OwnerBasis;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  revoked_at?: string;
  label?: string;
  created_by?: { kind: string; principal: string; credential_id?: string };
  machine?: { id: string; name?: string };
  claims?: Record<string, unknown>;
}

export interface OwnersPage {
  owners: string[];
  cursor?: string;
  truncated: boolean;
}

/** A source's state (`GET /v1/admin/sources`). */
export interface SourceStatus {
  id: string;
  type: string;
  enabled: boolean;
  polled: boolean;
  connector?: string;
  interval_ms?: number;
  note?: string;
  checkpoint: { updated_at: string; cursor: Record<string, unknown> } | null;
  dropped: number;
  failed: number;
  /** Outcome counts over the days asked for (X4.8). */
  health: Record<string, number>;
}

export type RecordKind = "failed" | "dropped";

/** A drop or failure record (X6.4): that an envelope arrived and why it was not stored, never
 * its content. */
export interface SourceRecord {
  schema: "seshi/failed/1" | "seshi/dropped/1";
  at: string;
  source: string;
  source_kind?: string;
  owner?: string;
  session_key?: string;
  idempotency_key: string;
  provenance?: Record<string, unknown>;
  /** Failures: the pipeline's error code and message. */
  code?: string;
  message?: string;
  /** Drops: why, under which policy. */
  reason?: string;
  policy?: string;
  policy_hash?: string;
  decision_model?: string;
}

export interface RecordsPage {
  source: string;
  kind: RecordKind;
  records: { key: string; record: SourceRecord }[];
  /** Pass as `after` for the next page. */
  cursor?: string;
  truncated: boolean;
}

/** `GET /v1/admin/jobs` (X7.5). Loosely typed here; `spec/openapi.yaml`'s `JobsStatus` is the
 * whole shape. */
export interface JobsStatus {
  at: string;
  deployment: string;
  instance: { id: string; process: string; roles: string[]; version: string };
  worker: { state: "running" | "stopped" | "never" | "several"; [key: string]: unknown };
  jobs: Array<{ name: string; kind: string; [key: string]: unknown }>;
  sources: SourceStatus[];
  warnings: string[];
}
