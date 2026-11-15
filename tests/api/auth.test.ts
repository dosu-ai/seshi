/** Identity and access over HTTP (X5): the org key, the IdP exchange, session, device, admin
 * and service tokens, visibility, deletes and replaces, owner aliases and the token admin API,
 * against the real routes and a folder bucket. The IdP is `@seshi/auth/testing`'s stand-in. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth, type AuthSettings } from "@seshi/auth";
import { FakeIdp } from "@seshi/auth/testing";
import { archiveId, FsStore, readChanges, readMetadata } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const FORMATS = buildFormats();
const SMALL = transcript("claude-basic.claude-code.jsonl");
/** A Claude Code session long enough to pass the session filter. */
const CLAUDE = (marker = "details") =>
  `${SMALL.trim()}\n${JSON.stringify({
    type: "assistant",
    uuid: "a3",
    timestamp: "2026-09-01T00:00:08.000Z",
    sessionId: "sess1",
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: `The auth flow (${marker}): ${"details ".repeat(400)}` }],
    },
  })}\n`;
const DEV = "static-dev-token-0123456789";

let dir: string;
let store: FsStore;
let clock: Date;
let idp: FakeIdp;
let app: App;
let auth: Auth;

beforeAll(async () => {
  idp = await FakeIdp.create({ now: () => clock });
});

function build(
  settings: Partial<AuthSettings> = {},
  options: { visibility?: "org" | "owner" } = {},
) {
  auth = new Auth(
    {
      staticTokens: [{ token: DEV, owner: "dev" }],
      orgKey: true,
      admins: [],
      aliases: { "alice-old": "alice" },
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
    { store, deployment: "test", now: () => clock, oidcKeys: idp.keys, sources: ["otlp"] },
  );
  app = createApp({
    store,
    storage: { url: store.url },
    formats: FORMATS,
    auth,
    now: () => clock,
    ...(options.visibility ? { visibility: options.visibility } : {}),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-auth-api-"));
  store = new FsStore(`file://${join(dir, "bucket")}`);
  clock = new Date("2026-11-14T09:00:00.000Z");
  build();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
  token?: string;
  user?: string;
  body?: unknown;
}

async function call(method: string, path: string, options: Call = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.user !== undefined) headers["x-seshi-user"] = options.user;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.fetch(new Request(`http://seshi.test${path}`, { method, headers, body }));
  // biome-ignore lint/suspicious/noExplicitAny: test responses are read by path
  return { status: res.status, body: (await res.json()) as any };
}

/** Each session gets its own text and a moment of its own, so no two change entries share a
 * key (`<stamp>-<content_hash>`). */
const upload = (as: Call, sessionId: string, extra: Record<string, unknown> = {}) => {
  clock = new Date(clock.getTime() + 1000);
  return call("POST", "/v1/sessions", {
    ...as,
    body: { agent: "claude-code", session_id: sessionId, transcript: CLAUDE(sessionId), ...extra },
  });
};

/** Tokens made the way an operator would: `seshi admin init`, then the token API. */
async function setUp() {
  const init = await auth.initAdmin({ owner: "ops" });
  const admin = { token: init.admin?.token as string };
  const orgKey = init.org_key?.token as string;
  const mint = async (body: Record<string, unknown>) => {
    const res = await call("POST", "/v1/tokens", { ...admin, body });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };
  return {
    admin,
    alice: { token: orgKey, user: "Alice" },
    bob: { token: orgKey, user: "bob" },
    mint,
  };
}

async function signIn(claims: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/auth/exchange", {
    body: { id_token: await idp.idToken(claims), ...extra },
  });
  expect(res.status).toBe(200);
  return res.body;
}

describe("GET /v1/auth/config (X5.7)", () => {
  it("tells the CLI the server's modes, without a credential", async () => {
    const res = await call("GET", "/v1/auth/config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      org_key: true,
      oidc: { issuer: idp.issuer, client_id: "seshi-cli", scopes: ["openid", "email", "profile"] },
      session_token_seconds: 3600,
    });
  });
});

