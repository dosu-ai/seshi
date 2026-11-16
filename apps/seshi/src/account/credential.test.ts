import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialFor, NotSignedIn, sessionUsable } from "./credential";
import { type LoginProfile, Logins } from "./logins";
import { MemorySecrets } from "./secrets";

const SERVER = "https://seshi.acme.com";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

let dir: string;
let logins: Logins;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-credential-"));
  logins = new Logins(dir, new MemorySecrets());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const oidcProfile = (over: Partial<LoginProfile> = {}): Omit<LoginProfile, "stored_in"> => ({
  server: SERVER,
  mode: "oidc",
  owner: "alice",
  oidc: {
    issuer: "https://idp.test",
    client_id: "seshi-cli",
    token_endpoint: "https://idp.test/token",
    flow: "device",
  },
  session: { issued_at: at(-5), expires_at: at(55) },
  device: { id: "d1", expires_at: at(60 * 24 * 90) },
  delete_fresh_seconds: 600,
  signed_in_at: at(-5),
  ...over,
});

const options = (extra: Record<string, unknown> = {}) => ({
  logins,
  env: {},
  now: () => NOW,
  ...extra,
});

describe("which session token is usable (X5.3)", () => {
  it("is one not about to expire, and for a delete one issued in the last ten minutes", () => {
    const p = { ...oidcProfile(), stored_in: "memory" } as LoginProfile;
    expect(sessionUsable(p, "read", NOW)).toBe(true);
    expect(sessionUsable(p, "delete", NOW)).toBe(true);
    const old = { ...p, session: { issued_at: at(-20), expires_at: at(40) } };
    expect(sessionUsable(old, "read", NOW)).toBe(true);
    expect(sessionUsable(old, "delete", NOW)).toBe(false);
    const ending = { ...p, session: { issued_at: at(-59.5), expires_at: at(0.5) } };
    expect(sessionUsable(ending, "read", NOW)).toBe(false);
    expect(sessionUsable({ ...p, session: undefined }, "read", NOW)).toBe(false);
  });
});

describe("the credential for a purpose", () => {
  it("is the session token to read and the device token to upload", async () => {
    await logins.save(oidcProfile(), { session: "jwt", device: "seshi_d", refresh: "rt" });
    expect((await credentialFor(options(), SERVER, "read")).token).toBe("jwt");
    expect((await credentialFor(options(), SERVER, "upload")).token).toBe("seshi_d");
  });

  it("refuses an expired device token: signing in renews it", async () => {
    await logins.save(oidcProfile({ device: { id: "d1", expires_at: at(-1) } }), {
      device: "seshi_d",
    });
    await expect(credentialFor(options(), SERVER, "upload")).rejects.toThrow(
      /device token for https:\/\/seshi.acme.com has expired: run seshi login/,
    );
  });

  it("renews through the refresh token and the exchange, keeping a rotated refresh token", async () => {
    await logins.save(oidcProfile({ session: { issued_at: at(-70), expires_at: at(-10) } }), {
      session: "old",
      refresh: "rt1",
    });
    // An IdP that honours only the stored refresh token, and a server whose exchange takes only
    // the ID token the IdP issued, with its nonce.
    const claims = Buffer.from(JSON.stringify({ nonce: "n1" })).toString("base64url");
    const idToken = `h.${claims}.s`;
    const fetch = async (url: string, init?: RequestInit) => {
      if (url === "https://idp.test/token") {
        const form = new URLSearchParams(String(init?.body));
        if (form.get("refresh_token") !== "rt1") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ id_token: idToken, refresh_token: "rt2" });
      }
      const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      if (
        url !== `${SERVER}/v1/auth/exchange` ||
        body.id_token !== idToken ||
        body.nonce !== "n1"
      ) {
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      }
      return Response.json({
        session_token: "new",
        expires_at: at(60),
        owner: "alice",
        role: "member",
        scopes: ["sessions:read"],
      });
    };
    const credential = await credentialFor(options({ fetch }), SERVER, "read");
    expect(credential.token).toBe("new");
    expect(await logins.secret(SERVER, "refresh")).toBe("rt2");
    expect(await logins.secret(SERVER, "session")).toBe("new");
    expect(logins.get(SERVER)?.session).toEqual({
      issued_at: NOW.toISOString(),
      expires_at: at(60),
    });
  });

  it("asks for a sign-in when there is nothing to renew with, or the server refuses", async () => {
    await logins.save(oidcProfile({ session: { issued_at: at(-70), expires_at: at(-10) } }), {
      session: "old",
    });
    await expect(credentialFor(options(), SERVER, "read")).rejects.toThrow(
      /session .* has expired/,
    );
    await logins.update(SERVER, {}, { refresh: "rt" });
    const fetch = async (url: string) =>
      url.endsWith("/token")
        ? Response.json({ id_token: "a.e30.c" })
        : Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    await expect(credentialFor(options({ fetch }), SERVER, "read")).rejects.toThrow(
      /refused the renewed sign-in/,
    );
  });

  it("is the org key with the username resolved now, or a pasted token", async () => {
    await logins.save({ server: SERVER, mode: "org_key", signed_in_at: at(0) }, { org_key: "k" });
    const key = await credentialFor(
      options({ configuredUser: { user: "bob@acme.com", from: "SESHI_USER" } }),
      SERVER,
      "upload",
    );
    expect(key).toMatchObject({ token: "k", user: "bob@acme.com" });
    expect(
      (
        await credentialFor(
          options({ configuredUser: { user: "alice", from: "config" } }),
          SERVER,
          "read",
        )
      ).user,
    ).toBe("alice");
    await logins.save({ server: SERVER, mode: "token", signed_in_at: at(0) }, { token: "t" });
    expect(await credentialFor(options(), SERVER, "delete")).toMatchObject({ token: "t" });
  });

  it("is not signed in without a login, or when its secret is gone", async () => {
    await expect(credentialFor(options(), SERVER, "read")).rejects.toBeInstanceOf(NotSignedIn);
    await logins.save({ server: SERVER, mode: "token", signed_in_at: at(0) }, {});
    await expect(credentialFor(options(), SERVER, "read")).rejects.toThrow(/stored credential/);
  });
});
