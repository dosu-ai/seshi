import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeEntry, DEFAULT_SEARCH_MAX_CHARS } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendQuery, IndexedEvent, IndexedSession, PageCommit } from "./backend";
import { MEMORY_INDEX } from "./paths";
import { parseQuery } from "./query";
import { fts5Match, INDEX_SCHEMA, SqliteIndex, snippetsSql, sqliteIndex } from "./sqlite";
import { LOCAL_VIEWER, type Viewer } from "./viewer";

const H = (n: number) => n.toString(16).padStart(64, "0");
const EVENTS = ["user", "assistant", "tool_call"] as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sqlite-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function memory(): SqliteIndex {
  return new SqliteIndex({ path: MEMORY_INDEX, deployment: "d1", events: EVENTS });
}

async function counts(index: SqliteIndex): Promise<{ sessions: number; events: number }> {
  const { sessions, events } = await index.state();
  return { sessions, events };
}

async function cursor(index: SqliteIndex, owner: string): Promise<string | undefined> {
  return (await index.cursors(await index.generation())).get(owner);
}

async function seen(index: SqliteIndex, owner: string, keys: string[]): Promise<Set<string>> {
  return index.seen(await index.generation(), owner, keys);
}

/** A page that only moves the feed's state. */
async function advance(
  index: SqliteIndex,
  owner: string,
  to: string | undefined,
  processed: { key: string; at: number }[],
  forgetBefore: number,
): Promise<void> {
  const generation = await index.generation();
  await index.commit({
    generation,
    owner,
    updates: [],
    removals: [],
    feed: [],
    seen: processed,
    cursor: to,
    forgetBefore,
  });
}

async function caughtUp(index: SqliteIndex, at: string): Promise<void> {
  await index.passDone(await index.generation(), at);
}

function session(n: number, fields: Partial<IndexedSession> = {}): IndexedSession {
  return {
    owner: "alice",
    archive_id: H(n),
    format: "claude-code",
    session_id: `s${n}`,
    visibility: "org",
    updated_at: "2026-11-14T09:00:00.000Z",
    traces: [H(100 + n)],
    event_count: 0,
    ...fields,
  };
}

function event(text: string, fields: Partial<IndexedEvent> = {}): IndexedEvent {
  const index = fields.event_index ?? 0;
  return {
    content_hash: H(100),
    event_index: index,
    seq: index,
    role: "user",
    text,
    chars: text.length,
    ...fields,
  };
}

const member = (owner: string): Viewer => ({
  everything: false,
  own: [owner],
  canRead: (s) => s.owner === owner || s.visibility !== "owner",
});

function query(index: SqliteIndex, q: string, extra: Partial<BackendQuery> = {}) {
  return index.query({
    match: parseQuery(q).match,
    viewer: LOCAL_VIEWER,
    sort: "relevance",
    limit: 20,
    offset: 0,
    matches: 3,
    ...extra,
  });
}