describe("the org key (X5.12)", () => {
  it("writes as the stated username, lowercased, with a claimed owner", async () => {
    const { alice } = await setUp();
    const res = await upload(alice, "s1", {
      claims: { git_email: "alice@acme.com", password: "x" },
    });
    expect(res.status).toBe(201);
    const stored = await readMetadata(store, "alice", archiveId("alice", "claude-code", "s1"));
    expect(stored).toMatchObject({
      owner: "alice",
      owner_basis: "claimed",
      writer: { kind: "person", principal: "alice", source_id: "upload" },
      claims: { username: "Alice", git_email: "alice@acme.com" },
    });
    expect(stored?.claims).not.toHaveProperty("password");
    const me = await call("GET", "/v1/me", alice);
    expect(me.body).toMatchObject({ owner: "alice", kind: "person", owner_basis: "claimed" });
  });

  it("needs the username, and stops working when turned off or rotated", async () => {
    const { alice } = await setUp();
    expect((await call("GET", "/v1/me", { token: alice.token })).status).toBe(401);
    const rotated = await auth.initAdmin({ owner: "ops", rotateOrgKey: true });
    expect((await call("GET", "/v1/me", alice)).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: rotated.org_key?.token, user: "a" })).status).toBe(
      200,
    );
    build({ orgKey: false });
    expect((await call("GET", "/v1/me", { token: rotated.org_key?.token, user: "a" })).status).toBe(
      401,
    );
  });

  it("reads org-wide but cannot delete, even its own (X5.3)", async () => {
    const { alice, bob } = await setUp();
    await upload(alice, "s1");
    const read = await call("GET", "/v1/sessions/claude-code/s1?owner=alice", bob);
    expect(read.status).toBe(200);
    expect((await call("DELETE", "/v1/sessions/claude-code/s1", alice)).status).toBe(403);
  });
});

describe("visibility (X5.10)", () => {
  it("hides an owner-visible session from other members, not from admins or readers", async () => {
    const { alice, bob, admin, mint } = await setUp();
    await upload(alice, "private", { visibility: "owner" });
    await upload(alice, "shared");
    const reader = { token: await mint({ kind: "service", service: "sync" }) };
    expect((await call("GET", "/v1/sessions/claude-code/private", alice)).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/private?owner=alice", bob)).status).toBe(
      404,
    );
    expect(
      (await call("GET", "/v1/sessions/claude-code/private/trace?owner=alice", bob)).status,
    ).toBe(404);
    expect(
      (await call("GET", "/v1/sessions/claude-code/shared/trace?owner=alice", bob)).status,
    ).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/private?owner=alice", admin)).status).toBe(
      200,
    );
    expect((await call("GET", "/v1/sessions/claude-code/private?owner=alice", reader)).status).toBe(
      200,
    );
    const listed = await call("GET", "/v1/sessions?owner=alice", bob);
    expect(listed.body.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([
      "shared",
    ]);
    const all = await call("GET", "/v1/sessions?owner=alice", reader);
    expect(all.body.sessions).toHaveLength(2);
    // The change feed shows bob only what he may read.
    const feed = await call("GET", "/v1/changes?owner=alice", bob);
    expect(
      feed.body.entries.map((e: { entry: { session_id: string } }) => e.entry.session_id),
    ).toEqual(["shared"]);
    expect((await call("GET", "/v1/changes?owner=alice", alice)).body.entries).toHaveLength(2);
  });

  it("takes the request's visibility, then the token's default, then the server's", async () => {
    build({}, { visibility: "owner" });
    const { alice, mint } = await setUp();
    const device = { token: await mint({ kind: "device", owner: "carol", visibility: "org" }) };
    await upload(alice, "server-default");
    await upload(device, "token-default");
    await upload(device, "request", { visibility: "owner" });
    const visibility = async (owner: string, id: string) =>
      (await readMetadata(store, owner, archiveId(owner, "claude-code", id)))?.visibility;
    expect(await visibility("alice", "server-default")).toBe("owner");
    expect(await visibility("carol", "token-default")).toBe("org");
    expect(await visibility("carol", "request")).toBe("owner");
  });

  it("lets the owner or an admin change it, with a change entry (PATCH)", async () => {
    const { alice, bob, admin, mint } = await setUp();
    await upload(alice, "s1");
    const patch = (as: Call, visibility: unknown, owner = "alice") => {
      clock = new Date(clock.getTime() + 1000);
      return call("PATCH", `/v1/sessions/claude-code/s1?owner=${owner}`, {
        ...as,
        body: { visibility },
      });
    };
    expect((await patch(bob, "owner")).status).toBe(403);
    const device = { token: await mint({ kind: "device", owner: "alice" }) };
    expect((await patch(device, "owner")).status).toBe(403);
    expect((await patch(alice, "sideways")).status).toBe(400);
    const changed = await patch(alice, "owner");
    expect(changed.status).toBe(200);
    expect(changed.body.visibility).toBe("owner");
    expect((await call("GET", "/v1/sessions/claude-code/s1?owner=alice", bob)).status).toBe(404);
    expect((await patch(admin, "org")).body.visibility).toBe("org");
    const { entries } = await readChanges(store, "alice");
    expect(
      entries.filter((e) => e.entry.kind === "visibility_changed").map((e) => e.entry.writer.kind),
    ).toEqual(["person", "admin"]);
  });
});

