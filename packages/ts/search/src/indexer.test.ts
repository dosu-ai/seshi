import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { ChangeEntry, Trace } from "@seshi/model";
import { StoreSessionDB, setVisibility, tombstone } from "@seshi/pipeline";
import {
  appendChange,
  archiveId,
  FsStore,
  getBytes,
  gunzipJson,
  gzipJson,
  keys,
  readChanges,
  readMetadata,
  type Store,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentTraces, Indexer, searchableEvents, tracesFrom } from "./indexer";
import { MEMORY_INDEX } from "./paths";
import { parseQuery } from "./query";
import { SqliteIndex } from "./sqlite";
import { LOCAL_VIEWER } from "./viewer";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const EVENTS = ["user", "assistant", "tool_call"] as const;
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const ts = "2026-11-01T10:00:00Z";
const PAD = ` ${"context ".repeat(260)}`;

/** A whole trajectory log: past the session filter's 2000 characters. */
function log(prompt: string, answer = "done"): string {
  return (
    line({ role: "meta", source: "trajectory", cwd: "/work/widget", git_branch: "main" }) +
    line({ role: "user", content: `${prompt}${PAD}`, timestamp: ts }) +
    line({
      role: "assistant",
      content: answer,
      timestamp: "2026-11-01T10:00:05Z",
      tool_calls: [{ id: "c1", name: "Bash", args: '{"command":"git push --force"}' }],
    }) +
    line({ role: "tool", tool_call_id: "c1", content: "pushed TOOLOUTPUT", timestamp: ts })
  );
}

let dir: string;
let store: Store;
let clock: Date;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-indexer-"));
  store = new FsStore(join(dir, "bucket"));
  clock = new Date("2026-11-14T09:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tick(ms = 1000): Date {
  clock = new Date(clock.getTime() + ms);
  return clock;
}

function db(owner = "alice", now = () => tick()) {
  return new StoreSessionDB({ store, owner, formats, now });
}

function setup(options: { lagMs?: number; pageSize?: number; budget?: number } = {}) {
  const index = new SqliteIndex({ path: MEMORY_INDEX, deployment: "d", events: EVENTS });
  const warnings: string[] = [];
  const indexer = new Indexer({
    store,
    index,
    events: EVENTS,
    now: () => clock,
    ownerRefreshMs: 0,
    log: { warn: (l) => warnings.push(l) },
    ...options,
  });
  const find = (q: string) =>
    index
      .query({
        match: parseQuery(q).match,
        viewer: LOCAL_VIEWER,
        sort: "relevance",
        limit: 50,
        offset: 0,
        matches: 5,
      })
      .hits.map((h) => `${h.session.owner}/${h.session.session_id}`)
      .sort();
  return { index, indexer, find, warnings };
}