describe("SqliteIndex: sessions and events", () => {
  it("finds sessions by their events, best first, with marked snippets", async () => {
    const index = memory();
    index.apply({
      session: session(1),
      events: [
        event("deploy the widget service to staging"),
        event("ran the deploy script again, deploy deploy", { event_index: 2, role: "assistant" }),
      ],
      replace: true,
    });
    index.apply({ session: session(2), events: [event("unrelated chat")], replace: true });
    index.apply({ session: session(3), events: [event("one deploy")], replace: true });
    const found = await query(index, "deploy");
    expect(found.total).toBe(2);
    expect(found.hits.map((h) => h.session.session_id)).toEqual(["s1", "s3"]);
    const [first] = found.hits;
    expect(first?.hits).toBe(2);
    expect(first?.score).toBeGreaterThan(found.hits[1]?.score as number);
    expect(first?.matches[0]).toMatchObject({ event_index: 2, role: "assistant" });
    expect(first?.matches[0]?.marked).toContain("\u0001deploy\u0002");
    expect(await counts(index)).toEqual({ sessions: 3, events: 4 });
  });

  it("appends a continuation's events, and replaces when asked", async () => {
    const index = memory();
    index.apply({ session: session(1), events: [event("first chunk alpha")], replace: true });
    expect(
      index.apply({
        session: session(1, { traces: [H(101), H(201)], updated_at: "2026-11-14T10:00:00.000Z" }),
        events: [event("second chunk beta", { content_hash: H(201) })],
        replace: false,
        base: [H(101)],
      }),
    ).toBe(true);
    expect((await query(index, "alpha")).total).toBe(1);
    expect((await query(index, "beta")).hits[0]?.matches[0]?.content_hash).toBe(H(201));
    expect(index.session("alice", H(1))?.traces).toEqual([H(101), H(201)]);
    index.apply({
      session: session(1, { traces: [H(301)], updated_at: "2026-11-14T11:00:00.000Z" }),
      events: [event("rewritten gamma", { content_hash: H(301) })],
      replace: true,
    });
    expect((await query(index, "alpha")).total).toBe(0);
    expect((await query(index, "gamma")).total).toBe(1);
    expect((await counts(index)).events).toBe(1);
  });

  it("refuses an update read before what it holds, and a continuation of other traces", async () => {
    const index = memory();
    index.apply({
      session: session(1),
      events: [event("newer text")],
      replace: true,
      read_at: 2000,
    });
    const older = index.apply({
      session: session(1),
      events: [event("older text")],
      replace: true,
      read_at: 1000,
    });
    expect(older).toBe(false);
    expect((await query(index, "older")).total).toBe(0);
    // The metadata's updated_at does not order updates: writers' clocks disagree, so a
    // continuation stamped behind what it extends is still applied.
    const behind = index.apply({
      session: session(1, { traces: [H(101), H(2)], updated_at: "2026-11-14T08:00:00.000Z" }),
      events: [event("continued text", { content_hash: H(2) })],
      replace: false,
      base: [H(101)],
      read_at: 3000,
    });
    expect(behind).toBe(true);
    expect((await query(index, "continued")).total).toBe(1);
    const wrongBase = index.apply({
      session: session(1, { traces: [H(9), H(10)] }),
      events: [event("duplicate")],
      replace: false,
      base: [H(9)],
      read_at: 4000,
    });
    expect(wrongBase).toBe(false);
    expect((await query(index, "duplicate")).total).toBe(0);
  });

  it("removes a session, remembering the removal against late updates", async () => {
    const index = memory();
    index.apply({ session: session(1), events: [event("secret plan")], replace: true, read_at: 1 });
    expect(index.remove("alice", H(1), 5000)).toBe(true);
    expect((await query(index, "secret")).total).toBe(0);
    expect(index.session("alice", H(1))).toBeNull();
    expect(await counts(index)).toEqual({ sessions: 0, events: 0 });
    // A slower process indexing the session as it was before the tombstone is refused.
    const late = { session: session(1), events: [event("secret plan")], replace: true };
    expect(index.apply({ ...late, read_at: 4000 })).toBe(false);
    expect((await query(index, "secret")).total).toBe(0);
    // A removal read before what the index holds changes nothing.
    index.apply({ session: session(2), events: [event("other")], replace: true, read_at: 9000 });
    expect(index.remove("alice", H(2), 8000)).toBe(false);
    expect((await query(index, "other")).total).toBe(1);
    // A session never held is remembered as removed too, against a late update.
    expect(index.remove("nobody", H(7), 5000)).toBe(true);
    expect(index.session("nobody", H(7))).toBeNull();
    expect(
      index.apply({
        session: session(7, { owner: "nobody" }),
        events: [event("ghost")],
        replace: true,
        read_at: 4000,
      }),
    ).toBe(false);
    expect((await query(index, "ghost")).total).toBe(0);
    // A session read again after its removal (it came back) is indexed.
    expect(index.apply({ ...late, read_at: 6000 })).toBe(true);
  });

  it("skips empty text and caps what it stores", async () => {
    const index = memory();
    index.apply({
      session: session(1),
      events: [event("   "), event(`${"word ".repeat(10_000)} needle`)],
      replace: true,
    });
    expect((await counts(index)).events).toBe(1);
    expect((await query(index, "needle")).total).toBe(0);
    expect((await query(index, "word")).total).toBe(1);
  });
});

