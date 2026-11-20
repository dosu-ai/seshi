import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendQuery, IndexedEvent, IndexedSession } from "./backend";
import { MEMORY_INDEX } from "./paths";
import { parseQuery } from "./query";
import { INDEX_SCHEMA, SqliteIndex, snippetsSql } from "./sqlite";
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

function session(n: number, fields: Partial<IndexedSession> = {}): IndexedSession {
  return {
    owner: "alice",
    archive_id: H(n),
    agent: "claude-code",
    session_id: `s${n}`,
    visibility: "org",
    updated_at: "2026-11-14T09:00:00.000Z",
    traces: [H(100 + n)],
    ...fields,
  };
}

function event(text: string, fields: Partial<IndexedEvent> = {}): IndexedEvent {
  return { content_hash: H(100), event_index: 0, role: "user", text, ...fields };
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
  it("finds sessions by their events, best first, with marked snippets", () => {
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
    const found = query(index, "deploy");
    expect(found.total).toBe(2);
    expect(found.hits.map((h) => h.session.session_id)).toEqual(["s1", "s3"]);
    const [first] = found.hits;
    expect(first?.hits).toBe(2);
    expect(first?.score).toBeGreaterThan(found.hits[1]?.score as number);
    expect(first?.matches[0]).toMatchObject({ event_index: 2, role: "assistant" });
    expect(first?.matches[0]?.marked).toContain("\u0001deploy\u0002");
    expect(index.counts()).toEqual({ sessions: 3, events: 4 });
  });

  it("appends a continuation's events, and replaces when asked", () => {
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
    expect(query(index, "alpha").total).toBe(1);
    expect(query(index, "beta").hits[0]?.matches[0]?.content_hash).toBe(H(201));
    expect(index.session("alice", H(1))?.traces).toEqual([H(101), H(201)]);
    index.apply({
      session: session(1, { traces: [H(301)], updated_at: "2026-11-14T11:00:00.000Z" }),
      events: [event("rewritten gamma", { content_hash: H(301) })],
      replace: true,
    });
    expect(query(index, "alpha").total).toBe(0);
    expect(query(index, "gamma").total).toBe(1);
    expect(index.counts().events).toBe(1);
  });

  it("refuses an update read before what it holds, and a continuation of other traces", () => {
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
    expect(query(index, "older").total).toBe(0);
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
    expect(query(index, "continued").total).toBe(1);
    const wrongBase = index.apply({
      session: session(1, { traces: [H(9), H(10)] }),
      events: [event("duplicate")],
      replace: false,
      base: [H(9)],
      read_at: 4000,
    });
    expect(wrongBase).toBe(false);
    expect(query(index, "duplicate").total).toBe(0);
  });

  it("removes a session, remembering the removal against late updates", () => {
    const index = memory();
    index.apply({ session: session(1), events: [event("secret plan")], replace: true, read_at: 1 });
    expect(index.remove("alice", H(1), 5000)).toBe(true);
    expect(query(index, "secret").total).toBe(0);
    expect(index.session("alice", H(1))).toBeNull();
    expect(index.counts()).toEqual({ sessions: 0, events: 0 });
    // A slower process indexing the session as it was before the tombstone is refused.
    const late = { session: session(1), events: [event("secret plan")], replace: true };
    expect(index.apply({ ...late, read_at: 4000 })).toBe(false);
    expect(query(index, "secret").total).toBe(0);
    // A removal read before what the index holds changes nothing.
    index.apply({ session: session(2), events: [event("other")], replace: true, read_at: 9000 });
    expect(index.remove("alice", H(2), 8000)).toBe(false);
    expect(query(index, "other").total).toBe(1);
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
    expect(query(index, "ghost").total).toBe(0);
    // A session read again after its removal (it came back) is indexed.
    expect(index.apply({ ...late, read_at: 6000 })).toBe(true);
  });

  it("skips empty text and caps what it stores", () => {
    const index = memory();
    index.apply({
      session: session(1),
      events: [event("   "), event(`${"word ".repeat(10_000)} needle`)],
      replace: true,
    });
    expect(index.counts().events).toBe(1);
    expect(query(index, "needle").total).toBe(0);
    expect(query(index, "word").total).toBe(1);
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

  it("shows a member their own sessions and the org's, never another's private ones", () => {
    const index = seeded();
    const ids = (viewer: Viewer) =>
      query(index, "plan", { viewer })
        .hits.map((h) => h.session.session_id)
        .sort();
    expect(ids(member("alice"))).toEqual(["s1", "s2", "s4"]);
    expect(ids(member("bob"))).toEqual(["s1", "s3", "s4"]);
    expect(ids({ everything: false, own: [], canRead: () => false })).toEqual(["s1", "s4"]);
    expect(ids(LOCAL_VIEWER)).toEqual(["s1", "s2", "s3", "s4"]);
    // An owner filter narrows; it never widens past what the viewer may see.
    expect(
      query(index, "plan", { viewer: member("alice"), owners: ["bob"] }).hits.map(
        (h) => h.session.session_id,
      ),
    ).toEqual(["s4"]);
    expect(query(index, "plan", { owners: [] }).total).toBe(0);
  });

  it("counts only what the viewer may see", () => {
    const index = seeded();
    expect(query(index, "plan", { viewer: member("carol") }).total).toBe(2);
    expect(query(index, "plan").total).toBe(4);
  });
});

describe("SqliteIndex: filters, sorting and pages (F10.1)", () => {
  function seeded(): SqliteIndex {
    const index = memory();
    const at = (iso: string) => Date.parse(iso);
    index.apply({
      session: session(1, {
        project: "github.com/acme/widget",
        branch: "main",
        source_id: "upload",
        updated_at: "2026-11-01T00:00:00.000Z",
      }),
      events: [event("cache bug", { timestamp: at("2026-10-01T00:00:00Z") })],
      replace: true,
    });
    index.apply({
      session: session(2, {
        agent: "datadog-trajectory",
        origin_agent: "codex",
        project: "github.com/acme/gadget",
        branch: "fix/cache",
        source_id: "dd-prod",
        updated_at: "2026-11-10T00:00:00.000Z",
      }),
      events: [event("cache bug cache bug", { timestamp: at("2026-11-09T00:00:00Z") })],
      replace: true,
    });
    index.apply({
      session: session(3, { project: "100%_widget", updated_at: "2026-11-05T00:00:00.000Z" }),
      events: [event("cache")],
      replace: true,
    });
    return index;
  }
  const ids = (r: ReturnType<typeof query>) => r.hits.map((h) => h.session.session_id);

  it("filters by agent (filed or origin), repo, branch, source and time", () => {
    const index = seeded();
    expect(ids(query(index, "cache", { agent: "codex" }))).toEqual(["s2"]);
    expect(ids(query(index, "cache", { agent: "datadog-trajectory" }))).toEqual(["s2"]);
    expect(ids(query(index, "cache", { agent: "claude-code" })).sort()).toEqual(["s1", "s3"]);
    expect(ids(query(index, "cache", { repo: "widget" }))).toEqual(["s1"]);
    expect(ids(query(index, "cache", { repo: "acme/widget" }))).toEqual(["s1"]);
    expect(ids(query(index, "cache", { repo: "GitHub.com/Acme/Widget" }))).toEqual(["s1"]);
    // LIKE wildcards in the value are literal.
    expect(ids(query(index, "cache", { repo: "%" }))).toEqual([]);
    expect(ids(query(index, "cache", { repo: "100%_widget" }))).toEqual(["s3"]);
    expect(ids(query(index, "cache", { branch: "fix/cache" }))).toEqual(["s2"]);
    expect(ids(query(index, "cache", { source: "dd-prod" }))).toEqual(["s2"]);
    const nov1 = Date.parse("2026-11-01T00:00:00Z");
    expect(ids(query(index, "cache", { since: nov1 })).sort()).toEqual(["s2", "s3"]);
    expect(ids(query(index, "cache", { until: nov1 }))).toEqual(["s1"]);
  });

  it("filters by repo, harness, its version and any model the session used", () => {
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
        agent: "cursor",
        project: "widget",
        repo: "github.com/other/widget-fork",
        harness: "cursor",
        agent_version: "2026.11.13-eacade1",
        models: ["auto-smart"],
      }),
      events: [event("cache")],
      replace: true,
    });
    // Written before `repo` was recorded: matched by its project.
    index.apply({
      session: session(3, { project: "github.com/acme/gadget" }),
      events: [event("cache")],
      replace: true,
    });
    const ids = (extra: Partial<BackendQuery>) =>
      query(index, "cache", extra)
        .hits.map((h) => h.session.session_id)
        .sort();
    expect(ids({ repo: "github.com/acme/widget" })).toEqual(["s1"]);
    expect(ids({ repo: "acme/widget" })).toEqual(["s1"]);
    // `repo` wins over a project of the same name.
    expect(ids({ repo: "widget" })).toEqual(["s1"]);
    expect(ids({ repo: "widget-fork" })).toEqual(["s2"]);
    expect(ids({ repo: "gadget" })).toEqual(["s3"]);
    expect(ids({ harness: "cursor" })).toEqual(["s2"]);
    expect(ids({ harness: "claude-code", agent_version: "2.1.326" })).toEqual(["s1"]);
    expect(ids({ agent_version: "1.0.0" })).toEqual([]);
    expect(ids({ model: "claude-haiku-9" })).toEqual(["s1"]);
    expect(ids({ model: "auto-smart" })).toEqual(["s2"]);
    expect(ids({ model: "claude" })).toEqual([]);
    expect(index.session("alice", H(1))).toMatchObject({
      repo: "github.com/acme/widget",
      harness: "claude-code",
      agent_version: "2.1.326",
      models: ["claude-opus-9", "claude-haiku-9"],
    });
    expect(index.session("alice", H(3))).not.toHaveProperty("models");
  });

  it("sorts by relevance or by recency, and pages", () => {
    const index = seeded();
    expect(ids(query(index, "cache bug"))).toEqual(["s2", "s1"]);
    expect(ids(query(index, "cache", { sort: "recent" }))).toEqual(["s2", "s3", "s1"]);
    const first = query(index, "cache", { sort: "recent", limit: 2 });
    expect(first.total).toBe(3);
    expect(ids(first)).toEqual(["s2", "s3"]);
    const second = query(index, "cache", { sort: "recent", limit: 2, offset: 2 });
    expect(second.total).toBe(3);
    expect(ids(second)).toEqual(["s1"]);
    const past = query(index, "cache", { limit: 2, offset: 10 });
    expect(past).toEqual({ total: 3, hits: [] });
  });

  it("gives up to `matches` records per session, or none", () => {
    const index = memory();
    index.apply({
      session: session(1),
      events: [1, 2, 3, 4, 5].map((i) => event(`needle ${i}`, { event_index: i })),
      replace: true,
    });
    expect(query(index, "needle", { matches: 2 }).hits[0]?.matches).toHaveLength(2);
    expect(query(index, "needle", { matches: 0 }).hits[0]?.matches).toEqual([]);
    expect(query(index, "needle").hits[0]?.hits).toBe(5);
  });

  it("reads the snippets' match once, never once per picked event", () => {
    // `events_text.rowid IN (…)` beside the MATCH was pushed into FTS5 (`INDEX 0:=M1`), which
    // evaluated the match again for every id: one search with many matches stalled the server.
    const path = join(dir, "plan.sqlite");
    const index = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    index.apply({
      session: session(1),
      events: [1, 2, 3].map((i) => event(`needle ${i}`, { event_index: i })),
      replace: true,
    });
    expect(query(index, "needle").hits[0]?.matches.map((m) => m.event_index)).toEqual([1, 2, 3]);
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
      db.close();
    }
  });
});