describe("the indexer (F10.2)", () => {
  it("indexes published sessions of every owner, with their fields", async () => {
    await db("alice").ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: log("fix the flaky checkout test"),
      project: "github.com/acme/widget",
    });
    await db("bob").ingest({
      agent: "trajectory",
      session_id: "s2",
      transcript: log("tune the redis cache"),
    });
    const { index, indexer, find } = setup();
    const run = await indexer.run();
    expect(run).toMatchObject({ caught_up: true, more: false, owners: 2, entries: 2, indexed: 2 });
    expect(find("flaky")).toEqual(["alice/s1"]);
    expect(find("redis")).toEqual(["bob/s2"]);
    // Tool calls are indexed with their names and inputs; tool output is not by default.
    expect(find("git push --force")).toEqual(["alice/s1", "bob/s2"]);
    expect(find("Bash")).toEqual(["alice/s1", "bob/s2"]);
    expect(find("TOOLOUTPUT")).toEqual([]);
    // What the assistant said alongside its tool calls is assistant text too.
    expect(find("done")).toEqual(["alice/s1", "bob/s2"]);
    const s1 = index.session("alice", archiveId("alice", "trajectory", "s1"));
    expect(s1).toMatchObject({
      agent: "trajectory",
      session_id: "s1",
      project: "github.com/acme/widget",
      branch: "main",
      source_id: "upload",
      visibility: "org",
      started_at: Date.parse(ts),
      ended_at: Date.parse("2026-11-01T10:00:05Z"),
    });
    expect(index.readyAt()).toBe(clock.toISOString());
  });

  it("adds a continuation's events without reading the session again", async () => {
    const first = await db().ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: log("start the migration"),
    });
    const { index, indexer, find } = setup();
    await indexer.run();
    const chunk = line({ role: "user", content: "now roll back the migration", timestamp: ts });
    await db().ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: chunk,
      offset: first.bytes_total,
    });
    const archive = archiveId("alice", "trajectory", "s1");
    const metadata = await readMetadata(store, "alice", archive);
    expect(metadata?.traces).toHaveLength(2);
    // Only the new trace is read: remove the first trace object and it is not missed.
    await store.delete(keys.trace("alice", archive, metadata?.traces[0]?.content_hash as string));
    const run = await indexer.run();
    expect(run.indexed).toBe(1);
    expect(find("roll back")).toEqual(["alice/s1"]);
    expect(find("start")).toEqual(["alice/s1"]);
    expect(index.session("alice", archive)?.traces).toEqual(currentTraces(metadata as never));
    expect(index.counts().events).toBe(4);
  });

  it("drops a replaced session's earlier text (X4.6)", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("old words") });
    const { indexer, find } = setup();
    await indexer.run();
    await db().ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: log("brand new words"),
      replace: true,
    });
    const entries = (await readChanges(store, "alice")).entries;
    expect(entries.at(-1)?.entry).toMatchObject({ kind: "published", replace: true });
    await indexer.run();
    expect(find("old")).toEqual([]);
    expect(find("brand")).toEqual(["alice/s1"]);
  });

  it("reads a session again from a replacing entry's trace, even when its trace list looks the same (07)", async () => {
    // A redaction backfill whose new trace keeps the old hash (only what the hash leaves out
    // changed) rewrites the object in place: the metadata's trace list is unchanged, and only
    // the replacing entry says the index's copy is stale.
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("stale words") });
    const archive = archiveId("alice", "trajectory", "s1");
    const { index, indexer, find } = setup();
    await indexer.run();
    expect(find("stale")).toEqual(["alice/s1"]);
    const metadata = await readMetadata(store, "alice", archive);
    const hash = metadata?.head as string;
    const key = keys.trace("alice", archive, hash);
    const trace = gunzipJson<Trace>((await getBytes(store, key)) as Uint8Array);
    const first = trace.events.findIndex((e) => e.role === "user");
    trace.events[first] = { ...(trace.events[first] as Trace["events"][number]), text: "fresh" };
    await store.put(key, gzipJson(trace));
    await appendChange(store, {
      kind: "published",
      at: tick().toISOString(),
      owner: "alice",
      archive_id: archive,
      session_id: "s1",
      content_hash: hash,
      writer: { kind: "admin", principal: "admin", source_id: "redaction" },
      owner_basis: "verified",
      replace: true,
      reason: "redacted",
    });
    expect(await indexer.run()).toMatchObject({ entries: 1, indexed: 1 });
    expect(find("stale")).toEqual([]);
    expect(find("fresh")).toEqual(["alice/s1"]);
    expect(index.session("alice", archive)?.traces).toEqual([hash]);
  });

  it("removes a tombstoned session and follows visibility changes (F10.4)", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    await db().ingest({ agent: "trajectory", session_id: "s2", transcript: log("beta") });
    const { index, indexer, find } = setup();
    await indexer.run();
    await setVisibility({
      store,
      owner: "alice",
      agent: "trajectory",
      session_id: "s2",
      visibility: "owner",
      now: () => tick(),
    });
    await tombstone({
      store,
      owner: "alice",
      agent: "trajectory",
      session_id: "s1",
      now: () => tick(),
    });
    const run = await indexer.run();
    expect(run).toMatchObject({ removed: 1, indexed: 1 });
    expect(find("alpha")).toEqual([]);
    expect(index.session("alice", archiveId("alice", "trajectory", "s2"))?.visibility).toBe(
      "owner",
    );
  });

  it("reads each entry once, and nothing when nothing changed", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    const { indexer } = setup();
    expect((await indexer.run()).entries).toBe(1);
    expect(await indexer.run()).toMatchObject({ entries: 0, indexed: 0, caught_up: true });
  });

  it("finds entries a slow clock stamped behind its cursor, within the lag window", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("first") });
    const { indexer, find } = setup({ lagMs: 5 * 60 * 1000 });
    await indexer.run();
    // A laptop whose clock runs two minutes behind writes after the cursor moved.
    const behind = new Date(clock.getTime() - 2 * 60 * 1000);
    await db("alice", () => behind).ingest({
      agent: "trajectory",
      session_id: "s2",
      transcript: log("skewed"),
    });
    // And one ten minutes behind: outside the window, found only with the next change.
    const far = new Date(clock.getTime() - 10 * 60 * 1000);
    await db("alice", () => far).ingest({
      agent: "trajectory",
      session_id: "s3",
      transcript: log("faraway"),
    });
    await indexer.run();
    expect(find("skewed")).toEqual(["alice/s2"]);
    expect(find("faraway")).toEqual([]);
  });

  it("indexes a session as it is now, even when its latest entry is missing", async () => {
    const first = await db().ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: log("original"),
    });
    const { indexer, find } = setup();
    await indexer.run();
    await db().ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: line({ role: "user", content: "appended later", timestamp: ts }),
      offset: first.bytes_total,
    });
    // A crash between the pointer update and the change entry: the entry is gone.
    const listed = await store.list(keys.changes("alice"));
    await store.delete(listed.keys.at(-1) as string);
    await indexer.run();
    expect(find("appended")).toEqual([]);
    // The session's next change (any kind) brings the index up to date.
    await setVisibility({
      store,
      owner: "alice",
      agent: "trajectory",
      session_id: "s1",
      visibility: "owner",
      now: () => tick(),
    });
    await indexer.run();
    expect(find("appended")).toEqual(["alice/s1"]);
  });

  it("pages through a long feed within a budget, and is ready only once caught up", async () => {
    for (let i = 0; i < 7; i++) {
      await db().ingest({ agent: "trajectory", session_id: `s${i}`, transcript: log(`topic${i}`) });
    }
    const { index, indexer, find } = setup({ pageSize: 2, budget: 3 });
    const first = await indexer.run();
    expect(first).toMatchObject({ more: true, caught_up: false });
    expect(index.readyAt()).toBeUndefined();
    const all = await indexer.catchUp();
    expect(all.caught_up).toBe(true);
    expect(index.readyAt()).toBeDefined();
    expect(find("topic6")).toEqual(["alice/s6"]);
    expect(index.counts().sessions).toBe(7);
  });

  it("adds a continuation written by a clock behind the one that wrote the session", async () => {
    // Two API instances (or a laptop in local mode) stamp updated_at with clocks that
    // disagree: the continuation's metadata says it is older than what it extends.
    const first = await db().ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: log("start the migration"),
    });
    const { indexer, find } = setup();
    await indexer.run();
    const behind = new Date(clock.getTime() - 400);
    await db("alice", () => behind).ingest({
      agent: "trajectory",
      session_id: "s1",
      transcript: line({ role: "user", content: "skewed continuation", timestamp: ts }),
      offset: first.bytes_total,
    });
    const archive = archiveId("alice", "trajectory", "s1");
    const metadata = await readMetadata(store, "alice", archive);
    expect(metadata?.traces).toHaveLength(2);
    expect(await indexer.run()).toMatchObject({ indexed: 1 });
    expect(find("skewed")).toEqual(["alice/s1"]);
  });

  it("skips objects it cannot decode, warns, and still catches up", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    await db().ingest({ agent: "trajectory", session_id: "s2", transcript: log("beta") });
    await db("bob").ingest({ agent: "trajectory", session_id: "s3", transcript: log("gamma") });
    const garbage = new TextEncoder().encode("{not json");
    // s1's trace and s3's metadata are corrupt.
    const a1 = archiveId("alice", "trajectory", "s1");
    const m1 = await readMetadata(store, "alice", a1);
    await store.put(keys.trace("alice", a1, m1?.head as string), garbage);
    await store.put(keys.metadata("bob", archiveId("bob", "trajectory", "s3")), garbage);
    const { index, indexer, find, warnings } = setup();
    const run = await indexer.run();
    expect(run.caught_up).toBe(true);
    expect(index.readyAt()).toBeDefined();
    expect(find("beta")).toEqual(["alice/s2"]);
    expect(find("alpha OR gamma")).toEqual([]);
    expect(warnings.some((w) => w.includes("could not be read"))).toBe(true);
    expect(warnings.some((w) => w.includes("metadata cannot be read"))).toBe(true);
  });

  it("writes nothing from a run the index was reset under, and starts over", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    await db("bob").ingest({ agent: "trajectory", session_id: "s2", transcript: log("beta") });
    const index = new SqliteIndex({ path: MEMORY_INDEX, deployment: "d", events: EVENTS });
    let resetDuringList = true;
    // Another process sharing the file rebuilds it while this run is reading a feed.
    const racing: Store = {
      ...store,
      url: store.url,
      get: (key) => store.get(key),
      put: (key, body, options) => store.put(key, body, options),
      stat: (key) => store.stat(key),
      delete: (key, options) => store.delete(key, options),
      list: async (prefix, options) => {
        const page = await store.list(prefix, options);
        if (resetDuringList && prefix === keys.changes("alice")) {
          resetDuringList = false;
          index.reset();
        }
        return page;
      },
    };
    const indexer = new Indexer({
      store: racing,
      index,
      events: EVENTS,
      now: () => clock,
      ownerRefreshMs: 0,
    });
    const first = await indexer.run();
    expect(first).toMatchObject({ more: true, caught_up: false, indexed: 0 });
    expect(index.cursor("alice")).toBeUndefined();
    expect(index.readyAt()).toBeUndefined();
    const second = await indexer.run();
    expect(second).toMatchObject({ caught_up: true, indexed: 2 });
  });

  it("skips entries it cannot read or that name no session", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    await store.put(
      `${keys.changes("alice")}20261114T090100.000Z-tombstone.json`,
      new TextEncoder().encode("{not json"),
    );
    const bogus: Omit<ChangeEntry, "schema"> = {
      kind: "published",
      at: "2026-11-14T09:02:00.000Z",
      owner: "alice",
      archive_id: archiveId("alice", "trajectory", "ghost"),
      session_id: "ghost",
      content_hash: "f".repeat(64),
      writer: { kind: "local", principal: "alice", source_id: "upload" },
    };
    await appendChange(store, bogus as ChangeEntry);
    const { indexer, find, warnings } = setup();
    const run = await indexer.run();
    expect(run.caught_up).toBe(true);
    expect(find("alpha")).toEqual(["alice/s1"]);
    expect(warnings.some((w) => w.includes("unreadable change entry"))).toBe(true);
  });

  it("stops at once when aborted, without marking the index ready", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    const { index, indexer } = setup();
    const controller = new AbortController();
    controller.abort();
    const run = await indexer.run(controller.signal);
    expect(run.caught_up).toBe(false);
    expect(index.readyAt()).toBeUndefined();
  });

  it("reads the owners again after a while, and at once while there are none", async () => {
    const index = new SqliteIndex({ path: MEMORY_INDEX, deployment: "d", events: EVENTS });
    const indexer = new Indexer({
      store,
      index,
      events: EVENTS,
      now: () => clock,
      ownerRefreshMs: 60_000,
    });
    expect((await indexer.run()).owners).toBe(0);
    await db("alice").ingest({ agent: "trajectory", session_id: "s1", transcript: log("one") });
    expect((await indexer.run()).owners).toBe(1);
    await db("bob").ingest({ agent: "trajectory", session_id: "s2", transcript: log("two") });
    expect((await indexer.run()).owners).toBe(1);
    tick(61_000);
    expect(await indexer.run()).toMatchObject({ owners: 2, indexed: 1 });
    indexer.forgetOwners();
  });

  it("shares one run between callers", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("alpha") });
    const { indexer } = setup();
    const [a, b] = await Promise.all([indexer.run(), indexer.run()]);
    expect(a).toBe(b);
  });
});