describe("SqliteIndex: the permission filter (F10.4)", () => {
  function seeded(): SqliteIndex {
    const index = memory();
    index.apply({ session: session(1), events: [event("plan")], replace: true });
    index.apply({
      session: session(2, { visibility: "owner" }),
      events: [event("plan")],
      replace: true,
    });
    index.apply({
      session: session(3, { owner: "bob", visibility: "owner" }),
      events: [event("plan")],
      replace: true,
    });
    index.apply({ session: session(4, { owner: "bob" }), events: [event("plan")], replace: true });
    return index;
  }

  it("shows a member their own sessions and the org's, never another's private ones", async () => {
    const index = seeded();
    const ids = async (viewer: Viewer) =>
      (await query(index, "plan", { viewer })).hits.map((h) => h.session.session_id).sort();
    expect(await ids(member("alice"))).toEqual(["s1", "s2", "s4"]);
    expect(await ids(member("bob"))).toEqual(["s1", "s3", "s4"]);
    expect(await ids({ everything: false, own: [], canRead: () => false })).toEqual(["s1", "s4"]);
    // A credential without the search scope: its own owner's sessions only, never the org's.
    expect(
      await ids({ everything: false, own: ["bob"], ownOnly: true, canRead: () => true }),
    ).toEqual(["s3", "s4"]);
    expect(await ids({ everything: true, own: [], ownOnly: true, canRead: () => true })).toEqual(
      [],
    );
    expect(await ids(LOCAL_VIEWER)).toEqual(["s1", "s2", "s3", "s4"]);
    // An owner filter narrows; it never widens past what the viewer may see.
    expect(
      (await query(index, "plan", { viewer: member("alice"), owners: ["bob"] })).hits.map(
        (h) => h.session.session_id,
      ),
    ).toEqual(["s4"]);
    expect((await query(index, "plan", { owners: [] })).total).toBe(0);
  });

  it("counts only what the viewer may see", async () => {
    const index = seeded();
    expect((await query(index, "plan", { viewer: member("carol") })).total).toBe(2);
    expect((await query(index, "plan")).total).toBe(4);
  });
});

