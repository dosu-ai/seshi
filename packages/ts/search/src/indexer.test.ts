import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import {
  type ChangeEntry,
  DEFAULT_SEARCH_MAX_CHARS,
  type EventRole,
  type Trace,
} from "@seshi/model";
import { StoreSeshi, setVisibility, tombstone } from "@seshi/pipeline";
import {
  appendChange,
  archiveId,
  FsStore,
  getBytes,
  gunzipJson,
  gzipJsonDeterministic,
  keys,
  readChanges,
  readMetadata,
  type Store,
  StoreError,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageCommit } from "./backend";
import {
  BEHIND_SKEW_MS,
  currentTraces,
  Indexer,
  indexedCalls,
  searchableEvents,
  tracesFrom,
} from "./indexer";
import { MEMORY_INDEX } from "./paths";
import { parseQuery } from "./query";
import { SqliteIndex } from "./sqlite";
import { LOCAL_VIEWER } from "./viewer";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const EVENTS = ["user", "assistant", "tool_call"] as const;
const ALL = Object.keys(DEFAULT_SEARCH_MAX_CHARS) as EventRole[];
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
  return new StoreSeshi({ store, owner, formats, now });
}

/** `store`, running `hook` before the next write of a session pointer once `arm` is called:
 * after the change entry landed, before the pointer moves (a hook that throws fails the write). */
