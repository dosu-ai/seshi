import type { Claims } from "@seshi/model";

const TEXT_FIELDS = ["email", "name", "username", "git_email", "git_name"] as const;
const MAX_TEXT = 320;
const MAX_ACCOUNTS = 32;
const VENDOR = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_ACCOUNT_ID = 256;

/** The allowlisted claims in `input`, each a bounded string; anything else is dropped.
 * Undefined when nothing is left. */
export function pickClaims(input: unknown): Claims | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const claims: Claims = {};
  for (const field of TEXT_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT) {
      claims[field] = value.trim();
    }
  }
  const accounts = source.account_ids;
  if (typeof accounts === "object" && accounts !== null && !Array.isArray(accounts)) {
    const kept: Record<string, string> = {};
    for (const [vendor, id] of Object.entries(accounts).slice(0, MAX_ACCOUNTS)) {
      if (
        VENDOR.test(vendor) &&
        typeof id === "string" &&
        id !== "" &&
        id.length <= MAX_ACCOUNT_ID
      ) {
        kept[vendor] = id;
      }
    }
    if (Object.keys(kept).length > 0) claims.account_ids = kept;
  }
  return Object.keys(claims).length > 0 ? claims : undefined;
}

export function idTokenClaims(payload: Record<string, unknown>): Claims {
  const claims: Claims = {};
  if (typeof payload.email === "string" && payload.email_verified !== false) {
    claims.email = payload.email.toLowerCase();
  }
  if (typeof payload.name === "string") claims.name = payload.name;
  return pickClaims(claims) ?? {};
}