describe("SqliteIndex: filters, sorting and pages (F10.1)", () => {
  function seeded(): SqliteIndex {
    const index = memory();
    const at = (iso: string) => Date.parse(iso);
    index.apply({
      session: session(1, {
        repo: "github.com/acme/widget",
        branch: "main",
        source_id: "upload",
        updated_at: "2026-11-01T00:00:00.000Z",
      }),
      events: [event("cache bug", { timestamp: at("2026-10-01T00:00:00Z") })],
      replace: true,
    });
    index.apply({
      session: session(2, {
        format: "datadog-trajectory",
        origin_agent: "codex",
        repo: "github.com/acme/gadget",
        branch: "fix/cache",
        source_id: "dd-prod",
        updated_at: "2026-11-10T00:00:00.000Z",
      }),
      events: [event("cache bug cache bug", { timestamp: at("2026-11-09T00:00:00Z") })],
      replace: true,
    });
    index.apply({
      session: session(3, { repo: "100%_widget", updated_at: "2026-11-05T00:00:00.000Z" }),
      events: [event("cache")],
      replace: true,
    });
    return index;
  }
  const ids = (r: Awaited<ReturnType<typeof query>>) => r.hits.map((h) => h.session.session_id);

  it("filters by agent (filed format or origin), repo, branch, source and time", async () => {
    const index = seeded();
    expect(ids(await query(index, "cache", { agent: "codex" }))).toEqual(["s2"]);
    expect(ids(await query(index, "cache", { agent: "datadog-trajectory" }))).toEqual(["s2"]);
    expect(ids(await query(index, "cache", { agent: "claude-code" })).sort()).toEqual(["s1", "s3"]);
    expect(ids(await query(index, "cache", { repo: "widget" }))).toEqual(["s1"]);
    expect(ids(await query(index, "cache", { repo: "acme/widget" }))).toEqual(["s1"]);
    expect(ids(await query(index, "cache", { repo: "GitHub.com/Acme/Widget" }))).toEqual(["s1"]);
    // LIKE wildcards in the value are literal.
    expect(ids(await query(index, "cache", { repo: "%" }))).toEqual([]);
    expect(ids(await query(index, "cache", { repo: "100%_widget" }))).toEqual(["s3"]);
    expect(ids(await query(index, "cache", { branch: "fix/cache" }))).toEqual(["s2"]);
    expect(ids(await query(index, "cache", { source: "dd-prod" }))).toEqual(["s2"]);
    const nov1 = Date.parse("2026-11-01T00:00:00Z");
    expect(ids(await query(index, "cache", { since: nov1 })).sort()).toEqual(["s2", "s3"]);
    expect(ids(await query(index, "cache", { until: nov1 }))).toEqual(["s1"]);
  });

  it("filters by repo, harness, its version and any model the session used", async () => {
    const index = memory();
    index.apply({
      session: session(1, {
        project: "widget",
        repo: "github.com/acme/widget",
        harness: "claude-code",
        agent_version: "2.1.326",
        models: ["claude-opus-9", "claude-haiku-9"],
      }),
      events: [event("cache")],
      replace: true,
    });
    index.apply({
      session: session(2, {
        format: "cursor",
        project: "widget",
        repo: "github.com/other/widget-fork",
        harness: "cursor",
        agent_version: "2026.11.13-eacade1",
        models: ["auto-smart"],
      }),
      events: [event("cache")],
      replace: true,
    });
    // No remote: no repo, so a repo filter never finds it, whatever its project.
    index.apply({
      session: session(3, { project: "gadget" }),
      events: [event("cache")],
      replace: true,
    });
    const ids = async (extra: Partial<BackendQuery>) =>
      (await query(index, "cache", extra)).hits.map((h) => h.session.session_id).sort();
    expect(await ids({ repo: "github.com/acme/widget" })).toEqual(["s1"]);
    expect(await ids({ repo: "acme/widget" })).toEqual(["s1"]);
    // `repo` wins over a project of the same name.
    expect(await ids({ repo: "widget" })).toEqual(["s1"]);
    expect(await ids({ repo: "widget-fork" })).toEqual(["s2"]);
    expect(await ids({ repo: "gadget" })).toEqual([]);
    expect(await ids({ harness: "cursor" })).toEqual(["s2"]);
    expect(await ids({ harness: "claude-code", agent_version: "2.1.326" })).toEqual(["s1"]);
    expect(await ids({ agent_version: "1.0.0" })).toEqual([]);
    expect(await ids({ model: "claude-haiku-9" })).toEqual(["s1"]);
    expect(await ids({ model: "auto-smart" })).toEqual(["s2"]);
    expect(await ids({ model: "claude" })).toEqual([]);
    expect(index.session("alice", H(1))).toMatchObject({
      repo: "github.com/acme/widget",
      harness: "claude-code",
      agent_version: "2.1.326",
      models: ["claude-opus-9", "claude-haiku-9"],
    });
    expect(index.session("alice", H(3))).not.toHaveProperty("models");
  });

  it("filters by labels, each key and value exactly, all of them", async () => {
    const index = memory();
    const labelled = (n: number, labels?: Record<string, string>) =>
      index.apply({
        session: session(n, labels ? { labels } : {}),
        events: [event("cache")],
        replace: true,
      });
    labelled(1, { "dosu.project": "github.com/acme/billing", team: "platform" });
    labelled(2, { "dosu.project": "github.com/acme/web", team: "platform" });
    labelled(3);
    const by = async (labels: Record<string, string>) =>
      ids(await query(index, "cache", { labels })).sort();
    expect(await by({ team: "platform" })).toEqual(["s1", "s2"]);
    expect(await by({ "dosu.project": "github.com/acme/billing" })).toEqual(["s1"]);
    expect(await by({ "dosu.project": "github.com/acme/billing", team: "platform" })).toEqual([
      "s1",
    ]);
    expect(await by({ "dosu.project": "github.com/acme/billing", team: "infra" })).toEqual([]);
    expect(await by({ "dosu.project": "billing" })).toEqual([]);
    expect(await by({ team: "Platform" })).toEqual([]);
    expect(index.session("alice", H(1))?.labels).toEqual({
      "dosu.project": "github.com/acme/billing",
      team: "platform",
    });
    expect(index.session("alice", H(3))).not.toHaveProperty("labels");
  });

  it("sorts by relevance or by recency, and pages", async () => {
    const index = seeded();
    expect(ids(await query(index, "cache bug"))).toEqual(["s2", "s1"]);
    expect(ids(await query(index, "cache", { sort: "recent" }))).toEqual(["s2", "s3", "s1"]);
    const first = await query(index, "cache", { sort: "recent", limit: 2 });
    expect(first.total).toBe(3);
    expect(await ids(first)).toEqual(["s2", "s3"]);
    const second = await query(index, "cache", { sort: "recent", limit: 2, offset: 2 });
    expect(second.total).toBe(3);
    expect(await ids(second)).toEqual(["s1"]);
    const past = await query(index, "cache", { limit: 2, offset: 10 });
    expect(past).toEqual({ total: 3, hits: [] });
  });

  it("gives up to `matches` records per session, or none", async () => {
    const index = memory();
    index.apply({
      session: session(1),
      events: [1, 2, 3, 4, 5].map((i) => event(`needle ${i}`, { event_index: i })),
      replace: true,
    });
    expect((await query(index, "needle", { matches: 2 })).hits[0]?.matches).toHaveLength(2);
    expect((await query(index, "needle", { matches: 0 })).hits[0]?.matches).toEqual([]);
    expect((await query(index, "needle")).hits[0]?.hits).toBe(5);
  });

  it("reads the snippets' match once, never once per picked event", async () => {
    // `events_text.rowid IN (…)` beside the MATCH was pushed into FTS5 (`INDEX 0:=M1`), which
    // evaluated the match again for every id: one search with many matches stalled the server.
    const path = join(dir, "plan.sqlite");
    const index = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    index.apply({
      session: session(1),
      events: [1, 2, 3].map((i) => event(`needle ${i}`, { event_index: i })),
      replace: true,
    });
    expect((await query(index, "needle")).hits[0]?.matches.map((m) => m.event_index)).toEqual([
      1, 2, 3,
    ]);
    const db = new Database(path, { readonly: true });
    try {
      const plan = db
        .query(`EXPLAIN QUERY PLAN ${snippetsSql(500)}`)
        .all("[", "]", "needle", ...Array.from({ length: 500 }, (_, i) => i + 1)) as {
        detail: string;
      }[];
      const fts = plan.map((p) => p.detail).filter((d) => d.includes("events_text"));
      expect(fts).toHaveLength(1);
      // The match alone drives the scan: no rowid constraint is handed to FTS5.
      expect(fts[0]).toMatch(/VIRTUAL TABLE INDEX 0:M1$/);
    } finally {
      await db.close();
    }
  });
});