function beforePointer(hook: () => void | Promise<void>): { store: Store; arm: () => void } {
  let armed = false;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (key: string, body: Uint8Array, options?: Parameters<Store["put"]>[2]) => {
          if (armed && key.endsWith("/metadata.json")) {
            armed = false;
            await hook();
          }
          return target.put(key, body, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Store;
  return { store: wrapped, arm: () => (armed = true) };
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
  return { index, indexer, find: finder(index), warnings };
}

/** An indexer reading pages of two entries, whose index asks for `records` per commit (0: one
 * page per commit), and the sessions each commit names, as `owner:sessions`. */
function gathering(records: number, reading: Store = store, budget?: number) {
  const index = new SqliteIndex({ path: MEMORY_INDEX, deployment: "d", events: EVENTS });
  const commits: string[] = [];
  const writer = new Proxy(index, {
    get(target, prop) {
      if (prop === "batchRecords") return async () => records;
      if (prop === "commit") {
        return (page: PageCommit) => {
          commits.push(`${page.owner}:${page.updates.length + page.removals.length}`);
          return target.commit(page);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const indexer = new Indexer({
    store: reading,
    index: writer,
    events: EVENTS,
    now: () => clock,
    ownerRefreshMs: 0,
    pageSize: 2,
    ...(budget !== undefined ? { budget } : {}),
  });
  return { index, indexer, commits, find: finder(index) };
}

/** `store`, counting the reads of the keys in `counted`, and running `hook` before the `nth`
 * listing of a change feed. */
function watched(options: { counted?: Set<string>; nth?: number; hook?: () => Promise<void> }) {
  const reads = { count: 0 };
  let pages = 0;
  const reading = new Proxy(store, {
    get(target, prop) {
      if (prop === "get") {
        return (key: string) => {
          if (options.counted?.has(key)) reads.count++;
          return target.get(key);
        };
      }
      if (prop === "list") {
        return async (prefix: string, opts: Parameters<Store["list"]>[1]) => {
          if (prefix.includes("/changes/") && ++pages === options.nth) await options.hook?.();
          return target.list(prefix, opts);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { reading, reads };
}

/** Continues alice's session `s0` with `n` traces, one entry each. */
async function continued(n: number): Promise<string> {
  let at = (await db().ingest({ format: "trajectory", session_id: "s0", transcript: log("alpha") }))
    .bytes_total;
  for (let i = 0; i < n; i++) {
    at = (
      await db().ingest({
        format: "trajectory",
        session_id: "s0",
        transcript: line({ role: "user", content: `part${i} continued`, timestamp: ts }),
        offset: at,
      })
    ).bytes_total;
  }
  return archiveId("alice", "trajectory", "s0");
}

/** The sessions a search of `index` finds, as `owner/session_id`. */
function finder(index: SqliteIndex) {
  return async (q: string) =>
    (
      await index.query({
        match: parseQuery(q).match,
        viewer: LOCAL_VIEWER,
        sort: "relevance",
        limit: 50,
        offset: 0,
        matches: 5,
      })
    ).hits
      .map((h) => `${h.session.owner}/${h.session.session_id}`)
      .sort();
}

describe("the indexer (F10.2)", () => {
  it("indexes published sessions of every owner, with their fields", async () => {
    await db("alice").ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("fix the flaky checkout test"),
      project: "github.com/acme/widget",
    });
    await db("bob").ingest({
      format: "trajectory",
      session_id: "s2",
      transcript: log("tune the redis cache"),
    });
    const { index, indexer, find } = setup();
    const run = await indexer.run();
    expect(run).toMatchObject({ caught_up: true, more: false, owners: 2, entries: 2, indexed: 2 });
    expect(await find("flaky")).toEqual(["alice/s1"]);
    expect(await find("redis")).toEqual(["bob/s2"]);
    // Tool calls are indexed with their names and inputs; tool output is not by default.
    expect(await find("git push --force")).toEqual(["alice/s1", "bob/s2"]);
    expect(await find("Bash")).toEqual(["alice/s1", "bob/s2"]);
    expect(await find("TOOLOUTPUT")).toEqual([]);
    // What the assistant said alongside its tool calls is assistant text too.
    expect(await find("done")).toEqual(["alice/s1", "bob/s2"]);
    const s1 = index.session("alice", archiveId("alice", "trajectory", "s1"));
    expect(s1).toMatchObject({
      format: "trajectory",
      session_id: "s1",
      project: "github.com/acme/widget",
      branch: "main",
      source_id: "upload",
      visibility: "org",
      started_at: Date.parse(ts),
      ended_at: Date.parse("2026-11-01T10:00:05Z"),
    });
    expect((await index.state()).ready_at).toBe(clock.toISOString());
  });

  it("says an owner's feed is behind when it holds an entry the index has not read", async () => {
    await db("alice").ingest({ format: "trajectory", session_id: "s1", transcript: log("one") });
    await db("bob").ingest({ format: "trajectory", session_id: "s2", transcript: log("two") });
    const { indexer } = setup();
    expect(await indexer.behind("alice")).toBe(true);
    await indexer.catchUp();
    // Its entries are inside the lag window, so listed again, but read: not behind.
    expect(await indexer.behind("alice")).toBe(false);
    expect(await indexer.behind("bob")).toBe(false);
    await db("alice").ingest({ format: "trajectory", session_id: "s3", transcript: log("three") });
    expect(await indexer.behind("alice")).toBe(true);
    expect(await indexer.behind("bob")).toBe(false);
    await indexer.catchUp();
    expect(await indexer.behind("alice")).toBe(false);
    // An owner never read, with nothing written, is not behind.
    expect(await indexer.behind("carol")).toBe(false);
  });

  it("is not behind for entries a catch-up held back inside the lag window", async () => {
    // An upload, then its deletion and a visibility flip, all within the lag window: the
    // upload's and the first flip's entries no longer show, so the pass leaves them unread.
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("gone") });
    await db().ingest({ format: "trajectory", session_id: "s2", transcript: log("flip") });
    const base = { store, owner: "alice", format: "trajectory", now: () => tick() };
    await tombstone({ ...base, session_id: "s1" });
    await setVisibility({ ...base, session_id: "s2", visibility: "owner" });
    await setVisibility({ ...base, session_id: "s2", visibility: "org" });
    const { indexer } = setup();
    tick(BEHIND_SKEW_MS + 1000);
    await indexer.catchUp();
    expect(await indexer.behind("alice")).toBe(false);
    // One written after the catch-up still is.
    tick();
    await db().ingest({ format: "trajectory", session_id: "s3", transcript: log("new") });
    expect(await indexer.behind("alice")).toBe(true);
  });

  it("finds an unread entry past a full page of read ones", async () => {
    await continued(3);
    const { indexer } = gathering(0);
    await indexer.catchUp();
    expect(await indexer.behind("alice")).toBe(false);
    await db().ingest({ format: "trajectory", session_id: "s9", transcript: log("late") });
    expect(await indexer.behind("alice")).toBe(true);
  });

  it("indexes where a session ran and with what: its repo, harness, version and models", async () => {
    await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript:
        line({ role: "meta", source: "trajectory", model: "gpt-9", agent_version: "1.2.3" }) +
        log("flaky test").split("\n").slice(1).join("\n"),
      project: "widget",
      repo: "github.com/acme/widget",
    });
    const { index, indexer } = setup();
    await indexer.run();
    expect(index.session("alice", archiveId("alice", "trajectory", "s1"))).toMatchObject({
      project: "widget",
      repo: "github.com/acme/widget",
      harness: "trajectory",
      models: ["gpt-9"],
    });
  });

  it("adds a continuation's events without reading the session again", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("start the migration"),
    });
    const { index, indexer, find } = setup();
    await indexer.run();
    const chunk = line({ role: "user", content: "now roll back the migration", timestamp: ts });
    await db().ingest({
      format: "trajectory",
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
    expect(await find("roll back")).toEqual(["alice/s1"]);
    expect(await find("start")).toEqual(["alice/s1"]);
    expect(index.session("alice", archive)?.traces).toEqual(currentTraces(metadata as never));
    expect((await index.state()).events).toBe(4);
  });

  it("numbers events by their place in the session across its traces, as read_session does", async () => {
    const archive = await continued(2);
    const path = join(dir, "seq.sqlite");
    const index = new SqliteIndex({ path, deployment: "d", events: ALL });
    const indexer = new Indexer({ store, index, events: ALL, now: () => clock, ownerRefreshMs: 0 });
    // The first trace, then the two continuations, each read on its own pass.
    await indexer.run();
    const metadata = await readMetadata(store, "alice", archive);
    const traces = await Promise.all(
      currentTraces(metadata as never).map(async (hash) => ({
        hash,
        trace: gunzipJson<Trace>(
          (await getBytes(store, keys.trace("alice", archive, hash))) as Uint8Array,
        ),
      })),
    );
    expect(traces).toHaveLength(3);
    const flat = traces.flatMap(({ hash, trace }) => trace.events.map((e) => ({ hash, e })));
    const rows = new Database(path, { readonly: true })
      .query(
        `SELECT e.content_hash, e.event_index, e.seq, e.role, t.text
         FROM events e JOIN events_text t ON t.rowid = e.id ORDER BY e.seq, e.role`,
      )
      .all() as { content_hash: string; event_index: number; seq: number; role: string }[];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      const at = flat[row.seq];
      expect(at?.hash).toBe(row.content_hash);
      // What the assistant said alongside tool calls takes its first call's place.
      if (row.role !== "assistant" || at?.e.role === "assistant") {
        expect([at?.e.index, at?.e.role]).toEqual([row.event_index, row.role]);
      }
    }
    expect(index.session("alice", archive)?.event_count).toBe(flat.length);
    await index.close();
  });

  it("cuts each role's text to its cap and keeps its full length, its tool call id and outcome", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("cap me") });
    const archive = archiveId("alice", "trajectory", "s1");
    const metadata = await readMetadata(store, "alice", archive);
    const key = keys.trace("alice", archive, metadata?.head as string);
    const trace = gunzipJson<Trace>((await getBytes(store, key)) as Uint8Array);
    const result = trace.events.findIndex((e) => e.role === "tool_result");
    const long = `${"x".repeat(300)} TAILWORD`;
    trace.events[result] = {
      ...(trace.events[result] as Trace["events"][number]),
      text: long,
      ok: false,
    };
    trace.llm_calls = [
      {
        id: "call-1",
        model: "opus",
        provider: "anthropic",
        started_at: "2026-11-01T10:00:01Z",
        ended_at: "2026-11-01T10:00:04Z",
        duration_ms: 3000,
        usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 4 },
        stop_reason: "tool_use",
      },
      { id: "call-1", model: "repeated id" },
    ];
    await store.put(key, gzipJsonDeterministic(trace));
    const path = join(dir, "caps.sqlite");
    const maxChars = { ...DEFAULT_SEARCH_MAX_CHARS, tool_result: 256 };
    const index = new SqliteIndex({ path, deployment: "d", events: ALL, max_chars: maxChars });
    const indexer = new Indexer({ store, index, events: ALL, maxChars, now: () => clock });
    await indexer.run();
    const raw = new Database(path, { readonly: true });
    expect(
      raw
        .query(
          `SELECT e.role, e.tool_name, e.tool_call_id, e.ok, e.chars, length(t.text) AS kept
           FROM events e JOIN events_text t ON t.rowid = e.id WHERE e.role = 'tool_result'`,
        )
        .get(),
    ).toEqual({
      role: "tool_result",
      tool_name: "Bash",
      tool_call_id: "c1",
      ok: 0,
      chars: long.length,
      kept: 256,
    });
    expect(raw.query("SELECT tool_call_id FROM events WHERE role = 'tool_call'").get()).toEqual({
      tool_call_id: "c1",
    });
    expect(raw.query("SELECT * FROM llm_calls").all()).toEqual([
      expect.objectContaining({
        content_hash: metadata?.head,
        call_id: "call-1",
        model: "opus",
        provider: "anthropic",
        started_at: Date.parse("2026-11-01T10:00:01Z"),
        ended_at: Date.parse("2026-11-01T10:00:04Z"),
        duration_ms: 3000,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: null,
        total_tokens: null,
        stop_reason: "tool_use",
        error: null,
      }),
    ]);
    // Past the cap is not searched.
    expect(await finder(index)("TAILWORD")).toEqual([]);
    expect(await finder(index)("cap")).toEqual(["alice/s1"]);
    await index.close();
  });

  it("never puts back a session a slower run read before a faster run indexed it", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("original"),
    });
    const { index, indexer: fast, find } = setup();
    // A second process sharing the index file: its first metadata read returns, then it stalls
    // before it can use what it read.
    let reached = () => {};
    const stalled = new Promise<void>((resolve) => (reached = resolve));
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    const slowStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            const got = await target.get(key);
            if (armed && key.endsWith("/metadata.json")) {
              armed = false;
              reached();
              await gate;
            }
            return got;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    const slow = new Indexer({
      store: slowStore,
      index,
      events: EVENTS,
      now: () => clock,
      ownerRefreshMs: 0,
    });
    const slowRun = slow.run();
    await stalled;
    await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: line({ role: "user", content: "appended later", timestamp: ts }),
      offset: first.bytes_total,
    });
    tick();
    await fast.run();
    expect(await find("appended")).toEqual(["alice/s1"]);
    tick();
    release();
    await slowRun;
    expect(await find("appended")).toEqual(["alice/s1"]);
    expect(await find("original")).toEqual(["alice/s1"]);
  });

  it("drops a replaced session's earlier text (X4.6)", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("old words") });
    const { indexer, find } = setup();
    await indexer.run();
    await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("brand new words"),
      replace: true,
    });
    const entries = (await readChanges(store, "alice")).entries;
    expect(entries.at(-1)?.entry).toMatchObject({ kind: "published", replace: true });
    await indexer.run();
    expect(await find("old")).toEqual([]);
    expect(await find("brand")).toEqual(["alice/s1"]);
  });

  it("reads a session again from a replacing entry's trace, even when its trace list looks the same (07)", async () => {
    // A redaction backfill whose new trace keeps the old hash (only what the hash leaves out
    // changed) rewrites the object in place: the metadata's trace list is unchanged, and only
    // the replacing entry says the index's copy is stale.
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("stale words") });
    const archive = archiveId("alice", "trajectory", "s1");
    const { index, indexer, find } = setup();
    await indexer.run();
    expect(await find("stale")).toEqual(["alice/s1"]);
    const metadata = await readMetadata(store, "alice", archive);
    const hash = metadata?.head as string;
    const key = keys.trace("alice", archive, hash);
    const trace = gunzipJson<Trace>((await getBytes(store, key)) as Uint8Array);
    const first = trace.events.findIndex((e) => e.role === "user");
    trace.events[first] = { ...(trace.events[first] as Trace["events"][number]), text: "fresh" };
    await store.put(key, gzipJsonDeterministic(trace));
    await appendChange(store, {
      kind: "published",
      at: tick().toISOString(),
      owner: "alice",
      archive_id: archive,
      session_id: "s1",
      format: "trajectory",
      content_hash: hash,
      writer: { kind: "admin", principal: "admin", source_id: "redaction" },
      owner_basis: "verified",
      replace: true,
      reason: "redacted",
    });
    expect(await indexer.run()).toMatchObject({ entries: 1, indexed: 1 });
    expect(await find("stale")).toEqual([]);
    expect(await find("fresh")).toEqual(["alice/s1"]);
    expect(index.session("alice", archive)?.traces).toEqual([hash]);
  });

  it("removes a tombstoned session and follows visibility changes (F10.4)", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
    await db().ingest({ format: "trajectory", session_id: "s2", transcript: log("beta") });
    const { index, indexer, find } = setup();
    await indexer.run();
    await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s2",
      visibility: "owner",
      now: () => tick(),
    });
    await tombstone({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      now: () => tick(),
    });
    const run = await indexer.run();
    expect(run).toMatchObject({ removed: 1, indexed: 1 });
    expect(await find("alpha")).toEqual([]);
    expect(index.session("alice", archiveId("alice", "trajectory", "s2"))?.visibility).toBe(
      "owner",
    );
  });

  it("reads each entry once, and nothing when nothing changed", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
    const { indexer } = setup();
    expect((await indexer.run()).entries).toBe(1);
    expect(await indexer.run()).toMatchObject({ entries: 0, indexed: 0, caught_up: true });
  });

  it("finds entries a slow clock stamped behind its cursor, within the lag window", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("first") });
    const { indexer, find } = setup({ lagMs: 5 * 60 * 1000 });
    await indexer.run();
    // A laptop whose clock runs two minutes behind writes after the cursor moved.
    const behind = new Date(clock.getTime() - 2 * 60 * 1000);
    await db("alice", () => behind).ingest({
      format: "trajectory",
      session_id: "s2",
      transcript: log("skewed"),
    });
    // And one ten minutes behind: outside the window, found only with the next change.
    const far = new Date(clock.getTime() - 10 * 60 * 1000);
    await db("alice", () => far).ingest({
      format: "trajectory",
      session_id: "s3",
      transcript: log("faraway"),
    });
    await indexer.run();
    expect(await find("skewed")).toEqual(["alice/s2"]);
    expect(await find("faraway")).toEqual([]);
  });

  it("indexes a session as it is now, even when its latest entry is missing", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("original"),
    });
    const { indexer, find } = setup();
    await indexer.run();
    await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: line({ role: "user", content: "appended later", timestamp: ts }),
      offset: first.bytes_total,
    });
    // An entry lost some other way (writers no longer lose one: decision 7 of 18 writes it
    // before the pointer moves): deleted by hand.
    const listed = await store.list(keys.changes("alice"));
    await store.delete(listed.keys.at(-1) as string);
    await indexer.run();
    expect(await find("appended")).toEqual([]);
    // The session's next change (any kind) brings the index up to date.
    await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      visibility: "owner",
      now: () => tick(),
    });
    await indexer.run();
    expect(await find("appended")).toEqual(["alice/s1"]);
  });

  it("reads an entry again until the session's pointer shows its change (decision 7 of 18)", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("original"),
    });
    await db().ingest({ format: "trajectory", session_id: "s2", transcript: log("hidden") });
    const { index, indexer, find } = setup();
    await indexer.run();
    // Each write's pointer update lets the indexer run first: it reads the change entry before
    // the change is in the metadata.
    const seenBetween: string[][] = [];
    let query = "";
    const between = beforePointer(async () => {
      tick();
      await indexer.run();
      seenBetween.push(await find(query));
    });
    const through = (now = () => tick()) =>
      new StoreSeshi({ store: between.store, owner: "alice", formats, now });
    const archive = (id: string) => archiveId("alice", "trajectory", id);

    query = "appended";
    between.arm();
    await through().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: line({ role: "user", content: "appended later", timestamp: ts }),
      offset: first.bytes_total,
    });
    tick();
    await indexer.run();
    expect(seenBetween.at(-1)).toEqual([]);
    expect(await find("appended")).toEqual(["alice/s1"]);

    query = "newcomer";
    between.arm();
    await through().ingest({ format: "trajectory", session_id: "s3", transcript: log("newcomer") });
    tick();
    await indexer.run();
    expect(seenBetween.at(-1)).toEqual([]);
    expect(await find("newcomer")).toEqual(["alice/s3"]);

    query = "hidden";
    between.arm();
    await tombstone({
      store: between.store,
      owner: "alice",
      format: "trajectory",
      session_id: "s2",
      now: () => tick(),
    });
    tick();
    await indexer.run();
    expect(seenBetween.at(-1)).toEqual(["alice/s2"]);
    expect(await find("hidden")).toEqual([]);

    between.arm();
    await setVisibility({
      store: between.store,
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      visibility: "owner",
      now: () => tick(),
    });
    expect(index.session("alice", archive("s1"))?.visibility).toBe("org");
    tick();
    await indexer.run();
    expect(index.session("alice", archive("s1"))?.visibility).toBe("owner");
    // Every entry is now shown by its session's metadata: nothing is read again.
    expect((await indexer.run()).entries).toBe(0);
  });

  it("indexes correctly after a write failed between its entry and its pointer (decision 7 of 18)", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("original"),
    });
    const { indexer, find, warnings } = setup({ lagMs: 60_000 });
    await indexer.run();
    const failing = beforePointer(() => {
      throw new StoreError("injected: the pointer update failed");
    });
    const through = () =>
      new StoreSeshi({ store: failing.store, owner: "alice", formats, now: () => tick() });
    const chunk = line({ role: "user", content: "appended later", timestamp: ts });

    failing.arm();
    await expect(
      through().ingest({
        format: "trajectory",
        session_id: "s1",
        transcript: chunk,
        offset: first.bytes_total,
      }),
    ).rejects.toThrow(/injected/);
    // The entry names a trace the session does not list: the session is indexed as it is.
    expect(await indexer.run()).toMatchObject({ entries: 1, caught_up: true });
    expect(await find("appended")).toEqual([]);
    expect(await find("original")).toEqual(["alice/s1"]);
    // While the entry is young it is read again (its pointer may still move); once it is the
    // lag window behind the clock it is read a last time and settled.
    expect((await indexer.run()).entries).toBe(1);
    tick(61_000);
    expect((await indexer.run()).entries).toBe(1);
    expect((await indexer.run()).entries).toBe(0);
    expect(await find("original")).toEqual(["alice/s1"]);

    // A first publish that failed: an entry for a session with no metadata. Nothing is indexed.
    failing.arm();
    await expect(
      through().ingest({ format: "trajectory", session_id: "s2", transcript: log("ghostly") }),
    ).rejects.toThrow(/injected/);
    expect((await indexer.run()).caught_up).toBe(true);
    expect(await find("ghostly")).toEqual([]);

    // The resends land and are indexed.
    await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: chunk,
      offset: first.bytes_total,
    });
    await db().ingest({ format: "trajectory", session_id: "s2", transcript: log("ghostly") });
    await indexer.run();
    expect(await find("appended")).toEqual(["alice/s1"]);
    expect(await find("ghostly")).toEqual(["alice/s2"]);
    expect(warnings).toEqual([]);
  });

  it("sees two tombstones and two visibility changes made in one millisecond (decision 8 of 18)", async () => {
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await db().ingest({ format: "trajectory", session_id: id, transcript: log(`topic${id}`) });
    }
    const { index, indexer, find } = setup();
    await indexer.run();
    const instant = new Date(clock.getTime() + 1000);
    const base = { store, owner: "alice", format: "trajectory", now: () => instant };
    await tombstone({ ...base, session_id: "s1" });
    await tombstone({ ...base, session_id: "s2" });
    await setVisibility({ ...base, session_id: "s3", visibility: "owner" });
    await setVisibility({ ...base, session_id: "s4", visibility: "owner" });
    tick(2000);
    expect(await indexer.run()).toMatchObject({ entries: 4, removed: 2, indexed: 2 });
    expect(await find("topics1 OR topics2")).toEqual([]);
    for (const id of ["s3", "s4"]) {
      expect(index.session("alice", archiveId("alice", "trajectory", id))?.visibility).toBe(
        "owner",
      );
    }
    expect((await indexer.run()).entries).toBe(0);
  });

  it("pages through a long feed within a budget, and is ready only once caught up", async () => {
    for (let i = 0; i < 7; i++) {
      await db().ingest({
        format: "trajectory",
        session_id: `s${i}`,
        transcript: log(`topic${i}`),
      });
    }
    const { index, indexer, find } = setup({ pageSize: 2, budget: 3 });
    const first = await indexer.run();
    expect(first).toMatchObject({ more: true, caught_up: false });
    expect((await index.state()).ready_at).toBeUndefined();
    const all = await indexer.catchUp();
    expect(all.caught_up).toBe(true);
    expect((await index.state()).ready_at).toBeDefined();
    expect(await find("topic6")).toEqual(["alice/s6"]);
    expect((await index.state()).sessions).toBe(7);
  });

  it("adds a continuation written by a clock behind the one that wrote the session", async () => {
    // Two API instances (or a laptop in local mode) stamp updated_at with clocks that
    // disagree: the continuation's metadata says it is older than what it extends.
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("start the migration"),
    });
    const { indexer, find } = setup();
    await indexer.run();
    const behind = new Date(clock.getTime() - 400);
    await db("alice", () => behind).ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: line({ role: "user", content: "skewed continuation", timestamp: ts }),
      offset: first.bytes_total,
    });
    const archive = archiveId("alice", "trajectory", "s1");
    const metadata = await readMetadata(store, "alice", archive);
    expect(metadata?.traces).toHaveLength(2);
    expect(await indexer.run()).toMatchObject({ indexed: 1 });
    expect(await find("skewed")).toEqual(["alice/s1"]);
  });

  it("skips objects it cannot decode, warns, and still catches up", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
    await db().ingest({ format: "trajectory", session_id: "s2", transcript: log("beta") });
    await db("bob").ingest({ format: "trajectory", session_id: "s3", transcript: log("gamma") });
    const garbage = new TextEncoder().encode("{not json");
    // s1's trace and s3's metadata are corrupt.
    const a1 = archiveId("alice", "trajectory", "s1");
    const m1 = await readMetadata(store, "alice", a1);
    await store.put(keys.trace("alice", a1, m1?.head as string), garbage);
    await store.put(keys.metadata("bob", archiveId("bob", "trajectory", "s3")), garbage);
    const { index, indexer, find, warnings } = setup();
    const run = await indexer.run();
    expect(run.caught_up).toBe(true);
    expect((await index.state()).ready_at).toBeDefined();
    expect(await find("beta")).toEqual(["alice/s2"]);
    expect(await find("alpha OR gamma")).toEqual([]);
    expect(warnings.some((w) => w.includes("could not be read"))).toBe(true);
    expect(warnings.some((w) => w.includes("metadata cannot be read"))).toBe(true);
  });

  it("writes nothing from a run the index was reset under, and starts over", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
    await db("bob").ingest({ format: "trajectory", session_id: "s2", transcript: log("beta") });
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
    expect((await index.cursors(await index.generation())).get("alice")).toBeUndefined();
    expect((await index.state()).ready_at).toBeUndefined();
    const second = await indexer.run();
    expect(second).toMatchObject({ caught_up: true, indexed: 2 });
  });

  it("starts each owner from its cursor as it reaches it, which another process may have moved", async () => {
    // Bob's two sessions are further apart than the lag window: once his cursor is past the
    // second, the first's key is no longer remembered as seen.
    await db("bob").ingest({ format: "trajectory", session_id: "b1", transcript: log("first") });
    tick(10 * 60_000);
    await db("bob").ingest({ format: "trajectory", session_id: "b2", transcript: log("second") });
    await db("alice").ingest({ format: "trajectory", session_id: "a1", transcript: log("third") });
    const index = new SqliteIndex({ path: MEMORY_INDEX, deployment: "d", events: EVENTS });
    const options = { index, events: EVENTS, now: () => clock, ownerRefreshMs: 0 };
    // Another process sharing the file runs a whole pass while this one reads alice's feed.
    const other = new Indexer({ store, ...options });
    let raced = false;
    const racing: Store = {
      ...store,
      url: store.url,
      get: (key) => store.get(key),
      put: (key, body, putOptions) => store.put(key, body, putOptions),
      stat: (key) => store.stat(key),
      delete: (key, deleteOptions) => store.delete(key, deleteOptions),
      list: async (prefix, listOptions) => {
        if (!raced && prefix === keys.changes("alice")) {
          raced = true;
          expect((await other.run()).indexed).toBe(3);
        }
        return store.list(prefix, listOptions);
      },
    };
    const run = await new Indexer({ store: racing, ...options }).run();
    // Nothing is read again: bob's feed starts after the cursor the other process moved.
    expect(run).toMatchObject({ caught_up: true, entries: 0, indexed: 0 });
  });

  it("skips entries it cannot read or that name no session", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
    const unreadable = keys.change(
      "alice",
      "2026-11-14T09:01:00.000Z",
      archiveId("alice", "trajectory", "s1"),
      "00000000",
      "tombstone",
      null,
    );
    await store.put(unreadable, new TextEncoder().encode("{not json"));
    // A key of the old layout (no archive id or suffix) is not a change key: never read.
    await store.put(
      `${keys.changes("alice")}20261114T090100.000Z-tombstone.json`,
      new TextEncoder().encode("{not json either"),
    );
    const bogus: Omit<ChangeEntry, "schema"> = {
      kind: "published",
      at: "2026-11-14T09:02:00.000Z",
      owner: "alice",
      archive_id: archiveId("alice", "trajectory", "ghost"),
      session_id: "ghost",
      format: "trajectory",
      content_hash: "f".repeat(64),
      writer: { kind: "local", principal: "alice", source_id: "upload" },
    };
    await appendChange(store, bogus as ChangeEntry);
    const { indexer, find, warnings } = setup();
    const run = await indexer.run();
    expect(run.caught_up).toBe(true);
    expect(await find("alpha")).toEqual(["alice/s1"]);
    expect(warnings.some((w) => w.includes("unreadable change entry"))).toBe(true);
  });

  it("stops at once when aborted, without marking the index ready", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
    const { index, indexer } = setup();
    const controller = new AbortController();
    controller.abort();
    const run = await indexer.run(controller.signal);
    expect(run.caught_up).toBe(false);
    expect((await index.state()).ready_at).toBeUndefined();
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
    await db("alice").ingest({ format: "trajectory", session_id: "s1", transcript: log("one") });
    expect((await indexer.run()).owners).toBe(1);
    await db("bob").ingest({ format: "trajectory", session_id: "s2", transcript: log("two") });
    expect((await indexer.run()).owners).toBe(1);
    tick(61_000);
    expect(await indexer.run()).toMatchObject({ owners: 2, indexed: 1 });
    indexer.forgetOwners();
  });

  it("gathers a build's pages into commits of the records the index asks for, each session once", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s0",
      transcript: log("alpha start"),
    });
    for (let i = 1; i < 9; i++) {
      await db().ingest({
        format: "trajectory",
        session_id: `s${i}`,
        transcript: log(`topic${i}`),
      });
    }
    // Sessions named again on later pages: a continuation, a replace and a tombstone.
    await db().ingest({
      format: "trajectory",
      session_id: "s0",
      transcript: line({ role: "user", content: "epsilon continued", timestamp: ts }),
      offset: first.bytes_total,
    });
    await db().ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: log("beta rewritten"),
      replace: true,
    });
    await tombstone({ store, owner: "alice", format: "trajectory", session_id: "s2" });
    await db("bob").ingest({ format: "trajectory", session_id: "b1", transcript: log("delta") });

    /** A build whose index asks for `records` per commit (0: one page per commit). */
    const build = async (records: number) => {
      const { index, indexer, commits } = gathering(records);
      expect((await indexer.catchUp()).caught_up).toBe(true);
      const find = finder(index);
      const found = await Promise.all(
        ["alpha", "epsilon", "beta", "topic1", "topic2", "topic8", "delta"].map(find),
      );
      const { sessions, events } = await index.state();
      return { commits, result: { found, sessions, events } };
    };

    const paged = await build(0);
    const gathered = await build(1_000_000);
    const some = await build(10);
    // Six pages of alice's twelve entries and one of bob's, against one commit each, with every
    // session in it once.
    expect(paged.commits).toHaveLength(7);
    expect(gathered.commits).toEqual(["alice:9", "bob:1"]);
    expect(some.commits.length).toBeGreaterThan(2);
    expect(some.commits.length).toBeLessThan(7);
    expect(gathered.result).toEqual(paged.result);
    expect(some.result).toEqual(paged.result);
    expect(paged.result.found).toEqual([
      ["alice/s0"],
      ["alice/s0"],
      ["alice/s1"],
      [],
      [],
      ["alice/s8"],
      ["bob/b1"],
    ]);
  });

  it("plans a session named again on a later page of a gathered commit from its metadata then", async () => {
    const first = await db().ingest({
      format: "trajectory",
      session_id: "s0",
      transcript: log("alpha start"),
    });
    for (let i = 1; i < 4; i++) {
      await db().ingest({
        format: "trajectory",
        session_id: `s${i}`,
        transcript: log(`topic${i}`),
      });
    }
    // s0 is continued while the indexer reads the second page: its entry is on the third.
    const { reading } = watched({
      nth: 2,
      hook: async () => {
        await db().ingest({
          format: "trajectory",
          session_id: "s0",
          transcript: line({ role: "user", content: "epsilon late", timestamp: ts }),
          offset: first.bytes_total,
        });
      },
    });
    const { indexer, commits, find } = gathering(1_000_000, reading);
    expect(await indexer.run()).toMatchObject({ caught_up: true, entries: 5 });
    expect(commits).toEqual(["alice:4"]);
    expect(await find("epsilon")).toEqual(["alice/s0"]);
    expect(await indexer.run()).toMatchObject({ entries: 0, indexed: 0 });
  });

  it("reads each trace once in a gathered batch, however many of its pages name the session", async () => {
    const archive = await continued(12);
    const metadata = await readMetadata(store, "alice", archive);
    const traces = new Set(
      metadata?.traces.map((t) => keys.trace("alice", archive, t.content_hash)),
    );
    expect(traces.size).toBe(13);
    // Seven pages name s0. Planned again on each from nothing (the index holds nothing of it
    // during a build), it would read its 13 traces seven times.
    const { reading, reads } = watched({ counted: traces });
    const { indexer, commits, find } = gathering(1_000_000, reading);
    expect(await indexer.run()).toMatchObject({ caught_up: true, entries: 13 });
    expect(commits).toEqual(["alice:1"]);
    expect(reads.count).toBe(13);
    expect(await find("part11")).toEqual(["alice/s0"]);
  });

  it("reads a session's traces again in a gathered batch after a page replaces it", async () => {
    await db().ingest({
      format: "trajectory",
      session_id: "s0",
      transcript: log("hunter2secret leaked"),
    });
    for (let i = 1; i < 4; i++) {
      await db().ingest({
        format: "trajectory",
        session_id: `s${i}`,
        transcript: log(`topic${i}`),
      });
    }
    const archive = archiveId("alice", "trajectory", "s0");
    // A redaction backfill while the indexer reads the second page: the trace is rewritten in
    // place, under the same hash, and the replacing entry lands on the third (F2.5).
    const backfill = async () => {
      const hash = (await readMetadata(store, "alice", archive))?.head as string;
      const key = keys.trace("alice", archive, hash);
      const trace = gunzipJson<Trace>((await getBytes(store, key)) as Uint8Array);
      trace.events = trace.events.map((e) =>
        e.role === "user" ? { ...e, text: "[redacted] leaked" } : e,
      );
      await store.put(key, gzipJsonDeterministic(trace));
      await appendChange(store, {
        kind: "published",
        at: tick().toISOString(),
        owner: "alice",
        archive_id: archive,
        session_id: "s0",
        format: "trajectory",
        content_hash: hash,
        writer: { kind: "admin", principal: "admin", source_id: "redaction" },
        owner_basis: "verified",
        replace: true,
        reason: "redacted",
      });
    };
    const { reading } = watched({ nth: 2, hook: backfill });
    const { indexer, commits, find } = gathering(1_000_000, reading);
    expect(await indexer.run()).toMatchObject({ caught_up: true, entries: 5 });
    expect(commits).toEqual(["alice:4"]);
    expect(await find("hunter2secret")).toEqual([]);
    expect(await find("leaked")).toEqual(["alice/s0"]);
  });

  it("commits a gathered batch at the pass's budget of entries, when its records stay few", async () => {
    // Every entry names s0 again, so the batch's records stay at one session's however many
    // pages it gathers.
    await continued(9);
    const { indexer, commits, find } = gathering(1_000_000, store, 4);
    expect(await indexer.run()).toMatchObject({ more: true, entries: 4 });
    expect(commits).toEqual(["alice:1"]);
    expect((await indexer.catchUp()).caught_up).toBe(true);
    expect(await find("part8")).toEqual(["alice/s0"]);
  });

  it("shares one run between callers", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: log("alpha") });
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
    expect(all.map((e) => [e.role, e.event_index, e.seq, e.text])).toEqual([
      ["user", 0, 0, "go"],
      ["tool_call", 1, 1, "Read {}"],
      ["tool_call", 2, 2, "Bash {}"],
      ["assistant", 4, 4, "All done."],
      ["assistant", 1, 1, "Running both."],
    ]);
    expect(all[3]?.timestamp).toBeUndefined();
    expect(searchableEvents("h", trace as never, new Set(["user"] as const))).toHaveLength(1);
  });
});

describe("indexedCalls", () => {
  it("flattens usage, reads times as epoch ms, and keeps the first of a repeated id", () => {
    expect(
      indexedCalls("h", [
        {
          id: "a",
          model: "m",
          started_at: "2026-11-01T10:00:00Z",
          ended_at: "not a time",
          usage: { input_tokens: 5, total_tokens: 9.7, reasoning_tokens: Number.NaN },
          error: "overloaded",
        },
        { id: "a", model: "second" },
        { id: "", model: "no id" },
        { id: "b" },
      ]),
    ).toEqual([
      {
        content_hash: "h",
        call_id: "a",
        model: "m",
        started_at: Date.parse("2026-11-01T10:00:00Z"),
        input_tokens: 5,
        total_tokens: 9,
        error: "overloaded",
      },
      { content_hash: "h", call_id: "b" },
    ]);
    expect(indexedCalls("h", undefined)).toEqual([]);
  });
});
