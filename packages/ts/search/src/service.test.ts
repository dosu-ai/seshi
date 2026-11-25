import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerAliases } from "@seshi/auth";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { StoreSeshi, setVisibility, tombstone } from "@seshi/pipeline";
import { FsStore, type Store } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type IndexOptions, type IndexStore, IndexUnavailable, type OpenIndex } from "./backend";
import { MEMORY_INDEX } from "./paths";
import { SearchQueryError } from "./query";
import { checkRequest, MAX_LIMIT, SearchService, SearchUnavailable } from "./service";
import { fts5Match, sqliteIndex } from "./sqlite";
import { LOCAL_VIEWER, type Viewer } from "./viewer";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const ts = "2026-11-01T10:00:00Z";
const log = (prompt: string) =>
  line({ role: "meta", source: "trajectory" }) +
  line({ role: "user", content: `${prompt} ${"context ".repeat(260)}`, timestamp: ts }) +
  line({ role: "assistant", content: "done", timestamp: ts });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-search-service-"));
  store = new FsStore(join(dir, "bucket"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function service(options: { path?: string; aliases?: OwnerAliases; verify?: boolean } = {}) {
  return new SearchService({
    store,
    deployment: "d",
    settings: { path: options.path ?? MEMORY_INDEX, events: ["user", "assistant", "tool_call"] },
    ...(options.aliases ? { aliases: options.aliases } : {}),
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
  });
}

async function write(owner: string, id: string, prompt: string, visibility?: "org" | "owner") {
  await new StoreSeshi({ store, owner, formats }).ingest({
    format: "trajectory",
    session_id: id,
    transcript: log(prompt),
    ...(visibility ? { visibility } : {}),
  });
}

const member = (owner: string): Viewer => ({
  everything: false,
  own: [owner],
  canRead: (s) => s.owner === owner || (s.visibility ?? "org") === "org",
});
const ids = (results: { results: { owner: string; session_id: string }[] }) =>
  results.results.map((r) => `${r.owner}/${r.session_id}`).sort();

describe("SearchService", () => {
  it("refuses to answer until the index has caught up once (F10.3)", async () => {
    await write("alice", "s1", "kubernetes upgrade");
    const search = service();
    await expect(search.search(LOCAL_VIEWER, { q: "kubernetes" })).rejects.toBeInstanceOf(
      SearchUnavailable,
    );
    expect(await search.ready()).toBe(false);
    await search.catchUp();
    expect(await search.ready()).toBe(true);
    const found = await search.search(LOCAL_VIEWER, { q: "kubernetes" });
    expect(found).toMatchObject({ query: "kubernetes", total: 1 });
    expect(found.index.sessions).toBe(1);
    const [result] = found.results;
    expect(result).toMatchObject({
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      visibility: "org",
      source_id: "upload",
      hits: 1,
      started_at: "2026-11-01T10:00:00.000Z",
    });
    const match = result?.matches[0];
    expect(match).toMatchObject({
      role: "user",
      event_index: 0,
      timestamp: ts.replace("Z", ".000Z"),
    });
    expect(match?.snippet.slice(...(match.highlights[0] as [number, number]))).toBe("kubernetes");
    await search.close();
  });

  it("shows each viewer only what it may read, checked again against live metadata", async () => {
    await write("alice", "pub", "roadmap draft");
    await write("alice", "priv", "roadmap secret", "owner");
    await write("bob", "bob1", "roadmap notes");
    const search = service();
    await search.catchUp();
    expect(ids(await search.search(member("alice"), { q: "roadmap" }))).toEqual([
      "alice/priv",
      "alice/pub",
      "bob/bob1",
    ]);
    expect(ids(await search.search(member("bob"), { q: "roadmap" }))).toEqual([
      "alice/pub",
      "bob/bob1",
    ]);
    // Made private and deleted after indexing, before the indexer saw it: still never shown.
    await setVisibility({
      store,
      owner: "bob",
      format: "trajectory",
      session_id: "bob1",
      visibility: "owner",
    });
    await tombstone({ store, owner: "alice", format: "trajectory", session_id: "pub" });
    const stale = await search.search(member("alice"), { q: "roadmap" });
    expect(ids(stale)).toEqual(["alice/priv"]);
    expect(stale.total).toBe(3);
    // The live visibility is what the result says.
    const forBob = await search.search(member("bob"), { q: "roadmap" });
    expect(forBob.results.find((r) => r.session_id === "bob1")?.visibility).toBe("owner");
    // Without verification (an embedder's choice), the index alone answers.
    const unverified = service({ verify: false });
    await unverified.catchUp();
    await expect(unverified.search(member("alice"), { q: "roadmap" })).resolves.toMatchObject({
      total: 1,
    });
  });

  it("rebuilds from the change feed, and keeps its file across restarts", async () => {
    await write("alice", "s1", "persistent words");
    const path = join(dir, "index", "d.sqlite");
    const first = service({ path });
    await first.catchUp();
    expect(await first.status()).toMatchObject({ location: path, ready: true, sessions: 1 });
    await first.close();
    await expect(first.search(LOCAL_VIEWER, { q: "persistent" })).rejects.toThrow(/shut down/);
    const second = service({ path });
    // Ready at once: the file holds the index and its cursors.
    expect((await second.search(LOCAL_VIEWER, { q: "persistent" })).total).toBe(1);
    expect((await second.run()).entries).toBe(0);
    const rebuilt = await second.rebuild();
    expect(rebuilt).toMatchObject({ caught_up: true, entries: 1, indexed: 1 });
    expect((await second.search(LOCAL_VIEWER, { q: "persistent" })).total).toBe(1);
    await second.close();
  });
});

describe("SearchService: opening the index", () => {
  it("opens the index it is given, and reports where it is", async () => {
    await write("alice", "s1", "opened words");
    const opened: IndexOptions[] = [];
    const open: OpenIndex = async (options) => {
      opened.push(options);
      return sqliteIndex({ path: MEMORY_INDEX })(options);
    };
    const search = new SearchService({
      store,
      deployment: "d",
      scope: "mine:alice",
      settings: { events: ["user"] },
      open,
    });
    await search.catchUp();
    expect(await search.status()).toMatchObject({ location: MEMORY_INDEX, ready: true });
    expect((await search.search(LOCAL_VIEWER, { q: "opened" })).total).toBe(1);
    expect(opened).toEqual([{ deployment: "d", events: ["user"], scope: "mine:alice" }]);
    await search.close();
  });

  it("closes the index only once the reads in flight have finished", async () => {
    await write("alice", "s1", "inflight words");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const search = new SearchService({
      store,
      deployment: "d",
      settings: { events: ["user"] },
      open: async (options) => {
        const index = await sqliteIndex({ path: MEMORY_INDEX })(options);
        const state = index.state.bind(index);
        // Once armed, a read waits at the gate before it reads the index.
        index.state = async () => {
          if (held) await gate;
          return state();
        };
        return index;
      },
    });
    await search.catchUp();
    held = true;
    const answered = search.search(LOCAL_VIEWER, { q: "inflight" });
    const status = search.status();
    await Promise.resolve();
    let closed = false;
    const closing = search.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    await expect(search.ready()).rejects.toThrow(SearchUnavailable);
    release();
    expect((await answered).total).toBe(1);
    expect(await status).toMatchObject({ ready: true, sessions: 1 });
    await closing;
    expect(closed).toBe(true);
  });

  it("passes on an index it cannot reach, and tries to open it again", async () => {
    let attempts = 0;
    const search = new SearchService({
      store,
      deployment: "d",
      settings: { events: ["user"] },
      open: async (options) => {
        attempts++;
        if (attempts === 1) throw new IndexUnavailable("the bucket did not answer");
        const index = await sqliteIndex({ path: MEMORY_INDEX })(options);
        return {
          ...index,
          location: () => index.location(),
          state: () => Promise.reject(new IndexUnavailable("timed out")),
          close: () => index.close(),
        } as IndexStore;
      },
    });
    await expect(search.status()).rejects.toThrow(IndexUnavailable);
    const failed = search.search(LOCAL_VIEWER, { q: "x" });
    await expect(failed).rejects.toBeInstanceOf(IndexUnavailable);
    await expect(failed).rejects.toMatchObject({ code: "index_unavailable" });
    expect(attempts).toBe(2);
    await search.close();
  });
});

describe("checkRequest", () => {
  it("resolves defaults and filters", () => {
    const { query } = checkRequest({ q: "x" });
    expect({ ...query, match: fts5Match(query.match) }).toEqual({
      match: '"x"',
      sort: "relevance",
      limit: 20,
      matches: 3,
      offset: 0,
    });
    const full = checkRequest({
      q: "x",
      owner: "alice",
      agent: "codex",
      repo: "widget",
      branch: "main",
      harness: "codex",
      agent_version: "0.169.0",
      model: "gpt-9-codex",
      source: "upload",
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-02T00:00:00Z",
      sort: "recent",
      limit: 1000,
      matches: 99,
      cursor: "40",
    }).query;
    expect(full).toMatchObject({
      owners: ["alice"],
      agent: "codex",
      repo: "widget",
      harness: "codex",
      agent_version: "0.169.0",
      model: "gpt-9-codex",
      since: Date.parse("2026-11-01T00:00:00Z"),
      until: Date.parse("2026-11-02T00:00:00Z"),
      sort: "recent",
      limit: MAX_LIMIT,
      matches: 20,
      offset: 40,
    });
  });

  it("refuses what it cannot run", () => {
    const bad = [
      { q: "" },
      { q: "   " },
      { q: "x", owner: "a/b" },
      { q: "x", since: "yesterday" },
      { q: "x", since: "2026-11-02T00:00:00Z", until: "2026-11-01T00:00:00Z" },
      { q: "x", sort: "random" },
      { q: "x", limit: 0 },
      { q: "x", limit: 1.5 },
      { q: "x", matches: -1 },
      { q: "x", cursor: "abc" },
      { q: "x", cursor: "99999999" },
      { q: "x", agent: "a".repeat(600) },
      { q: "x", repo: 5 },
    ];
    for (const request of bad) {
      expect(() => checkRequest(request as never), JSON.stringify(request)).toThrow(
        SearchQueryError,
      );
    }
  });
});
