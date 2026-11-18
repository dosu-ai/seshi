/** `GET /v1/changes/all` end to end: who may read every owner's feed, that it carries
 * `owner`-only sessions to those who may, that `GET /v1/changes` is unchanged beside it, and
 * that a reader's cursor outlives the server. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import { Forbidden, HttpSessionDB, ServerError } from "@seshi/client";
import type { Instance } from "@seshi/instance";
import { SearchService } from "@seshi/search";
import { FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testInstance } from "../tooling/instance";

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
function log(prompt: string): string {
  const ts = "2026-11-01T10:00:00Z";
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: `${prompt} ${"context ".repeat(260)}`, timestamp: ts }) +
    line({ role: "assistant", content: "on it", timestamp: ts })
  );
}

let dir: string;
let store: FsStore;
let auth: Auth;
let orgKey: string;
let adminToken: string;
const instances: Instance[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-changes-all-"));
  store = new FsStore(join(dir, "bucket"));
  auth = new Auth(
    {
      staticTokens: [],
      orgKey: true,
      admins: [],
      aliases: {},
      sessionKeys: { k1: "k".repeat(32) },
    },
    { store, deployment: "test" },
  );
  const init = await auth.initAdmin({ owner: "ops" });
  orgKey = init.org_key?.token as string;
  adminToken = init.admin?.token as string;
});

afterEach(async () => {
  for (const i of instances.splice(0)) await i.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A server whose search index is the file at `indexPath`, or in memory. */
function server(indexPath?: string): {
  instance: Instance;
  app: App;
  as: (token: string, user?: string) => HttpSessionDB;
} {
  const instance = testInstance({
    store,
    storage: { url: store.url },
    auth,
    ...(indexPath
      ? {
          search: new SearchService({
            store,
            deployment: "test",
            settings: { path: indexPath, events: ["user", "assistant", "tool_call"] },
          }),
        }
      : {}),
  });
  instances.push(instance);
  const app = createApp(instance);
  const as = (token: string, user?: string) =>
    new HttpSessionDB({
      server: "http://seshi.test",
      token,
      ...(user ? { user } : {}),
      fetch: (url, init) => app.fetch(new Request(url, init)),
    });
  return { instance, app, as };
}

async function serviceToken(): Promise<string> {
  const issued = await auth.issue(
    { kind: "service", service: "adx", scopes: ["sessions:read", "search"] },
    await auth.authenticate(adminToken),
  );
  return issued.token;
}

async function seed(as: ReturnType<typeof server>["as"]): Promise<void> {
  await as(orgKey, "alice").ingest({
    agent: "trajectory",
    session_id: "open",
    transcript: log("deploy the payments service"),
  });
  await as(orgKey, "alice").ingest({
    agent: "trajectory",
    session_id: "private",
    transcript: log("rotate the secrets"),
    visibility: "owner",
  });
  await as(orgKey, "bob").ingest({
    agent: "trajectory",
    session_id: "docs",
    transcript: log("deploy the docs site"),
  });
}

const sessions = (page: { entries: { owner: string; entry: { session_id: string } }[] }) =>
  page.entries.map((e) => `${e.owner}/${e.entry.session_id}`).sort();

describe("GET /v1/changes/all", () => {
  it("serves service and admin callers every owner's entries, owner-only sessions included", async () => {
    const { instance, as } = server();
    await seed(as);
    await instance.search?.catchUp();
    const want = ["alice/open", "alice/private", "bob/docs"];
    const service = await serviceToken();
    expect(sessions(await as(service).allChanges())).toEqual(want);
    expect(sessions(await as(adminToken).allChanges())).toEqual(want);
    const adminSession = await auth.sessions?.sign({
      owner: "ops",
      role: "admin",
      scopes: ["sessions:read", "sessions:write", "sessions:delete", "search", "tokens:admin"],
    });
    expect(sessions(await as(adminSession?.token as string).allChanges())).toEqual(want);
  });

  it("refuses device, session and org-key callers outright, rather than filtering", async () => {
    const { instance, as } = server();
    await seed(as);
    await instance.search?.catchUp();
    const device = await auth.issue(
      { kind: "device", owner: "alice" },
      await auth.authenticate(adminToken),
    );
    const member = await auth.sessions?.sign({
      owner: "alice",
      role: "member",
      scopes: ["sessions:read", "search"],
    });
    for (const db of [as(device.token), as(member?.token as string), as(orgKey, "alice")]) {
      await expect(db.allChanges()).rejects.toBeInstanceOf(Forbidden);
    }
  });

  it("leaves GET /v1/changes as it was: the caller's own feed, filtered for others", async () => {
    const { instance, app, as } = server();
    await seed(as);
    await instance.search?.catchUp();
    const alice = await as(orgKey, "alice").changes();
    expect(alice.entries.every((e) => e.key.startsWith("owners/alice/changes/"))).toBe(true);
    expect(alice.entries.map((e) => e.entry.session_id).sort()).toEqual(["open", "private"]);
    expect(alice.cursor).toBe(alice.entries.at(-1)?.key);
    const response = await app.fetch(
      new Request("http://seshi.test/v1/changes?owner=alice", {
        headers: { authorization: `Bearer ${orgKey}`, "x-seshi-user": "bob" },
      }),
    );
    const bobSees = (await response.json()) as { entries: { entry: { session_id: string } }[] };
    expect(bobSees.entries.map((e) => e.entry.session_id)).toEqual(["open"]);
  });

  it("says why it cannot answer: 400, 503 while building, 404 without search", async () => {
    const { as } = server();
    const service = as(await serviceToken());
    await expect(service.allChanges()).rejects.toMatchObject({
      status: 503,
      code: "index_building",
    });
    const off = testInstance({
      store,
      storage: { url: store.url },
      auth,
      config: "[search]\nenabled = false",
    });
    instances.push(off);
    const offApp = createApp(off);
    const offClient = new HttpSessionDB({
      server: "http://seshi.test",
      token: adminToken,
      fetch: (url, init) => offApp.fetch(new Request(url, init)),
    });
    await expect(offClient.allChanges()).rejects.toMatchObject({
      status: 404,
      code: "search_disabled",
    });
    await expect(service.allChanges({ after: "owners/alice/changes/x" })).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it("keeps the reader's cursor working after the server restarts", async () => {
    const path = join(dir, "index", "search.sqlite");
    const first = server(path);
    await seed(first.as);
    await first.instance.search?.catchUp();
    const token = await serviceToken();
    const page = await first.as(token).allChanges({ limit: 1 });
    expect(page.truncated).toBe(true);
    const whole = (await first.as(token).allChanges()).entries.map((e) => e.key);
    await first.instance.close();
    instances.splice(instances.indexOf(first.instance), 1);

    const second = server(path);
    const rest = await second.as(token).allChanges({ after: page.cursor });
    expect(rest.entries.map((e) => e.key)).toEqual(whole.slice(1));
  });
});
