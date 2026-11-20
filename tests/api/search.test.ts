/** Search end to end (F10): sessions written through the API by several kinds of caller, the
 * indexer over the change feed, and `GET /v1/search` through `@seshi/client`, checking that
 * every caller finds exactly what it may read (F10.4) and that the instance's job keeps the
 * index current. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import { HttpSessionDB, ServerError } from "@seshi/client";
import type { Instance } from "@seshi/instance";
import type { SearchResults, Trace } from "@seshi/model";
import { StoreSessionDB } from "@seshi/pipeline";
import { FsStore } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testInstance } from "../tooling/instance";

const FORMATS = buildFormats();
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const ts = "2026-11-01T10:00:00Z";
function log(prompt: string, when = ts): string {
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: `${prompt} ${"context ".repeat(260)}`, timestamp: when }) +
    line({ role: "assistant", content: "on it", timestamp: when })
  );
}

let dir: string;
let store: FsStore;
let auth: Auth;
let instance: Instance;
let app: App;
let orgKey: string;
let adminToken: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-search-api-"));
  store = new FsStore(join(dir, "bucket"));
  auth = new Auth(
    {
      staticTokens: [],
      orgKey: true,
      admins: [],
      aliases: { "old-alice": "alice" },
      sessionKeys: { k1: "k".repeat(32) },
    },
    { store, deployment: "test" },
  );
  instance = testInstance({ store, storage: { url: store.url }, auth });
  app = createApp(instance);
  const init = await auth.initAdmin({ owner: "ops" });
  orgKey = init.org_key?.token as string;
  adminToken = init.admin?.token as string;
});

afterEach(async () => {
  await instance.close();
  rmSync(dir, { recursive: true, force: true });
});

function client(token: string, user?: string): HttpSessionDB {
  return new HttpSessionDB({
    server: "http://seshi.test",
    token,
    ...(user ? { user } : {}),
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
}

const ids = (r: SearchResults) => r.results.map((x) => `${x.owner}/${x.session_id}`).sort();

async function seed(): Promise<void> {
  const alice = client(orgKey, "alice");
  const bob = client(orgKey, "bob");
  await alice.ingest({
    agent: "trajectory",
    session_id: "pay",
    transcript: log("deploy the payments service"),
    repo: "github.com/acme/payments",
    branch: "main",
  });
  await alice.ingest({
    agent: "trajectory",
    session_id: "rot",
    transcript: log("deploy the secret rotation", "2026-10-01T10:00:00Z"),
    visibility: "owner",
  });
  await bob.ingest({
    agent: "trajectory",
    session_id: "docs",
    transcript: log("deploy the docs site"),
    repo: "github.com/acme/docs",
  });
  // Written under alice's old owner id, which [auth.owner_aliases] folds into hers (X5.8).
  await new StoreSessionDB({ store, owner: "old-alice", formats: FORMATS }).ingest({
    agent: "trajectory",
    session_id: "legacy",
    transcript: log("deploy the legacy cron"),
    visibility: "owner",
  });
  await instance.search?.catchUp();
}

describe("GET /v1/search (F10)", () => {
  it("finds for each caller exactly what it may read (F10.4)", async () => {
    await seed();
    expect(ids(await client(orgKey, "alice").search({ q: "deploy" }))).toEqual([
      "alice/pay",
      "alice/rot",
      "bob/docs",
      "old-alice/legacy",
    ]);
    expect(ids(await client(orgKey, "bob").search({ q: "deploy" }))).toEqual([
      "alice/pay",
      "bob/docs",
    ]);
    expect(ids(await client(orgKey, "carol").search({ q: "secret OR legacy" }))).toEqual([]);
    expect((await client(adminToken).search({ q: "deploy" })).total).toBe(4);
    const service = await auth.issue(
      { kind: "service", service: "sync", scopes: ["sessions:read", "search"] },
      await auth.authenticate(adminToken),
    );
    expect(ids(await client(service.token).search({ q: "deploy" }))).toHaveLength(4);
    // Asking for someone's sessions narrows what the caller may see; it never widens it.
    expect(ids(await client(orgKey, "bob").search({ q: "deploy", owner: "alice" }))).toEqual([
      "alice/pay",
    ]);
  });

  it("filters by owner (aliases folded), repo, agent, branch, source and time", async () => {
    await seed();
    const admin = client(adminToken);
    expect(ids(await admin.search({ q: "deploy", owner: "alice" }))).toEqual([
      "alice/pay",
      "alice/rot",
      "old-alice/legacy",
    ]);
    expect(ids(await admin.search({ q: "deploy", repo: "payments" }))).toEqual(["alice/pay"]);
    expect(ids(await admin.search({ q: "deploy", branch: "main" }))).toEqual(["alice/pay"]);
    expect(ids(await admin.search({ q: "deploy", agent: "claude-code" }))).toEqual([]);
    expect((await admin.search({ q: "deploy", agent: "trajectory" })).total).toBe(4);
    expect((await admin.search({ q: "deploy", source: "upload" })).total).toBe(4);
    expect(ids(await admin.search({ q: "deploy", until: "2026-10-15T00:00:00Z" }))).toEqual([
      "alice/rot",
    ]);
    const page = await admin.search({ q: "deploy", limit: 3, matches: 1, sort: "recent" });
    expect(page.results).toHaveLength(3);
    expect(page.cursor).toBe("3");
    expect(page.results.every((r) => r.matches.length === 1)).toBe(true);
    const rest = await admin.search({ q: "deploy", limit: 3, cursor: page.cursor });
    expect(rest.results).toHaveLength(1);
  });

  it("records and filters by where a session ran and with what (repo, harness, model)", async () => {
    const alice = client(orgKey, "alice");
    await alice.ingest({
      agent: "trajectory",
      session_id: "api",
      transcript: log("deploy the api").replace(
        '{"role":"meta","source":"trajectory"}',
        '{"role":"meta","source":"trajectory","model":"gpt-9"}',
      ),
      project: "api",
      repo: "github.com/acme/api",
      commit: "a".repeat(40),
      path_in_repo: "services/api",
      client: "seshi/0.15.0 linux-x64",
    });
    await alice.ingest({
      agent: "trajectory",
      session_id: "web",
      transcript: log("deploy the web app"),
      project: "web",
      repo: "gitlab.com/acme/web",
      model: "hinted-model",
    });
    await instance.search?.catchUp();
    const admin = client(adminToken);
    expect(ids(await admin.search({ q: "deploy", repo: "acme/api" }))).toEqual(["alice/api"]);
    expect(ids(await admin.search({ q: "deploy", repo: "gitlab.com/acme/web" }))).toEqual([
      "alice/web",
    ]);
    expect(ids(await admin.search({ q: "deploy", model: "gpt-9" }))).toEqual(["alice/api"]);
    expect(ids(await admin.search({ q: "deploy", model: "hinted-model" }))).toEqual(["alice/web"]);
    expect((await admin.search({ q: "deploy", harness: "trajectory" })).total).toBe(2);
    expect((await admin.search({ q: "deploy", harness: "codex" })).total).toBe(0);
    const [hit] = (await admin.search({ q: "deploy", repo: "api" })).results;
    expect(hit).toMatchObject({
      project: "api",
      repo: "github.com/acme/api",
      harness: "trajectory",
      models: ["gpt-9"],
    });
    const session = await admin.getSession("trajectory", "api", { owner: "alice" });
    expect(session).toMatchObject({ repo: "github.com/acme/api", models: ["gpt-9"] });
    const trace = await admin.getTrace("trajectory", "api", undefined, undefined, {
      owner: "alice",
    });
    expect((trace as Trace | null)?.metadata).toMatchObject({
      commit: "a".repeat(40),
      path_in_repo: "services/api",
      client: "seshi/0.15.0 linux-x64",
    });
    // A repo with credentials never reaches the store; the session does.
    await alice.ingest({
      agent: "trajectory",
      session_id: "leak",
      transcript: log("deploy the leak"),
      repo: "user:ghp_token@github.com/acme/api",
    });
    const leak = await admin.getSession("trajectory", "leak", { owner: "alice" });
    expect(leak?.status).toBe("stored");
    expect(leak).not.toHaveProperty("repo");
  });

  it("points each match at its trace and event, with a snippet", async () => {
    await seed();
    const alice = client(orgKey, "alice");
    const [hit] = (await alice.search({ q: '"payments service"' })).results;
    const match = hit?.matches[0];
    if (!match) throw new Error("no match");
    expect(match).toMatchObject({ role: "user", event_index: 0 });
    const trace = await alice.getTrace("trajectory", "pay", match.content_hash);
    const event = (trace as { events: { index: number; text: string }[] }).events[
      match.event_index
    ];
    expect(event?.text).toContain("deploy the payments service");
    const [start, end] = match.highlights[0] as [number, number];
    // A phrase is one match.
    expect(match.snippet.slice(start, end)).toBe("payments service");
  });

  it("hides a session made private or deleted at once, before the indexer runs", async () => {
    await seed();
    const bob = client(orgKey, "bob");
    expect(ids(await bob.search({ q: "payments" }))).toEqual(["alice/pay"]);
    const changed = await app.fetch(
      new Request("http://seshi.test/v1/sessions/trajectory/pay", {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${orgKey}`,
          "x-seshi-user": "alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({ visibility: "owner" }),
      }),
    );
    expect(changed.status).toBe(200);
    expect(ids(await bob.search({ q: "payments" }))).toEqual([]);
    expect(await client(adminToken).tombstone("trajectory", "docs")).toBeNull();
    const removed = await app.fetch(
      new Request("http://seshi.test/v1/sessions/trajectory/docs?owner=bob", {
        method: "DELETE",
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(removed.status).toBe(200);
    expect(ids(await bob.search({ q: "docs" }))).toEqual([]);
    // Once the indexer has read those entries, the index agrees.
    await instance.search?.run();
    expect((await bob.search({ q: "payments" })).total).toBe(0);
    expect((await client(adminToken).search({ q: "docs" })).total).toBe(0);
  });

  it("answers 503 with Retry-After until the index has caught up, and 400 for a bad query", async () => {
    const waiting = await app.fetch(
      new Request("http://seshi.test/v1/search?q=x", {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get("retry-after")).toBe("5");
    await expect(client(adminToken).search({ q: "x" })).rejects.toMatchObject({
      status: 503,
      code: "index_building",
    });
    await instance.search?.catchUp();
    const bad = client(adminToken).search({ q: '"" --' });
    await expect(bad).rejects.toBeInstanceOf(ServerError);
    await expect(bad).rejects.toMatchObject({ status: 400, code: "bad_query" });
  });

  it("says when search is turned off", async () => {
    const off = createApp(
      testInstance({
        store,
        storage: { url: store.url },
        auth,
        config: "[search]\nenabled = false",
      }),
    );
    const response = await off.fetch(
      new Request("http://seshi.test/v1/search?q=x", {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "search_disabled" } });
  });
});

describe("the indexer job (F10.2, X7)", () => {
  it("runs on an api instance and keeps the index current", async () => {
    const live = testInstance({
      store,
      storage: { url: store.url },
      auth,
      config: "[search]\ninterval = 30\n",
      roles: ["api"],
    });
    const liveApp = createApp(live);
    const alice = new HttpSessionDB({
      server: "http://seshi.test",
      token: orgKey,
      user: "alice",
      fetch: (url, init) => liveApp.fetch(new Request(url, init)),
    });
    live.start();
    try {
      const until = async (q: string, n: number) => {
        for (let i = 0; i < 200; i++) {
          try {
            if ((await alice.search({ q })).total === n) return;
          } catch (err) {
            if (!(err instanceof ServerError && err.status === 503)) throw err;
          }
          await Bun.sleep(20);
        }
        throw new Error(`never found ${n} for ${q}: ${JSON.stringify((await live.status()).jobs)}`);
      };
      await alice.ingest({
        agent: "trajectory",
        session_id: "j1",
        transcript: log("zebra crossing"),
      });
      await until("zebra", 1);
      await alice.ingest({
        agent: "trajectory",
        session_id: "j2",
        transcript: log("zebra stripes"),
      });
      await until("zebra", 2);
      const status = await live.status();
      const job = status.jobs.find((j) => j.name === "search-index");
      expect(job?.backlog).toMatchObject({ ready: 1, sessions: 2 });
      expect(job?.last?.last_outcome).toBe("ok");
    } finally {
      await live.close();
    }
  });

  it("is not on a worker-only instance, nor in local mode", () => {
    const names = (roles: ("api" | "worker")[]) =>
      testInstance({ store, storage: { url: store.url }, auth, roles })
        .jobs.list()
        .map((j) => j.name);
    expect(names(["worker"])).not.toContain("search-index");
    expect(names([])).not.toContain("search-index");
    expect(names(["api", "worker"])).toContain("search-index");
  });
});
