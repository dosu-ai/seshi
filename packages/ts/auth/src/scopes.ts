/** Scopes and roles (X5.3). A credential carries scopes; a principal has one role. Scopes say
 * what kind of call a credential may make; the role and the session's owner and visibility say
 * which sessions it may make it on (`access.ts`). */

export const SCOPES = [
  "sessions:write",
  "sessions:read",
  "sessions:delete",
  "search",
  "sources:admin",
  "tokens:admin",
] as const;

export type Scope = (typeof SCOPES)[number];

/** `member`: writes and deletes their own sessions, reads what visibility allows. `admin`:
 * everything, org-wide. `service`: reads org-wide, or writes as its service account. */
export type Role = "member" | "admin" | "service";

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** What each credential may do (the credentials table in X5). */
export const CREDENTIAL_SCOPES = {
  /** The trusted org key (X5.12): write as the stated username; read and search org-wide. No
   * delete: anyone holding it could claim to be the owner. */
  org: ["sessions:write", "sessions:read", "search"],
  /** A member's session token (X5.2): interactive reads, search and deletes of their own
   * sessions (deletes need a fresh one). */
  member_session: ["sessions:read", "search", "sessions:delete"],
  /** An admin's session token or admin token: everything. */
  admin: [...SCOPES],
  /** A device token: the uploader on a laptop writes its person's sessions. */
  device: ["sessions:write"],
  /** A service account that reads (a downstream sync). */
  service_read: ["sessions:read", "search"],
  /** A service account that writes as `svc:<source-id>` (an OTLP destination). */
  service_write: ["sessions:write"],
  /** A static token from config (single user, development): everything for one owner. */
  static: ["sessions:write", "sessions:read", "sessions:delete", "search"],
} as const satisfies Record<string, readonly Scope[]>;

/** The scopes a service token may hold: read and search, or write; never both, so a leaked
 * reader cannot write and a leaked destination cannot read (X5.4). */
export function serviceScopesValid(scopes: readonly Scope[]): boolean {
  const set = new Set(scopes);
  if (set.size === 0) return false;
  const reads = set.has("sessions:read") || set.has("search");
  const writes = set.has("sessions:write");
  const other = [...set].some((s) => !["sessions:read", "search", "sessions:write"].includes(s));
  return !other && reads !== writes;
}