describe("SqliteIndex: the file", () => {
  it("is created owner-only in a new folder, and keeps its contents across opens", async () => {
    const path = join(dir, "cache", "seshi", "search", "d1.sqlite");
    const index = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    index.apply({ session: session(1), events: [event("kept")], replace: true });
    await caughtUp(index, "2026-11-14T09:00:00.000Z");
    await index.close();
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "cache", "seshi", "search")).mode & 0o777).toBe(0o700);
    }
    const again = new SqliteIndex({ path, deployment: "d1", events: [...EVENTS].reverse() });
    expect((await query(again, "kept")).total).toBe(1);
    expect((await again.state()).ready_at).toBe("2026-11-14T09:00:00.000Z");
    await again.close();
  });

  it("starts over for another deployment, other indexed roles or caps, or another file format", async () => {
    const path = join(dir, "i.sqlite");
    const fill = (deployment: string, events: readonly string[] = EVENTS) => {
      const index = new SqliteIndex({ path, deployment, events: events as typeof EVENTS });
      return index;
    };
    const a = fill("d1");
    a.apply({ session: session(1), events: [event("held")], replace: true });
    await advance(a, "alice", "owners/alice/changes/x", [], 0);
    await caughtUp(a, "2026-11-14T09:00:00.000Z");
    await a.close();
    const b = fill("d2");
    expect((await counts(b)).sessions).toBe(0);
    expect(await cursor(b, "alice")).toBeUndefined();
    expect((await b.state()).ready_at).toBeUndefined();
    b.apply({ session: session(1), events: [event("held")], replace: true });
    await b.close();
    const c = fill("d2", ["user"]);
    expect((await counts(c)).sessions).toBe(0);
    c.apply({ session: session(1), events: [event("held")], replace: true });
    await c.close();
    const capped = new SqliteIndex({
      path,
      deployment: "d2",
      events: ["user"],
      max_chars: { ...DEFAULT_SEARCH_MAX_CHARS, tool_result: 4096 },
    });
    expect((await counts(capped)).sessions).toBe(0);
    await capped.close();
    const raw = new Database(path);
    raw.query("UPDATE meta SET value = 'seshi/search-index/0' WHERE key = 'schema'").run();
    await raw.close();
    const d = fill("d2", ["user"]);
    expect((await counts(d)).sessions).toBe(0);
    expect(new Database(path).query("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({
      value: INDEX_SCHEMA,
    });
    await d.close();
  });

  it("lets two connections share the file", async () => {
    const path = join(dir, "shared.sqlite");
    const one = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    const two = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    one.apply({ session: session(1), events: [event("from one")], replace: true });
    expect((await query(two, "one")).total).toBe(1);
    two.remove("alice", H(1), 1);
    expect((await query(one, "one")).total).toBe(0);
    await one.close();
    await two.close();
  });
});