describe("currentTraces", () => {
  it("starts at the last whole trace", () => {
    const t = (h: string, continuation?: boolean) => ({
      content_hash: h,
      created_at: ts,
      records: 1,
      ...(continuation ? { continuation: { from_record: 1, prefix_sha256: h } } : {}),
    });
    const metadata = { traces: [t("a"), t("b", true), t("c"), t("d", true), t("e", true)] };
    expect(currentTraces(metadata as never)).toEqual(["c", "d", "e"]);
    expect(currentTraces({ traces: [] } as never)).toEqual([]);
  });
});

describe("tracesFrom", () => {
  it("reads from the replacing trace on, or the session as it is now once that trace is gone", () => {
    const t = (h: string, continuation?: boolean) => ({
      content_hash: h,
      created_at: ts,
      records: 1,
      ...(continuation ? { continuation: { from_record: 1, prefix_sha256: h } } : {}),
    });
    // A fork's backfilled trace keeps its continuation, and later chunks continue it.
    const metadata = { traces: [t("r", true), t("s", true)] };
    expect(tracesFrom(metadata as never, "r")).toEqual(["r", "s"]);
    expect(tracesFrom({ traces: [t("c"), t("d", true)] } as never, "gone")).toEqual(["c", "d"]);
  });
});

describe("searchableEvents", () => {
  it("points assistant text said alongside tool calls at the record's first event", () => {
    const trace = {
      records: [
        { role: "meta", source: "x" },
        { role: "user", content: "go", timestamp: ts },
        {
          role: "assistant",
          content: "Running both.",
          timestamp: ts,
          tool_calls: [
            { id: "a", name: "Read", args: "{}" },
            { id: "b", name: "Bash", args: "{}" },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "x", timestamp: ts },
        { role: "assistant", content: null, timestamp: ts },
        { role: "assistant", content: "All done.", timestamp: "bad" },
      ],
      events: [
        { index: 0, role: "user", text: "go", timestamp: ts },
        { index: 1, role: "tool_call", text: "Read {}", timestamp: ts, tool_name: "Read" },
        { index: 2, role: "tool_call", text: "Bash {}", timestamp: ts, tool_name: "Bash" },
        { index: 3, role: "tool_result", text: "x", timestamp: ts },
        { index: 4, role: "assistant", text: "All done.", timestamp: null },
      ],
    };
    const all = searchableEvents("h", trace as never, new Set(EVENTS));
    expect(all.map((e) => [e.role, e.event_index, e.text])).toEqual([
      ["user", 0, "go"],
      ["tool_call", 1, "Read {}"],
      ["tool_call", 2, "Bash {}"],
      ["assistant", 4, "All done."],
      ["assistant", 1, "Running both."],
    ]);
    expect(all[3]?.timestamp).toBeUndefined();
    expect(searchableEvents("h", trace as never, new Set(["user"] as const))).toHaveLength(1);
  });
});
