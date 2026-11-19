import { describe, expect, it } from "vitest";
import { hashMatches, hashToken, isTokenId, mintToken, secretsEqual, tokenId } from "./opaque";

describe("opaque seshi tokens (X5.9)", () => {
  it("are seshi_<id>_<secret>, and only their hash is kept", () => {
    const { id, token, hash } = mintToken();
    expect(token).toMatch(/^seshi_[0-9a-f]{20}_[A-Za-z0-9_-]{43}$/);
    expect(tokenId(token)).toBe(id);
    expect(isTokenId(id)).toBe(true);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(28));
    expect(hashMatches(hash, token)).toBe(true);
    expect(hashMatches(hash, `${token.slice(0, -1)}x`)).toBe(false);
    expect(mintToken().token).not.toBe(token);
  });

  it("refuse anything malformed before any lookup", () => {
    expect(tokenId("seshi_short_x")).toBeUndefined();
    expect(tokenId("sdb_test-token-0123456789abcdef")).toBeUndefined();
    expect(tokenId(`seshi_${"g".repeat(20)}_${"a".repeat(43)}`)).toBeUndefined();
    expect(isTokenId("../x")).toBe(false);
  });

  it("compare static secrets in constant time", () => {
    expect(secretsEqual("a-token-0123456789", "a-token-0123456789")).toBe(true);
    expect(secretsEqual("a-token-0123456789", "a-token-012345678")).toBe(false);
  });
});
