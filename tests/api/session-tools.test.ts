/** The session tools' endpoints end to end (docs/seshi/session-tools.md, phase 1): sessions
 * written through the API, the indexer over the change feed, and `GET /v1/search/sessions`
 * and `GET …/events` through `@seshi/client`, for callers that may read different things. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import { HttpSeshi, ServerError } from "@seshi/client";
import type { Instance } from "@seshi/instance";
import { Forbidden, type SessionList } from "@seshi/model";
import { setVisibility } from "@seshi/pipeline";
import { FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testInstance } from "../tooling/instance";

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

/** A session: a prompt, a tool call and its long output, and an answer, at `when`. */
function log(prompt: string, when: string): string {
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: prompt, timestamp: when }) +
    line({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", name: "Bash", args: '{"command":"bun test"}' }],
      timestamp: when,
    }) +
    line({
      role: "tool",
      tool_call_id: "c1",
      content: `FAIL ${"output ".repeat(1_000)}`,
      ok: false,
      timestamp: when,
    }) +
    line({ role: "assistant", content: "one test failed", timestamp: when })
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
  dir = mkdtempSync(join(tmpdir(), "seshi-session-tools-"));
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

function client(token: string, user?: string): HttpSeshi {
  return new HttpSeshi({
    server: "http://seshi.test",
    token,
    ...(user ? { user } : {}),
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
}

const ids = (l: SessionList) => l.sessions.map((s) => `${s.owner}/${s.session_id}`);

async function seed(): Promise<void> {
  const alice = client(orgKey, "alice");
  await alice.ingest({
    format: "trajectory",
    session_id: "pay",
    transcript: log("deploy the payments service", minutesAgo(30)),
    repo: "github.com/acme/payments",
    branch: "main",
    labels: { team: "platform" },
  });
  await alice.ingest({
    format: "trajectory",
    session_id: "rot",
    transcript: log("rotate the secret", minutesAgo(20)),
    visibility: "owner",
  });
  await alice.ingest({
    format: "trajectory",
    session_id: "old",
    transcript: log("an old session", "2026-01-05T10:00:00Z"),
  });
  await client(orgKey, "bob").ingest({
    format: "trajectory",
    session_id: "docs",
    transcript: log("write the docs", minutesAgo(10)),
    repo: "github.com/acme/docs",
  });
  await instance.search?.catchUp();
}

async function refused(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ServerError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("not refused");
}

describe("GET /v1/search/sessions", () => {
  it("lists what each caller may read, newest first, in the last 7 days by default", async () => {
    await seed();
    const alice = await client(orgKey, "alice").searchSessions();
    // Written newest last: listed newest first, by when they were written.
    expect(ids(alice)).toEqual(["bob/docs", "alice/rot", "alice/pay"]);
    expect(alice.sessions[2]).toMatchObject({
      repo: "github.com/acme/payments",
      branch: "main",
      labels: { team: "platform" },
      visibility: "org",
    });
    expect(Date.parse(alice.window.since)).toBeGreaterThan(NOW.getTime() - 8 * 86_400_000);
    expect(alice.index.ready_at).toBeDefined();
    expect(ids(await client(orgKey, "bob").searchSessions())).toEqual(["bob/docs", "alice/pay"]);
    expect(ids(await client(adminToken).searchSessions({ since: "2026-01-01T00:00:00Z" }))).toEqual(
      // Newest first by when each session was written, not when its events ran.
      ["bob/docs", "alice/old", "alice/rot", "alice/pay"],
    );
  });

  it("filters, pages with a cursor, and takes ages for since and until", async () => {
    await seed();
    const alice = client(orgKey, "alice");
    expect(ids(await alice.searchSessions({ repo: "payments" }))).toEqual(["alice/pay"]);
    expect(ids(await alice.searchSessions({ owner: "bob" }))).toEqual(["bob/docs"]);
    expect(ids(await alice.searchSessions({ labels: { team: "platform" } }))).toEqual([
      "alice/pay",
    ]);
    expect(ids(await alice.searchSessions({ since: "15m" }))).toEqual(["bob/docs"]);
    expect(ids(await alice.searchSessions({ until: "25m" }))).toEqual(["alice/pay"]);
    const first = await alice.searchSessions({ limit: 2 });
    expect(ids(first)).toEqual(["bob/docs", "alice/rot"]);
    const second = await alice.searchSessions({ limit: 2, after: first.cursor as string });
    expect(ids(second)).toEqual(["alice/pay"]);
    expect(second.cursor).toBeUndefined();
    // An until alone: the 7 days before it, not before now.
    expect(ids(await alice.searchSessions({ until: "2026-01-06T00:00:00Z" }))).toEqual([
      "alice/old",
    ]);
    expect(ids(await alice.searchSessions({ until: "2026-01-20T00:00:00Z" }))).toEqual([]);
    for (const bad of [{ after: "nope!" }, { since: "soon" }, { since: "7" }, { owner: "../x" }]) {
      expect(await refused(alice.searchSessions(bad))).toMatchObject({ status: 400 });
    }
  });

  it("re-checks each session against its live metadata, and keeps a device token to its own", async () => {
    await seed();
    // Owner-only now, before the index has read the change.
    await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "pay",
      visibility: "owner",
    });
    expect(ids(await client(orgKey, "bob").searchSessions())).toEqual(["bob/docs"]);
    // A page the live check empties reads on instead of answering nothing with a cursor.
    await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "pay",
      visibility: "org",
    });
    await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "old",
      visibility: "owner",
    });
    const bob = client(orgKey, "bob");
    const first = await bob.searchSessions({ since: "2026-01-01T00:00:00Z", limit: 1 });
    expect(ids(first)).toEqual(["bob/docs"]);
    const second = await bob.searchSessions({
      since: "2026-01-01T00:00:00Z",
      limit: 1,
      after: first.cursor as string,
    });
    expect(ids(second)).toEqual(["alice/pay"]);
    const device = await auth.issue(
      { kind: "device", owner: "bob" },
      await auth.authenticate(adminToken),
    );
    expect(ids(await client(device.token).searchSessions())).toEqual(["bob/docs"]);
    await expect(client(device.token).searchSessions({ owner: "alice" })).rejects.toBeInstanceOf(
      Forbidden,
    );
  });
});