describe("SqliteIndex: the file", () => {
  it("is created owner-only in a new folder, and keeps its contents across opens", () => {
    const path = join(dir, "cache", "seshi", "search", "d1.sqlite");
    const index = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    index.apply({ session: session(1), events: [event("kept")], replace: true });
    index.caughtUp("2026-11-14T09:00:00.000Z");
    index.close();
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "cache", "seshi", "search")).mode & 0o777).toBe(0o700);
    }
    const again = new SqliteIndex({ path, deployment: "d1", events: [...EVENTS].reverse() });
    expect(query(again, "kept").total).toBe(1);
    expect(again.readyAt()).toBe("2026-11-14T09:00:00.000Z");
    again.close();
  });

  it("starts over for another deployment, other indexed roles, or another file format", () => {
    const path = join(dir, "i.sqlite");
    const fill = (deployment: string, events: readonly string[] = EVENTS) => {
      const index = new SqliteIndex({ path, deployment, events: events as typeof EVENTS });
      return index;
    };
    const a = fill("d1");
    a.apply({ session: session(1), events: [event("held")], replace: true });
    a.advance("alice", "owners/alice/changes/x", [], 0);
    a.caughtUp("2026-11-14T09:00:00.000Z");
    a.close();
    const b = fill("d2");
    expect(b.counts().sessions).toBe(0);
    expect(b.cursor("alice")).toBeUndefined();
    expect(b.readyAt()).toBeUndefined();
    b.apply({ session: session(1), events: [event("held")], replace: true });
    b.close();
    const c = fill("d2", ["user"]);
    expect(c.counts().sessions).toBe(0);
    c.close();
    const raw = new Database(path);
    raw.query("UPDATE meta SET value = 'seshi/search-index/0' WHERE key = 'schema'").run();
    raw.close();
    const d = fill("d2", ["user"]);
    expect(d.counts().sessions).toBe(0);
    expect(new Database(path).query("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({
      value: INDEX_SCHEMA,
    });
    d.close();
  });

  it("lets two connections share the file", () => {
    const path = join(dir, "shared.sqlite");
    const one = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    const two = new SqliteIndex({ path, deployment: "d1", events: EVENTS });
    one.apply({ session: session(1), events: [event("from one")], replace: true });
    expect(query(two, "one").total).toBe(1);
    two.remove("alice", H(1), 1);
    expect(query(one, "one").total).toBe(0);
    one.close();
    two.close();
  });
});