describe("SqliteIndex: feed state", () => {
  it("keeps a cursor per owner that only moves forward, and the keys seen in the window", async () => {
    const index = memory();
    expect(await cursor(index, "alice")).toBeUndefined();
    await advance(
      index,
      "alice",
      "k2",
      [
        { key: "k1", at: 100 },
        { key: "k2", at: 200 },
      ],
      0,
    );
    expect(await cursor(index, "alice")).toBe("k2");
    expect(await seen(index, "alice", ["k1", "k2", "k3"])).toEqual(new Set(["k1", "k2"]));
    expect(await seen(index, "bob", ["k1"])).toEqual(new Set());
    await advance(index, "alice", "k1", [{ key: "k0", at: 300 }], 150);
    expect(await cursor(index, "alice")).toBe("k2");
    expect(await seen(index, "alice", ["k0", "k1", "k2"])).toEqual(new Set(["k0", "k2"]));
  });

  it("becomes ready on the first full pass, and forgets everything on reset", async () => {
    const index = memory();
    expect((await index.state()).ready_at).toBeUndefined();
    await caughtUp(index, "2026-11-14T09:00:00.000Z");
    await caughtUp(index, "2026-11-14T10:00:00.000Z");
    expect((await index.state()).ready_at).toBe("2026-11-14T09:00:00.000Z");
    expect((await index.state()).caught_up_at).toBe("2026-11-14T10:00:00.000Z");
    index.apply({ session: session(1), events: [event("x")], replace: true });
    await advance(index, "alice", "k", [{ key: "k", at: 1 }], 0);
    await index.reset();
    expect((await index.state()).ready_at).toBeUndefined();
    expect((await index.state()).caught_up_at).toBeUndefined();
    expect(await cursor(index, "alice")).toBeUndefined();
    expect((await seen(index, "alice", ["k"])).size).toBe(0);
    expect(await counts(index)).toEqual({ sessions: 0, events: 0 });
  });

  it("commits a page as one transaction", async () => {
    const index = memory();
    // An entry that cannot be kept fails the page after its session was written.
    const unkept = { name: "20261114T090000.000Z-x", entry: { at: 1n } as unknown as ChangeEntry };
    await expect(
      index.commit({
        generation: await index.generation(),
        owner: "alice",
        updates: [{ session: session(1), events: [event("x")], replace: true }],
        removals: [],
        feed: [unkept],
        seen: [],
        cursor: "k",
        forgetBefore: 0,
      }),
    ).rejects.toThrow(/BigInt/);
    expect((await counts(index)).sessions).toBe(0);
    expect(await cursor(index, "alice")).toBeUndefined();
  });
});

