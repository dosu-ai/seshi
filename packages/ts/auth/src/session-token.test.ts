import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { looksLikeJwt, SESSION_TOKEN_SECONDS, SessionTokens } from "./session-token";

const K1 = "k".repeat(32);
const K2 = "q".repeat(40);
const at = new Date("2026-11-14T09:00:00.000Z");

function tokens(options: Partial<ConstructorParameters<typeof SessionTokens>[0]> = {}) {
  return new SessionTokens({ keys: { k1: K1 }, deployment: "prod", now: () => at, ...options });
}

describe("session tokens (X5.2, X5.9)", () => {
  it("sign one hour of a person's scopes, checked with no bucket read", async () => {
    const signer = tokens();
    const { token, id, expires_at } = await signer.sign({
      owner: "alice@acme.com",
      role: "member",
      scopes: ["sessions:read", "search", "sessions:delete"],
      email: "alice@acme.com",
    });
    expect(looksLikeJwt(token)).toBe(true);
    expect(expires_at.getTime() - at.getTime()).toBe(SESSION_TOKEN_SECONDS * 1000);
    expect(await signer.verify(token)).toEqual({
      owner: "alice@acme.com",
      role: "member",
      scopes: ["sessions:read", "search", "sessions:delete"],
      id,
      issued_at: at,
      expires_at,
      email: "alice@acme.com",
    });
    const header = JSON.parse(Buffer.from(token.split(".")[0] as string, "base64url").toString());
    expect(header).toEqual({ alg: "HS256", kid: "k1", typ: "JWT" });
  });

  it("expire after an hour", async () => {
    const { token } = await tokens().sign({ owner: "a", role: "member", scopes: [] });
    const anHourOn = new Date(at.getTime() + SESSION_TOKEN_SECONDS * 1000);
    expect(await tokens({ now: () => anHourOn }).verify(token)).toBeUndefined();
  });

  it("rotate: a new key signs, the old one still verifies until it is removed", async () => {
    const { token: old } = await tokens().sign({ owner: "a", role: "member", scopes: [] });
    const rotated = tokens({ keys: { k1: K1, k2: K2 }, signingKeyId: "k2" });
    const { token: fresh } = await rotated.sign({ owner: "a", role: "admin", scopes: [] });
    expect((await rotated.verify(old))?.owner).toBe("a");
    expect((await rotated.verify(fresh))?.role).toBe("admin");
    const k2only = tokens({ keys: { k2: K2 } });
    expect(await k2only.verify(old)).toBeUndefined();
    expect(await k2only.verify(fresh)).toBeDefined();
  });

  it("refuse another deployment's token, a tampered one, and alg none (X1.4)", async () => {
    const { token } = await tokens().sign({ owner: "alice", role: "member", scopes: [] });
    expect(await tokens({ deployment: "staging" }).verify(token)).toBeUndefined();
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "admin", role: "admin" })).toString("base64url")}.${s}`;
    expect(await tokens().verify(forged)).toBeUndefined();
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${token.split(".")[1]}.`;
    expect(await tokens().verify(none)).toBeUndefined();
    const unknownRole = await new SignJWT({ role: "service", scope: "" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("seshi")
      .setAudience("seshi:prod")
      .setSubject("x")
      .setJti("j")
      .setIssuedAt(Math.floor(at.getTime() / 1000))
      .setExpirationTime(Math.floor(at.getTime() / 1000) + 60)
      .sign(new TextEncoder().encode(K1));
    expect(await tokens().verify(unknownRole)).toBeUndefined();
  });

  it("need keys of 32+ characters and one to sign with", () => {
    expect(() => tokens({ keys: { k1: "short" } })).toThrow("32+ characters");
    expect(() => tokens({ keys: {} })).toThrow("auth.session_key_id");
    expect(() => tokens({ keys: { a: K1, b: K2 } })).toThrow("auth.session_key_id");
    expect(() => tokens({ keys: { "bad kid": K1 } })).toThrow("not a valid key id");
  });
});