describe("SqliteIndex: feed state", () => {
  it("keeps a cursor per owner that only moves forward, and the keys seen in the window", () => {
    const index = memory();
    expect(index.cursor("alice")).toBeUndefined();
    index.advance(
      "alice",
      "k2",
      [
        { key: "k1", at: 100 },
        { key: "k2", at: 200 },
      ],
      0,
    );
    expect(index.cursor("alice")).toBe("k2");
    expect(index.seen("alice", ["k1", "k2", "k3"])).toEqual(new Set(["k1", "k2"]));
    expect(index.seen("bob", ["k1"])).toEqual(new Set());
    index.advance("alice", "k1", [{ key: "k0", at: 300 }], 150);
    expect(index.cursor("alice")).toBe("k2");
    expect(index.seen("alice", ["k0", "k1", "k2"])).toEqual(new Set(["k0", "k2"]));
  });

  it("becomes ready on the first full pass, and forgets everything on reset", () => {
    const index = memory();
    expect(index.readyAt()).toBeUndefined();
    index.caughtUp("2026-11-14T09:00:00.000Z");
    index.caughtUp("2026-11-14T10:00:00.000Z");
    expect(index.readyAt()).toBe("2026-11-14T09:00:00.000Z");
    expect(index.caughtUpAt()).toBe("2026-11-14T10:00:00.000Z");
    index.apply({ session: session(1), events: [event("x")], replace: true });
    index.advance("alice", "k", [{ key: "k", at: 1 }], 0);
    index.reset();
    expect(index.readyAt()).toBeUndefined();
    expect(index.caughtUpAt()).toBeUndefined();
    expect(index.cursor("alice")).toBeUndefined();
    expect(index.seen("alice", ["k"]).size).toBe(0);
    expect(index.counts()).toEqual({ sessions: 0, events: 0 });
  });

  it("runs nested work as one transaction", () => {
    const index = memory();
    expect(() =>
      index.transaction(() => {
        index.apply({ session: session(1), events: [event("x")], replace: true });
        index.advance("alice", "k", [], 0);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(index.counts().sessions).toBe(0);
    expect(index.cursor("alice")).toBeUndefined();
  });
});