describe("GET …/events", () => {
  it("reads a session's events by format or by archive id, condensed or full", async () => {
    await seed();
    const alice = client(orgKey, "alice");
    const read = await alice.sessionEvents("trajectory", "pay");
    expect(read.session).toMatchObject({
      owner: "alice",
      format: "trajectory",
      session_id: "pay",
      repo: "github.com/acme/payments",
      events: 4,
      traces: 1,
    });
    expect(read.events.map((e) => [e.seq, e.role, e.tool_name])).toEqual([
      [0, "user", undefined],
      [1, "tool_call", "Bash"],
      [2, "tool_result", "Bash"],
      [3, "assistant", undefined],
    ]);
    expect(read.events[2]).toMatchObject({ ok: false, chars: 7_004, cut: 6_804 });
    const archive = read.session.archive_id;
    const around = await client(orgKey, "bob").sessionEventsByArchive("alice", archive, {
      around: 2,
      context: 0,
      mode: "full",
    });
    expect(around.events.map((e) => [e.seq, e.text.length])).toEqual([[2, 7_004]]);
    expect(around.next).toBe(3);
    const piece = await alice.sessionEvents("trajectory", "pay", { event: 2, max_chars: 5_000 });
    expect(piece).toMatchObject({ next_offset: 5_000 });
    const roles = await alice.sessionEvents("trajectory", "pay", { roles: ["user", "assistant"] });
    expect(roles.events.map((e) => e.seq)).toEqual([0, 3]);
  });

  it("refuses as the trace routes do, and a changed head", async () => {
    await seed();
    const bob = client(orgKey, "bob");
    // Another member's owner-only session is not there for bob.
    expect(await refused(bob.sessionEvents("trajectory", "rot", {}, { owner: "alice" }))).toEqual({
      status: 404,
      code: "not_found",
    });
    const alice = client(orgKey, "alice");
    expect(await refused(alice.sessionEvents("trajectory", "none"))).toMatchObject({ status: 404 });
    expect(await refused(alice.sessionEvents("trajectory", "pay", { from: 3, to: 1 }))).toEqual({
      status: 400,
      code: "bad_query",
    });
    expect(
      await refused(alice.sessionEvents("trajectory", "pay", { head: "0".repeat(64) })),
    ).toEqual({ status: 409, code: "head_changed" });
    const response = await app.fetch(
      new Request("http://seshi.test/v1/sessions/trajectory/pay/events?bogus=1", {
        headers: { authorization: `Bearer ${orgKey}`, "x-seshi-user": "alice" },
      }),
    );
    expect(response.status).toBe(400);
    await client(adminToken).tombstone("trajectory", "pay", { owner: "alice" });
    expect(await refused(alice.sessionEvents("trajectory", "pay"))).toMatchObject({ status: 410 });
  });
});
