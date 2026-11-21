import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerAliases } from "@seshi/auth";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { StoreSeshi, setVisibility, tombstone } from "@seshi/pipeline";
import { FsStore, type Store } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_INDEX } from "./paths";
import { SearchQueryError } from "./query";
import { checkRequest, MAX_LIMIT, SearchService, SearchUnavailable } from "./service";
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
    expect(search.ready()).toBe(false);
    await search.catchUp();
    expect(search.ready()).toBe(true);
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
    search.close();
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
    expect(first.status()).toMatchObject({ path, ready: true, sessions: 1 });
    first.close();
    await expect(first.search(LOCAL_VIEWER, { q: "persistent" })).rejects.toThrow(/shut down/);
    const second = service({ path });
    // Ready at once: the file holds the index and its cursors.
    expect((await second.search(LOCAL_VIEWER, { q: "persistent" })).total).toBe(1);
    expect((await second.run()).entries).toBe(0);
    const rebuilt = await second.rebuild();
    expect(rebuilt).toMatchObject({ caught_up: true, entries: 1, indexed: 1 });
    expect((await second.search(LOCAL_VIEWER, { q: "persistent" })).total).toBe(1);
    second.close();
  });
});

describe("checkRequest", () => {
  it("resolves defaults and filters", () => {
    const { query } = checkRequest({ q: "x" });
    expect(query).toEqual({ match: '"x"', sort: "relevance", limit: 20, matches: 3, offset: 0 });
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
