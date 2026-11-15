import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unauthorized } from "@seshi/model";
import { FsStore } from "@seshi/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminInitError, Auth, AuthRequestError, DEVICE_TOKEN_DAYS } from "./auth";
import type { AuthSettings } from "./settings";
import { FakeIdp } from "./testing";

let dir: string;
let store: FsStore;
let clock: Date;
let idp: FakeIdp;

beforeAll(async () => {
  idp = await FakeIdp.create({ now: () => clock });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-auth-"));
  store = new FsStore(dir);
  clock = new Date("2026-11-14T09:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const STATIC = "static-token-0123456789";

function auth(settings: Partial<AuthSettings> = {}, sources?: string[]): Auth {
  return new Auth(
    {
      staticTokens: [{ token: STATIC, owner: "dev" }],
      orgKey: true,
      admins: ["boss@acme.com"],
      aliases: {},
      sessionKeys: { k1: "k".repeat(32) },
      oidc: {
        issuer: idp.issuer,
        client_id: "seshi-cli",
        audience: idp.audience,
        owner_claim: "sub",
        admin_group: "seshi-admins",
        groups_claim: "groups",
      },
      ...settings,
    },
    {
      store,
      deployment: "prod",
      now: () => clock,
      oidcKeys: idp.keys,
      ...(sources ? { sources } : {}),
    },
  );
}

const unauthorized = async (p: Promise<unknown>) => {
  await expect(p).rejects.toBeInstanceOf(Unauthorized);
};

describe("authenticate (X5.1)", () => {
  it("takes a static token as everything for its owner", async () => {
    const p = await auth().authenticate(STATIC);
    expect(p).toMatchObject({
      kind: "static",
      owner: "dev",
      owner_basis: "verified",
      role: "member",
      credential: "static",
    });
    expect(p.credential_id).toMatch(/^static-[0-9a-f]{16}$/);
    expect(p.credential_id).not.toContain(STATIC);
    expect([...p.scopes].sort()).toEqual([
      "search",
      "sessions:delete",
      "sessions:read",
      "sessions:write",
    ]);
  });

  it("takes the org key with a stated username as a claimed member, and needs the username (X5.12)", async () => {
    const a = auth();
    const { token } = await a.issue({ kind: "org" }, await a.authenticate(STATIC));
    const p = await a.authenticate(token, "Alice@Acme.com");
    expect(p).toMatchObject({
      kind: "person",
      owner: "alice@acme.com",
      owner_basis: "claimed",
      role: "member",
      credential: "org_key",
      claims: { username: "Alice@Acme.com" },
    });
    expect(p.scopes.has("sessions:delete")).toBe(false);
    await expect(a.authenticate(token)).rejects.toThrow("X-Seshi-User");
    await expect(a.authenticate(token, "  ")).rejects.toThrow("X-Seshi-User");
    // auth.org_key.enabled = false turns trust off.
    await expect(auth({ orgKey: false }).authenticate(token, "alice")).rejects.toThrow(
      "turned off",
    );
  });

  it("takes stored admin, device and service tokens as their kind", async () => {
    const a = auth({}, ["otlp"]);
    const by = await a.authenticate(STATIC);
    const admin = await a.issue({ kind: "admin", owner: "ops" }, by);
    const device = await a.issue({ kind: "device", owner: "00uAlice", visibility: "owner" }, by);
    const writer = await a.issue(
      { kind: "service", service: "otlp", scopes: ["sessions:write"] },
      by,
    );
    const reader = await a.issue({ kind: "service", service: "sync" }, by);
    expect(await a.authenticate(admin.token)).toMatchObject({
      kind: "admin",
      role: "admin",
      owner: "ops",
    });
    expect(await a.authenticate(device.token)).toMatchObject({
      kind: "device",
      owner: "00uAlice",
      visibility: "owner",
      credential_id: device.record.id,
    });
    expect(device.record.expires_at).toBe(
      new Date(clock.getTime() + DEVICE_TOKEN_DAYS * 86_400_000).toISOString(),
    );
    expect(await a.authenticate(writer.token)).toMatchObject({
      kind: "service",
      owner: "svc:otlp",
      owner_basis: "service",
      role: "service",
    });
    expect([...(await a.authenticate(reader.token)).scopes]).toEqual(["sessions:read", "search"]);
  });

  it("refuses no token, an unknown one, a revoked one and a forged session token", async () => {
    const a = auth();
    await unauthorized(a.authenticate(undefined));
    await unauthorized(a.authenticate("nope-0123456789abcdef"));
    await unauthorized(a.authenticate(`seshi_${"0".repeat(20)}_${"a".repeat(43)}`));
    const { token, record } = await a.issue(
      { kind: "admin", owner: "ops" },
      await a.authenticate(STATIC),
    );
    await a.tokens.revoke(record.id);
    await unauthorized(a.authenticate(token));
    await unauthorized(a.authenticate("a.b.c"));
  });
});

describe("the IdP exchange (X5.2)", () => {
  it("answers a member's session token for a valid ID token", async () => {
    const a = auth();
    const result = await a.exchange({ id_token: await idp.idToken({ email: "alice@acme.com" }) });
    expect(result).toMatchObject({
      owner: "00uAlice",
      role: "member",
      scopes: ["sessions:read", "search", "sessions:delete"],
      expires_at: "2026-11-14T10:00:00.000Z",
    });
    expect(result.device_token).toBeUndefined();
    const p = await a.authenticate(result.session_token);
    expect(p).toMatchObject({
      kind: "person",
      owner: "00uAlice",
      owner_basis: "verified",
      credential: "session",
      issued_at: clock,
      claims: { email: "alice@acme.com" },
    });
    // An hour on, it is gone; nothing in the bucket was needed to check it.
    clock = new Date(clock.getTime() + 3600_000);
    await unauthorized(a.authenticate(result.session_token));
  });

  it("makes admins from the IdP group or the admins list (X5.3)", async () => {
    const a = auth();
    const byGroup = await a.exchange({ id_token: await idp.idToken({ groups: ["seshi-admins"] }) });
    expect(byGroup.role).toBe("admin");
    expect((await a.authenticate(byGroup.session_token)).kind).toBe("admin");
    const byEmail = await a.exchange({
      id_token: await idp.idToken({ email: "Boss@Acme.com", email_verified: true }),
    });
    expect(byEmail.role).toBe("admin");
    const unverified = await a.exchange({
      id_token: await idp.idToken({ email: "boss@acme.com", email_verified: false }),
    });
    expect(unverified.role).toBe("member");
  });

  it("gives a device token on the first sign-in from a machine, and renews it on the next", async () => {
    const a = auth();
    const first = await a.exchange({
      id_token: await idp.idToken({ email: "alice@acme.com" }),
      machine: { id: "mbp-7", name: "Alice's laptop" },
      visibility: "owner",
    });
    expect(first.device_token).toBeDefined();
    const device = await a.authenticate(first.device_token?.token);
    expect(device).toMatchObject({
      kind: "device",
      owner: "00uAlice",
      visibility: "owner",
      claims: { email: "alice@acme.com" },
    });
    expect([...device.scopes]).toEqual(["sessions:write"]);
    const record = await a.tokens.get(first.device_token?.id as string);
    expect(record).toMatchObject({
      machine: { id: "mbp-7", name: "Alice's laptop" },
      label: "Alice's laptop",
    });
    const second = await a.exchange({ id_token: await idp.idToken(), machine: { id: "mbp-7" } });
    await unauthorized(a.authenticate(first.device_token?.token));
    expect((await a.authenticate(second.device_token?.token)).owner).toBe("00uAlice");
    // Another machine keeps its own.
    const other = await a.exchange({ id_token: await idp.idToken(), machine: { id: "desk" } });
    expect((await a.authenticate(second.device_token?.token)).owner).toBe("00uAlice");
    expect(other.device_token?.id).not.toBe(second.device_token?.id);
  });

  it("refuses a bad ID token, one without the owner claim, and has nothing to do without an IdP", async () => {
    const a = auth();
    await unauthorized(a.exchange({ id_token: await idp.idToken({ aud: "elsewhere" }) }));
    await unauthorized(a.exchange({ id_token: await idp.idToken({ nonce: "x" }), nonce: "y" }));
    const byEmail = auth({
      oidc: {
        issuer: idp.issuer,
        client_id: "c",
        audience: idp.audience,
        owner_claim: "email",
        groups_claim: "groups",
      },
    });
    await expect(byEmail.exchange({ id_token: await idp.idToken() })).rejects.toThrow(
      "email claim",
    );
    expect(
      (await byEmail.exchange({ id_token: await idp.idToken({ email: "A@B.co" }) })).owner,
    ).toBe("a@b.co");
    const none = auth({ oidc: undefined });
    await expect(none.exchange({ id_token: "x" })).rejects.toBeInstanceOf(AuthRequestError);
    await expect(
      a.exchange({ id_token: await idp.idToken(), machine: { id: "bad id/../" } }),
    ).rejects.toThrow("machine.id");
  });

  it("needs a session key to sign with when an IdP is set", () => {
    expect(() => auth({ sessionKeys: {} })).toThrow("auth.session_keys");
  });

  it("tells the CLI which ways in the server takes (X5.7)", () => {
    expect(auth().modes()).toEqual({
      org_key: true,
      oidc: {
        issuer: idp.issuer,
        client_id: "seshi-cli",
        audience: idp.audience,
        scopes: ["openid", "email", "profile"],
      },
      session_token_seconds: 3600,
      delete_fresh_seconds: 600,
    });
    expect(auth({ oidc: undefined, orgKey: false }).modes()).toMatchObject({
      org_key: false,
      oidc: null,
    });
  });
});

describe("issuing tokens (X5.9)", () => {
  it("refuses requests that make no sense", async () => {
    const a = auth({}, ["otlp"]);
    const by = await a.authenticate(STATIC);
    const refused = (p: Promise<unknown>, message: string) => expect(p).rejects.toThrow(message);
    await refused(a.issue({ kind: "device" }, by), "person's owner id");
    await refused(a.issue({ kind: "admin", owner: "svc:otlp" }, by), "person's owner id");
    await refused(a.issue({ kind: "service" }, by), "needs service");
    await refused(a.issue({ kind: "service", service: "Bad Name" }, by), "words of a-z");
    await refused(
      a.issue({ kind: "service", service: "otlp", scopes: ["sessions:write", "search"] }, by),
      "not both",
    );
    await refused(
      a.issue({ kind: "service", service: "nope", scopes: ["sessions:write"] }, by),
      "no source has id 'nope'",
    );
    await refused(
      a.issue({ kind: "admin", owner: "ops", expires_at: new Date(clock.getTime() - 1) }, by),
      "in the future",
    );
    await refused(auth({ orgKey: false }).issue({ kind: "org" }, by), "turned off");
  });

  it("records who created a token", async () => {
    const a = auth();
    const { record } = await a.issue(
      { kind: "admin", owner: "ops", label: "break glass" },
      await a.authenticate(STATIC),
    );
    expect(record).toMatchObject({
      label: "break glass",
      created_by: { kind: "static", principal: "dev" },
    });
  });
});

describe("seshi admin init (X5.12)", () => {
  it("makes the first admin token and the org key once", async () => {
    const a = auth();
    const first = await a.initAdmin({ owner: "ops@acme.com" });
    expect(first.admin?.record).toMatchObject({
      kind: "admin",
      owner: "ops@acme.com",
      expires_at: null,
    });
    expect(first.org_key?.record).toMatchObject({ kind: "org", owner: "*" });
    expect((await a.authenticate(first.admin?.token)).role).toBe("admin");
    expect((await a.authenticate(first.org_key?.token, "bob")).owner).toBe("bob");
    await expect(a.initAdmin({ owner: "ops" })).rejects.toBeInstanceOf(AdminInitError);
    await expect(a.initAdmin({ owner: "ops" })).rejects.toThrow("already set up");
  });

  it("makes another admin with --force, and rotates the org key with --rotate-org-key (X5.11)", async () => {
    const a = auth();
    const first = await a.initAdmin({ owner: "ops" });
    const forced = await a.initAdmin({ owner: "ops2", force: true });
    expect(forced.admin?.record.owner).toBe("ops2");
    expect(forced.org_key).toBeUndefined();
    const rotated = await a.initAdmin({ owner: "ops", rotateOrgKey: true });
    expect(rotated.admin).toBeUndefined();
    expect(rotated.revoked.map((r) => r.id)).toEqual([first.org_key?.record.id]);
    await unauthorized(a.authenticate(first.org_key?.token, "bob"));
    expect((await a.authenticate(rotated.org_key?.token, "bob")).owner).toBe("bob");
  });

  it("makes no org key when the org key is off, and checks the owner", async () => {
    const a = auth({ orgKey: false });
    const result = await a.initAdmin({ owner: "ops" });
    expect(result.org_key).toBeUndefined();
    await expect(a.initAdmin({ owner: "ops", rotateOrgKey: true })).rejects.toThrow("turned off");
    await expect(auth().initAdmin({ owner: "svc:x" })).rejects.toThrow("--owner");
  });
});