describe("the IdP exchange (X5.2) and deletes (X5.3)", () => {
  it("answers 404 without an IdP and 401 for a bad ID token", async () => {
    expect(
      (
        await call("POST", "/v1/auth/exchange", {
          body: { id_token: await idp.idToken({ aud: "x" }) },
        })
      ).status,
    ).toBe(401);
    build({ oidc: undefined });
    const res = await call("POST", "/v1/auth/exchange", { body: { id_token: "x" } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("no_idp");
  });

  it("gives a device token that writes verified sessions, and a session token that reads", async () => {
    const signed = await signIn(
      { sub: "00uAlice", email: "alice@acme.com" },
      { machine: { id: "mbp", name: "laptop" } },
    );
    const device = { token: signed.device_token.token };
    const session = { token: signed.session_token };
    expect((await upload(device, "s1")).status).toBe(201);
    expect(
      await readMetadata(store, "00uAlice", archiveId("00uAlice", "claude-code", "s1")),
    ).toMatchObject({
      owner_basis: "verified",
      writer: { kind: "device", principal: "00uAlice", credential_id: signed.device_token.id },
      claims: { email: "alice@acme.com" },
    });
    expect((await call("GET", "/v1/sessions/claude-code/s1", device)).status).toBe(403);
    expect((await call("GET", "/v1/sessions/claude-code/s1", session)).status).toBe(200);
    expect((await upload(session, "s2")).status).toBe(403);
  });

  it("deletes with a fresh session token only, and only the person's own", async () => {
    const alice = await signIn({ sub: "alice" }, { machine: { id: "m" } });
    const bob = await signIn({ sub: "bob" });
    await upload({ token: alice.device_token.token }, "s1");
    await upload({ token: alice.device_token.token }, "s2");
    expect(
      (
        await call("DELETE", "/v1/sessions/claude-code/s1?owner=alice", {
          token: bob.session_token,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("DELETE", "/v1/sessions/claude-code/s1", { token: alice.session_token })).status,
    ).toBe(200);
    clock = new Date(clock.getTime() + 11 * 60_000);
    const stale = await call("DELETE", "/v1/sessions/claude-code/s2", {
      token: alice.session_token,
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.message).toContain("10 minutes");
    const fresh = await signIn({ sub: "alice" });
    expect(
      (await call("DELETE", "/v1/sessions/claude-code/s2", { token: fresh.session_token })).status,
    ).toBe(200);
  });

  it("lets an admin token delete anyone's session, and records the admin as the writer", async () => {
    const { alice, admin } = await setUp();
    await upload(alice, "s1");
    expect((await call("DELETE", "/v1/sessions/claude-code/s1?owner=alice", admin)).status).toBe(
      200,
    );
    const { entries } = await readChanges(store, "alice");
    expect(entries.at(-1)?.entry).toMatchObject({
      kind: "tombstone",
      writer: { kind: "admin", principal: "ops" },
    });
  });
});

describe("replace with real roles (X4.6)", () => {
  it("refuses an org-key caller replacing a session a device wrote under that name", async () => {
    const { alice, mint } = await setUp();
    const device = { token: await mint({ kind: "device", owner: "alice" }) };
    await upload(device, "s1");
    const rewritten = { transcript: CLAUDE("rewritten"), replace: true };
    // Anyone holding the org key can state "alice": a claimed caller never replaces a
    // session whose owner was verified (X5.3).
    const claimed = await upload(alice, "s1", rewritten);
    expect(claimed.status).toBe(403);
    expect(claimed.body.error.code).toBe("forbidden");
    // The device that wrote it may.
    expect((await upload(device, "s1", rewritten)).status).toBe(201);
  });

  it("keeps an org-key caller off a verified session: no new chunks, no visibility change (X5.12)", async () => {
    const { alice, admin, mint } = await setUp();
    const device = { token: await mint({ kind: "device", owner: "alice" }) };
    await upload(device, "s1", { visibility: "owner" });
    // Extending it would leave a session marked verified holding what anyone with the key sent.
    const extended = await call("POST", "/v1/sessions", {
      ...alice,
      body: {
        agent: "claude-code",
        session_id: "s1",
        transcript: `${CLAUDE("s1").trim()}\n${JSON.stringify({ type: "user", uuid: "u9", timestamp: "2026-09-01T00:00:09.000Z", sessionId: "sess1", message: { role: "user", content: "injected" } })}\n`,
      },
    });
    expect(extended.status).toBe(403);
    expect(extended.body.error.message).toContain("whose owner was verified");
    // Opening it to the org would show it to members who hold no org key.
    const patched = await call("PATCH", "/v1/sessions/claude-code/s1?owner=alice", {
      ...alice,
      body: { visibility: "org" },
    });
    expect(patched.status).toBe(403);
    expect(patched.body.error.message).toContain("whose owner was verified");
    expect(
      (await readMetadata(store, "alice", archiveId("alice", "claude-code", "s1")))?.visibility,
    ).toBe("owner");
    // An admin still can.
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/s1?owner=alice", {
          ...admin,
          body: { visibility: "org" },
        })
      ).status,
    ).toBe(200);
  });

  it("lets an admin token replace its own sessions, and the original writer replace theirs", async () => {
    const { admin, bob } = await setUp();
    await upload(bob, "s1");
    expect((await upload(bob, "s1", { transcript: CLAUDE("other"), replace: true })).status).toBe(
      201,
    );
    await upload(admin, "s2");
    expect((await upload(admin, "s2", { transcript: CLAUDE("x"), replace: true })).status).toBe(
      201,
    );
  });
});

describe("service accounts (X5.4)", () => {
  it("write as svc:<source-id>, visible org-wide, and a reader cannot write", async () => {
    const { alice, mint } = await setUp();
    const writer = {
      token: await mint({ kind: "service", service: "otlp", scopes: ["sessions:write"] }),
    };
    const reader = { token: await mint({ kind: "service", service: "sync" }) };
    expect((await upload(writer, "s1")).status).toBe(201);
    expect(
      await readMetadata(store, "svc:otlp", archiveId("svc:otlp", "claude-code", "s1")),
    ).toMatchObject({
      owner: "svc:otlp",
      owner_basis: "service",
      writer: { kind: "service", principal: "svc:otlp" },
    });
    expect((await upload(reader, "s2")).status).toBe(403);
    expect((await call("GET", "/v1/sessions/claude-code/s1?owner=svc:otlp", alice)).status).toBe(
      200,
    );
    const owners = await call("GET", "/v1/owners", alice);
    expect(owners.body.owners).toEqual(["svc:otlp"]);
  });
});

describe("owner aliases (X5.8)", () => {
  it("read sessions stored under an old owner id as the new one's", async () => {
    const { alice, bob } = await setUp();
    // Written under the old id by someone who still used it.
    await upload({ ...bob, user: "alice-old" }, "old", { visibility: "owner" });
    await upload(alice, "new", { visibility: "owner" });
    const mine = await call("GET", "/v1/sessions", alice);
    expect(mine.body.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual([
      "new",
      "old",
    ]);
    expect((await call("GET", "/v1/sessions/claude-code/old", alice)).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/old/trace", alice)).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/old?owner=alice", bob)).status).toBe(404);
  });
});

