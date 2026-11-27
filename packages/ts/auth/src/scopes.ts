export const SCOPES = [
  "sessions:write",
  "sessions:read",
  "sessions:delete",
  "search",
  "sources:admin",
  "tokens:admin",
  // One read-only statement over the search index (docs/seshi/session-tools.md, T7): admins
  // have it, service tokens can be given it, members get it only on LanceDB with
  // `[search.sql] members = true`, never on SQLite (T11).
  "sql",
] as const;

export type Scope = (typeof SCOPES)[number];

export type Role = "member" | "admin" | "service";

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export const CREDENTIAL_SCOPES = {
  org: ["sessions:write", "sessions:read", "search"],
  member_session: ["sessions:read", "search", "sessions:delete"],
  admin: [...SCOPES],
  device: ["sessions:write"],
  service_read: ["sessions:read", "search"],
  service_write: ["sessions:write"],
  static: ["sessions:write", "sessions:read", "sessions:delete", "search"],
} as const satisfies Record<string, readonly Scope[]>;

/** The scopes a service token that reads may carry. */
const SERVICE_READS: readonly Scope[] = ["sessions:read", "search", "sql"];

export function serviceScopesValid(scopes: readonly Scope[]): boolean {
  const set = new Set(scopes);
  if (set.size === 0) return false;
  const reads = SERVICE_READS.some((s) => set.has(s));
  const writes = set.has("sessions:write");
  const other = [...set].some((s) => !SERVICE_READS.includes(s) && s !== "sessions:write");
  return !other && reads !== writes;
}
