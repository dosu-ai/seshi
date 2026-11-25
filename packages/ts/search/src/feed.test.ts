/** Every owner's change feed as one (`GET /v1/changes/all`), served from the search index's
 * copy of the feeds: order across owners, paging, owners that appear later, the lag window,
 * and cursors that outlive the process and the file. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllChangesPage, ChangeEntry } from "@seshi/model";
import { appendChange, archiveId, FsStore, type Store } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFeedCursor, encodeFeedCursor } from "./feed";
import { MEMORY_INDEX } from "./paths";
import { SearchQueryError } from "./query";
import { SearchService, SearchUnavailable } from "./service";

const T0 = Date.parse("2026-11-14T09:00:00.000Z");
const H_OWNER = `h-${"0123456789abcdef0123"}`;

let dir: string;
let store: Store;
let clock: Date;
const services: SearchService[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-feed-"));
  store = new FsStore(join(dir, "bucket"));
  clock = new Date(T0);
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function service(
  options: {
    path?: string;
    ownerRefreshMs?: number;
    budget?: number;
    pageSize?: number;
    feed?: boolean;
  } = {},
): SearchService {
  const s = new SearchService({
    store,
    deployment: "d",
    settings: { path: options.path ?? MEMORY_INDEX, events: ["user", "assistant"] },
    now: () => clock,
    feed: options.feed ?? true,
    indexer: {
      ownerRefreshMs: options.ownerRefreshMs ?? 0,
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    },
  });
  services.push(s);
  return s;
}

/** A change entry as a writer appends it, stamped `seconds` after T0 by the writer's clock. */
function change(
  owner: string,
  seconds: number,
  session: string,
  kind: ChangeEntry["kind"] = "published",
): Promise<string> {
  return appendChange(store, {
    kind,
    at: at(seconds),
    owner,
    archive_id: archiveId(owner, "trajectory", session),
    session_id: session,
    format: "trajectory",
    content_hash: kind === "published" ? "a".repeat(64) : null,
    writer: { kind: "device", principal: owner, source_id: "upload" },
    owner_basis: "verified",
    ...(kind === "tombstone" ? { reason: "deleted" as const } : {}),
    ...(kind === "visibility_changed" ? { visibility: "owner" as const } : {}),
  });
}

/** Every page from `after` (or `since`) on, `limit` at a time. */
async function drain(
  s: SearchService,
  from: { after?: string; since?: string },
  limit = 2,
): Promise<{ keys: string[]; pages: AllChangesPage[]; cursor: string | undefined }> {
  const pages: AllChangesPage[] = [];
  let options: { after?: string; since?: string; limit: number } = { ...from, limit };
  let cursor = from.after;
  for (;;) {
    const page = await s.changes(options);
    pages.push(page);
    if (page.cursor !== undefined) cursor = page.cursor;
    if (!page.truncated) break;
    options = { after: page.cursor as string, limit };
  }
  return { keys: pages.flatMap((p) => p.entries.map((e) => e.key)), pages, cursor };
}

