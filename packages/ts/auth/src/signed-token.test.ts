import { describe, expect, it } from "vitest";
import { MIN_SECRET_LENGTH, signToken, verifyToken } from "./signed-token";

const SECRET = "s".repeat(MIN_SECRET_LENGTH);
const NOW = new Date("2026-11-14T12:00:00Z");
const LATER = Math.floor(NOW.getTime() / 1000) + 3600;

describe("signed tokens", () => {
  it("verify to the owner they were signed for", () => {
    expect(verifyToken(SECRET, signToken(SECRET, { owner: "alice", exp: LATER }), NOW)).toBe(
      "alice",
    );
  });

  it("are refused once expired", () => {
    const token = signToken(SECRET, { owner: "alice", exp: Math.floor(NOW.getTime() / 1000) });
    expect(verifyToken(SECRET, token, NOW)).toBeUndefined();
  });

  it("are refused under another secret, or tampered with", () => {
    const token = signToken(SECRET, { owner: "alice", exp: LATER });
    expect(verifyToken("t".repeat(MIN_SECRET_LENGTH), token, NOW)).toBeUndefined();
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "mallory", exp: LATER })).toString(
      "base64url",
    );
    expect(verifyToken(SECRET, `${header}.${forged}.${signature}`, NOW)).toBeUndefined();
    expect(verifyToken(SECRET, "not-a-token", NOW)).toBeUndefined();
  });

  it("will not be minted for an owner that is not a valid name", () => {
    expect(() => signToken(SECRET, { owner: "no/slashes", exp: LATER })).toThrow();
  });
});
