/** The team UI's sign-in end to end (`apps/seshi/src/ui`): the page's PKCE flow against
 * `@seshi/auth/testing`'s IdP, the ID token traded at the real `POST /v1/auth/exchange`, and
 * the session token reading what its person may read, with the UI's files served in front of
 * the API as `seshi serve` serves them. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import { FakeIdp } from "@seshi/auth/testing";
import type { Instance } from "@seshi/instance";
import type { SearchResults } from "@seshi/model";
import { FsStore } from "@seshi/store";
import { finishSignIn, startSignIn, uiHandler, withUi } from "seshi/ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testInstance } from "../tooling/instance";

const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;
const log = (prompt: string) =>
  line({ role: "meta", source: "trajectory" }) +
  line({
    role: "user",
    content: `${prompt} ${"context ".repeat(300)}`,
    timestamp: "2026-11-01T10:00:00Z",
  }) +
  line({ role: "assistant", content: "done", timestamp: "2026-11-01T10:01:00Z" });

let dir: string;
let idp: FakeIdp;
let instance: Instance;
let fetchApp: (request: Request) => Response | Promise<Response>;
let orgKey: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-ui-"));
  const store = new FsStore(join(dir, "bucket"));
  idp = await FakeIdp.create();
  const auth = new Auth(
    {
      staticTokens: [],
      orgKey: true,
      admins: [],
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
    },
    { store, deployment: "test", oidcKeys: idp.keys },
  );
  instance = testInstance({ store, storage: { url: store.url }, auth });
  const app: App = createApp(instance);
  fetchApp = withUi(
    app.fetch,
    uiHandler({
      assets: { index: "<p>ui</p>", files: new Map() },
      issuer: () => instance.auth.modes().oidc?.issuer,
    }),
  );
  orgKey = (await auth.initAdmin({ owner: "ops" })).org_key?.token as string;
});

afterEach(async () => {
  await instance.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetchApp(new Request(`http://seshi.test${path}`, init));
}

async function store(user: string, sessionId: string, visibility: "org" | "owner") {
  const response = await api("/v1/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${orgKey}`,
      "x-seshi-user": user,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      format: "trajectory",
      session_id: sessionId,
      transcript: log(sessionId),
      visibility,
    }),
  });
  expect(response.status).toBe(201);
}

describe("the team UI", () => {
  it("signs in through the IdP with PKCE and reads what that person may read", async () => {
    await store("alice", "alice-shared", "org");
    await store("bob", "bob-private", "owner");
    await instance.search?.catchUp();

    const modes = await (await api("/v1/auth/config")).json();
    const { url, pending } = await startSignIn(
      modes.oidc,
      {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
      },
      "http://seshi.test/ui/",
      "#/",
    );
    // The IdP signs alice in and puts the nonce it was sent in her ID token.
    const nonce = new URL(url).searchParams.get("nonce") as string;
    const idToken = await idp.idToken({ sub: "alice", nonce });
    const answer = new URLSearchParams({ code: "code-1", state: pending.state });
    const signedIn = await finishSignIn(answer, pending, modes.oidc.client_id, async () =>
      Response.json({ id_token: idToken }),
    );

    const exchanged = await api("/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedIn),
    });
    expect(exchanged.status).toBe(200);
    const { session_token, owner } = await exchanged.json();
    expect(owner).toBe("alice");

    const browse = await api("/v1/search", {
      headers: { authorization: `Bearer ${session_token}` },
    });
    expect(browse.status).toBe(200);
    const results = (await browse.json()) as SearchResults;
    expect(results.results.map((r) => r.session_id)).toEqual(["alice-shared"]);
    const hidden = await api(`/v1/sessions/trajectory/bob-private?owner=bob`, {
      headers: { authorization: `Bearer ${session_token}` },
    });
    expect(hidden.status).toBe(404);
  });

  it("is refused an ID token minted for another sign-in (the nonce)", async () => {
    const idToken = await idp.idToken({ sub: "alice", nonce: "someone-elses" });
    const exchanged = await api("/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken, nonce: "mine" }),
    });
    expect(exchanged.status).toBe(401);
  });

  it("serves its page beside the API, and lets the page call the IdP's origin", async () => {
    const page = await api("/ui/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      `connect-src 'self' ${new URL(idp.issuer).origin};`,
    );
    expect((await api("/healthz")).status).toBe(200);
    expect((await api("/v1/me")).status).toBe(401);
  });
});