describe("SqliteIndex: the reader and writer", () => {
  const page = (generation: string, fields: Partial<PageCommit> = {}): PageCommit => ({
    generation,
    owner: "alice",
    updates: [],
    removals: [],
    feed: [],
    seen: [],
    cursor: undefined,
    forgetBefore: 0,
    ...fields,
  });

  it("commits a page: its updates, removals, feed copy, keys and cursor", async () => {
    const index = memory();
    const gen = await index.generation();
    index.apply({ session: session(2), events: [event("old")], replace: true, read_at: 10 });
    const entry = { at: "2026-11-14T09:00:00.000Z" } as ChangeEntry;
    const result = await index.commit(
      page(gen, {
        updates: [
          { session: session(1), events: [event("alpha")], replace: true, read_at: 20 },
          // A continuation of traces the index does not hold.
          {
            session: session(3, { traces: [H(1), H(2)] }),
            events: [event("beta")],
            replace: false,
            base: [H(1)],
            read_at: 20,
          },
        ],
        removals: [
          { archive: H(2), read_at: 20, scrub: true },
          { archive: H(9), read_at: 20, scrub: false },
        ],
        feed: [{ name: "20261114T090000.000Z-x", entry }],
        seen: [{ key: "k1", at: 100 }],
        cursor: "k1",
      }),
    );
    expect(result).toEqual({ stale: false, refused: [H(3)], removed: 1 });
    expect((await query(index, "alpha")).total).toBe(1);
    expect((await query(index, "old OR beta")).total).toBe(0);
    expect(await cursor(index, "alice")).toBe("k1");
    expect(await seen(index, "alice", ["k1"])).toEqual(new Set(["k1"]));
    // Writing the page again changes nothing.
    const again = await index.commit(page(gen, { cursor: "k1", seen: [{ key: "k1", at: 100 }] }));
    expect(again).toEqual({ stale: false, refused: [], removed: 0 });
    expect(await counts(index)).toEqual({ sessions: 1, events: 1 });
  });

  it("reads what it holds of named sessions, and every owner's cursor", async () => {
    const index = memory();
    const gen = await index.generation();
    index.apply({ session: session(1), events: [event("x")], replace: true });
    index.apply({ session: session(2), events: [event("y")], replace: true });
    index.remove("alice", H(2), 1);
    const held = await index.sessions(gen, "alice", [H(1), H(2), H(3)]);
    expect([...held.keys()]).toEqual([H(1)]);
    expect(held.get(H(1))?.traces).toEqual([H(101)]);
    await index.commit(page(gen, { cursor: "a" }));
    await index.commit(page(gen, { owner: "bob", cursor: "b" }));
    expect(await index.cursors(gen)).toEqual(
      new Map([
        ["alice", "a"],
        ["bob", "b"],
      ]),
    );
  });

  it("writes nothing for a generation a reset replaced", async () => {
    const index = memory();
    const old = await index.generation();
    const gen = await index.reset();
    expect(gen).not.toBe(old);
    expect(await index.generation()).toBe(gen);
    const stale = await index.commit(
      page(old, {
        updates: [{ session: session(1), events: [event("x")], replace: true }],
        cursor: "k",
      }),
    );
    expect(stale).toEqual({ stale: true, refused: [], removed: 0 });
    expect(await index.passDone(old, "2026-11-14T09:00:00.000Z")).toBe(false);
    await index.readThrough(old, "2026-11-14T09:00:00.000Z");
    expect(await index.feed(undefined, 10)).toBeNull();
    expect(await index.cursors(old)).toEqual(new Map());
    expect(await index.state()).toEqual({ sessions: 0, events: 0, generation: gen });
    expect(await index.passDone(gen, "2026-11-14T10:00:00.000Z")).toBe(true);
    await index.readThrough(gen, "2026-11-14T10:00:00.000Z");
    expect(await index.feed(undefined, 10)).toMatchObject({ through: "2026-11-14T10:00:00.000Z" });
  });

  it("states its readiness, counts and generation in one read, and where it is", async () => {
    const path = join(dir, "state.sqlite");
    const open = sqliteIndex({ path });
    const index = await open({ deployment: "d1", events: EVENTS });
    expect(index.location()).toBe(path);
    const gen = await index.generation();
    await index.commit(
      page(gen, {
        updates: [{ session: session(1), events: [event("x"), event("y")], replace: true }],
      }),
    );
    await index.passDone(gen, "2026-11-14T09:00:00.000Z");
    expect(await index.state()).toEqual({
      ready_at: "2026-11-14T09:00:00.000Z",
      caught_up_at: "2026-11-14T09:00:00.000Z",
      sessions: 1,
      events: 2,
      generation: gen,
    });
    await index.maintain(new AbortController().signal);
    await index.close();
  });

  it("compiles the match tree to the FTS5 expression it ran before the tree", () => {
    expect(fts5Match(parseQuery('redis OR "memcached" -"dry run" deplo*').match)).toBe(
      '(("redis" OR "memcached") AND "deplo" *) NOT ("dry run")',
    );
  });
});
