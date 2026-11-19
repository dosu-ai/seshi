import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = "seshi_";
const ID_LENGTH = 20;
const TOKEN = /^seshi_([0-9a-f]{20})_([A-Za-z0-9_-]{43})$/;
const ID = /^[0-9a-f]{20}$/;

export interface MintedToken {
  id: string;
  token: string;
  hash: string;
}

export function mintToken(): MintedToken {
  const id = randomBytes(ID_LENGTH / 2).toString("hex");
  const token = `${TOKEN_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
  return { id, token, hash: hashToken(token) };
}

/** The record id of a well-formed token; undefined for anything else. */
export function tokenId(token: string): string | undefined {
  return TOKEN.exec(token)?.[1];
}

export function isTokenId(id: string): boolean {
  return ID.test(id);
}

export function isOpaqueToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Whether `token` hashes to `stored`, compared in constant time. */
export function hashMatches(stored: string, token: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(hashToken(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether two secrets are equal, compared in constant time (static tokens from config). */
export function secretsEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a, "utf8").digest();
  const y = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}