describe("the token API (X5.9, X5.11)", () => {
  it("is for tokens:admin only", async () => {
    const { alice } = await setUp();
    expect((await call("GET", "/v1/tokens", alice)).status).toBe(403);
    expect(
      (await call("POST", "/v1/tokens", { ...alice, body: { kind: "admin", owner: "x" } })).status,
    ).toBe(403);
    expect((await call("GET", "/v1/tokens")).status).toBe(401);
  });

  it("creates, lists without hashes, revokes one, and revokes all of an owner's at once", async () => {
    const { admin, mint } = await setUp();
    const d1 = await mint({ kind: "device", owner: "alice", label: "laptop" });
    const d2 = await mint({ kind: "device", owner: "alice" });
    const d3 = await mint({ kind: "device", owner: "bob" });
    const listed = await call("GET", "/v1/tokens?owner=alice", admin);
    expect(listed.body.tokens).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toContain("sha256:");
    expect(listed.body.tokens[0]).toMatchObject({ kind: "device", owner: "alice", revoked: false });
    const id = listed.body.tokens.find((t: { label?: string }) => t.label === "laptop").id;
    const one = await call("DELETE", `/v1/tokens/${id}`, admin);
    expect(one.body.token).toMatchObject({ id, revoked: true });
    expect((await call("GET", "/v1/me", { token: d1 })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: d2 })).status).toBe(200);
    const all = await call("POST", "/v1/tokens/revoke", { ...admin, body: { owner: "alice" } });
    expect(all.body.revoked).toHaveLength(1);
    expect((await call("GET", "/v1/me", { token: d2 })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: d3 })).status).toBe(200);
    expect((await call("GET", "/v1/tokens?owner=alice&all=true", admin)).body.tokens).toHaveLength(
      2,
    );
    expect((await call("DELETE", `/v1/tokens/${"0".repeat(20)}`, admin)).status).toBe(404);
    // Revoking by owner names a person or service account; the org key (owner `*`) is rotated.
    const star = await call("POST", "/v1/tokens/revoke", { ...admin, body: { owner: "*" } });
    expect(star.status).toBe(400);
    expect((await call("GET", "/v1/tokens?kind=org", admin)).body.tokens).toHaveLength(1);
  });

  it("refuses a request that makes no sense", async () => {
    const { admin } = await setUp();
    const bad = async (body: Record<string, unknown>) =>
      (await call("POST", "/v1/tokens", { ...admin, body })).status;
    expect(await bad({ kind: "root" })).toBe(400);
    expect(await bad({ kind: "device" })).toBe(400);
    expect(await bad({ kind: "service", service: "nope", scopes: ["sessions:write"] })).toBe(400);
    expect(await bad({ kind: "admin", owner: "x", expires_at: "yesterday" })).toBe(400);
    expect(await bad({ kind: "admin", owner: "x", scopes: "all" })).toBe(400);
  });
});

describe("static tokens", () => {
  it("stay everything for one owner, for development", async () => {
    const dev = { token: DEV };
    expect((await upload(dev, "s1")).status).toBe(201);
    expect((await call("DELETE", "/v1/sessions/claude-code/s1", dev)).status).toBe(200);
    expect((await call("GET", "/v1/tokens", dev)).status).toBe(403);
  });
});