describe("every owner's change feed", () => {
  it("interleaves owners by stamp, ties broken by owner then key, paged with no gap or repeat", async () => {
    const written = [
      await change("bob", 2, "b1"),
      await change("alice", 1, "a1"),
      await change("svc:otlp", 1, "o1"),
      await change("alice", 3, "a2"),
      await change("bob", 3, "b2"),
      await change(H_OWNER, 4, "h1", "tombstone"),
      await change("bob", 5, "b1", "visibility_changed"),
      await change("alice", 6, "a3"),
      await change("alice", 6, "a4"),
    ];
    clock = new Date(T0 + 10_000);
    const s = service();
    await s.catchUp();

    const all = await s.changes({ limit: 1000 });
    expect(all.truncated).toBe(false);
    expect(all.through).toBe(at(10));
    const order = all.entries.map((e) => `${e.entry.at.slice(17, 19)} ${e.owner}`);
    expect(order).toEqual([
      "01 alice",
      "01 svc:otlp",
      "02 bob",
      "03 alice",
      "03 bob",
      `04 ${H_OWNER}`,
      "05 bob",
      "06 alice",
      "06 alice",
    ]);
    // Within one owner and millisecond, by key: the per-owner feed's own order.
    const sixes = all.entries.slice(-2).map((e) => e.key);
    expect(sixes).toEqual([...sixes].sort());
    // Each entry names its owner and its key, and carries the entry as written.
    expect(new Set(all.entries.map((e) => e.key))).toEqual(new Set(written));
    for (const e of all.entries) {
      expect(e.key.startsWith(`owners/${e.owner}/changes/`)).toBe(true);
      expect(e.entry.owner).toBe(e.owner);
    }
    expect(all.entries.map((e) => e.entry.kind)).toContain("tombstone");
    expect(all.entries.map((e) => e.entry.kind)).toContain("visibility_changed");

    for (const limit of [1, 2, 4]) {
      const paged = await drain(s, {}, limit);
      expect(paged.keys, `limit ${limit}`).toEqual(all.entries.map((e) => e.key));
      expect(paged.cursor).toBe(all.cursor);
    }
    // Past the end: an empty page, no cursor, so the reader keeps its own.
    expect(await s.changes({ after: all.cursor })).toEqual({
      entries: [],
      truncated: false,
      through: at(10),
    });
  });

  it("holds back what not every feed has been read up to", async () => {
    await change("alice", 1, "a1");
    // A writer whose clock runs a minute ahead.
    await change("bob", 70, "b1");
    clock = new Date(T0 + 10_000);
    const s = service();
    await s.catchUp();
    expect((await s.changes()).entries.map((e) => e.owner)).toEqual(["alice"]);
    clock = new Date(T0 + 80_000);
    await s.catchUp();
    expect((await s.changes()).entries.map((e) => e.owner)).toEqual(["alice", "bob"]);
  });

  it("delivers every entry of an owner that first writes after the cursor was given", async () => {
    await change("alice", 1, "a1");
    clock = new Date(T0 + 10_000);
    // The owner list is read again every minute, as on a server.
    const s = service({ ownerRefreshMs: 60_000 });
    await s.catchUp();
    const first = await drain(s, {});
    expect(first.keys).toHaveLength(1);

    // carol's first entries, and one of alice's after them.
    const carol = [
      await change("carol", 20, "c1"),
      await change("carol", 21, "c1"),
      await change("carol", 22, "c2"),
    ];
    const later = await change("alice", 25, "a2");
    clock = new Date(T0 + 30_000);
    await s.catchUp();
    // The pass used the owner list taken at 10 s, which has no carol: nothing after it is
    // served yet, so alice's entry at 25 s cannot carry the cursor past carol's.
    expect(await s.changes({ after: first.cursor })).toMatchObject({
      entries: [],
      through: at(10),
    });

    clock = new Date(T0 + 75_000);
    await s.catchUp();
    const next = await drain(s, { after: first.cursor as string });
    expect(next.keys).toEqual([...carol, later]);
    expect(next.pages.at(-1)?.through).toBe(at(75));
  });

  it("re-reads a lag window with since, and the reader dedupes by key", async () => {
    await change("alice", 1, "a1");
    await change("bob", 2, "b1");
    await change("alice", 5, "a2");
    clock = new Date(T0 + 10_000);
    const s = service();
    await s.catchUp();
    const seen = new Set<string>();
    const first = await drain(s, {});
    for (const key of first.keys) seen.add(key);
    const lastAt = Date.parse(
      (await s.changes({ limit: 1000 })).entries.at(-1)?.entry.at as string,
    );

    // bob's laptop clock is behind: his entry lands stamped before the reader's cursor.
    const late = await change("bob", 3, "b2");
    clock = new Date(T0 + 20_000);
    await s.catchUp();
    expect((await drain(s, { after: first.cursor as string })).keys).toEqual([]);

    const lag = 5 * 60 * 1000;
    const window = await drain(s, { since: new Date(lastAt - lag).toISOString() });
    const fresh = window.keys.filter((k) => !seen.has(k));
    expect(fresh).toEqual([late]);
    expect(window.keys).toEqual(expect.arrayContaining(first.keys));
  });

  it("starts at since, inclusive of entries stamped at that time", async () => {
    await change("alice", 1, "a1");
    const two = await change("bob", 2, "b1");
    const three = await change("alice", 3, "a2");
    clock = new Date(T0 + 10_000);
    const s = service();
    await s.catchUp();
    expect((await drain(s, { since: at(2) })).keys).toEqual([two, three]);
  });

  it("keeps a cursor working across a restart, a rebuild and another instance's file", async () => {
    for (let i = 0; i < 6; i++) await change(i % 2 ? "bob" : "alice", i + 1, `s${i}`);
    clock = new Date(T0 + 10_000);
    const path = join(dir, "index", "search.sqlite");
    const before = service({ path });
    await before.catchUp();
    const whole = (await before.changes({ limit: 1000 })).entries.map((e) => e.key);
    const page = await before.changes({ limit: 2 });
    await before.close();

    // The same file, opened by a new process.
    const restarted = service({ path });
    expect((await drain(restarted, { after: page.cursor as string })).keys).toEqual(whole.slice(2));

    // Another instance, whose own file was built from the bucket separately.
    const other = service({ path: join(dir, "other", "search.sqlite") });
    await expect(other.changes()).rejects.toThrow(SearchUnavailable);
    await other.catchUp();
    expect((await drain(other, { after: page.cursor as string })).keys).toEqual(whole.slice(2));

    // A rebuild empties the copy; once read again, the cursor means what it did.
    await restarted.rebuild();
    expect((await drain(restarted, { after: page.cursor as string })).keys).toEqual(whole.slice(2));
  });

  it("keeps moving while one owner gets more than a pass can read", async () => {
    // alice writes faster than a pass reads her feed, for as long as the test runs; bob and
    // carol come after her in the owner list.
    for (let i = 0; i < 6; i++) await change("alice", 1 + i, `a${i}`);
    const bob = await change("bob", 2, "b1");
    const carol = await change("carol", 4, "c1");
    // Past the indexer's lag window, so each entry read is done with (these name no session,
    // so a younger one would be read again until it ages out).
    clock = new Date(T0 + 600_000);
    const s = service({ budget: 2, pageSize: 1 });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 3; i++) await change("alice", 600 + round + i / 10, `late${round}-${i}`);
      clock = new Date(clock.getTime() + 1000);
      expect((await s.run()).more).toBe(true);
      try {
        const page = await s.changes({ limit: 1000, ...(cursor ? { after: cursor } : {}) });
        seen.push(...page.entries.map((e) => e.key));
        cursor = page.cursor ?? cursor;
      } catch (err) {
        if (!(err instanceof SearchUnavailable)) throw err;
      }
    }
    // alice's feed is never read to its end, yet bob's and carol's entries come through, in
    // order among hers, with no gap or repeat.
    expect(seen).toContain(bob);
    expect(seen).toContain(carol);
    expect(new Set(seen).size).toBe(seen.length);
    const whole = (await s.changes({ limit: 1000 })).entries.map((e) => e.key);
    expect(seen).toEqual(whole.slice(0, seen.length));
  });

  it("keeps no copy in an index built without the feed", async () => {
    await change("alice", 1, "a1");
    clock = new Date(T0 + 10_000);
    const path = join(dir, "laptop", "search.sqlite");
    const laptop = service({ path, feed: false });
    await laptop.catchUp();
    await expect(laptop.changes()).rejects.toThrow(/no copy/);
    await laptop.close();
    // Turning it on later starts the file again, so the copy holds every feed from its start.
    const server = service({ path });
    await expect(server.changes()).rejects.toThrow(SearchUnavailable);
    await server.catchUp();
    expect((await server.changes()).entries.map((e) => e.owner)).toEqual(["alice"]);
  });

  it("refuses a cursor it did not give, and answers only once every feed was read", async () => {
    const s = service();
    await expect(s.changes()).rejects.toThrow(SearchUnavailable);
    await s.catchUp();
    expect(await s.changes()).toMatchObject({ entries: [], truncated: false });
    for (const bad of [
      "nope",
      "owners/alice/changes/x",
      encodeFeedCursor({ stamp: "x", owner: "a", name: "y" }),
    ]) {
      await expect(s.changes({ after: bad }), bad).rejects.toThrow(SearchQueryError);
    }
    for (const since of ["yesterday", "2026", "Nov 1 2026", "2026-11-01"]) {
      await expect(s.changes({ since }), since).rejects.toThrow(SearchQueryError);
    }
    expect((await s.changes({ since: "2026-11-01T00:00:00+01:00" })).entries).toEqual([]);
    const key = await change("svc:otlp", 1, "o1");
    const name = key.slice(key.lastIndexOf("/") + 1);
    const position = { stamp: name.slice(0, name.indexOf("-")), owner: "svc:otlp", name };
    expect(decodeFeedCursor(encodeFeedCursor(position))).toEqual(position);
  });
});
