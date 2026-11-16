export const SCOPES = [
  "sessions:write",
  "sessions:read",
  "sessions:delete",
  "search",
  "sources:admin",
  "tokens:admin",
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

export function serviceScopesValid(scopes: readonly Scope[]): boolean {
  const set = new Set(scopes);
  if (set.size === 0) return false;
  const reads = set.has("sessions:read") || set.has("search");
  const writes = set.has("sessions:write");
  const other = [...set].some((s) => !["sessions:read", "search", "sessions:write"].includes(s));
  return !other && reads !== writes;
}
