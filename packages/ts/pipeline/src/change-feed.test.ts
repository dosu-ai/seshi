/** The change feed's write order and keys (decisions 7 and 8 of 18): every path that writes
 * under `changes/` writes its entry before the session pointer moves, and no two entries share a
 * key, however close together they are written. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import {
  archiveId,
  FsStore,
  keys,
  PreconditionFailed,
  parseChangeKey,
  readChanges,
  readMetadata,
  type Store,
  StoreError,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishTombstone, setVisibility, tombstone } from "./ingest";
import { StoreSessionDB } from "./session-db";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const ts = "2026-11-01T10:00:00Z";
const PAD = ` ${"context ".repeat(260)}`;

/** A whole trajectory log: past the session filter's 2000 characters. */
function log(prompt: string): string {
  return (
    line({ role: "meta", source: "trajectory", cwd: "/work/widget" }) +
    line({ role: "user", content: `${prompt}${PAD}`, timestamp: ts }) +
    line({ role: "assistant", content: "done", timestamp: "2026-11-01T10:00:05Z" })
  );
}

let dir: string;
let store: FsStore;
let clock: Date;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-change-feed-"));
  store = new FsStore(dir);
  clock = new Date("2026-11-14T09:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tick = () => {
  clock = new Date(clock.getTime() + 1000);
  return clock;
};

/** `store`, with the next write of a session pointer failing once `armed` is set. */
function failingPointer(): { store: Store; arm: () => void } {
  let armed = false;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (key: string, body: Uint8Array, options?: Parameters<Store["put"]>[2]) => {
          if (armed && key.endsWith("/metadata.json")) {
            armed = false;
            throw new StoreError("injected: the pointer update failed");
          }
          return target.put(key, body, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Store;
  return { store: wrapped, arm: () => (armed = true) };
}

const db = (over: Store = store, now: () => Date = tick) =>
  new StoreSessionDB({ store: over, owner: "alice", formats, now });

const archive = (sessionId: string) => archiveId("alice", "trajectory", sessionId);
const metadata = (sessionId: string) => readMetadata(store, "alice", archive(sessionId));
const feed = async (after?: string) =>
  (await readChanges(store, "alice", after ? { after } : {})).entries;

describe("change entries before the pointer (decision 7 of 18)", () => {
  it("leaves an entry for a first publish that failed, and no session", async () => {
    const failing = failingPointer();
    failing.arm();
    await expect(
      db(failing.store).ingest({ agent: "trajectory", session_id: "s1", transcript: log("a") }),
    ).rejects.toThrow(/injected/);
    expect((await feed()).map((e) => e.entry.kind)).toEqual(["published"]);
    expect(await metadata("s1")).toBeNull();
    // Nothing of the session is left but the entry: its trace object was removed again.
    const files = (await store.list(`${keys.session("alice", archive("s1"))}/`)).keys;
    expect(files).toEqual([]);
  });

  it("leaves a tombstone's entry, and the session readable, when the pointer update fails", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("a") });
    const before = await metadata("s1");
    const failing = failingPointer();
    failing.arm();
    const remove = (over: Store) =>
      tombstone({ store: over, owner: "alice", agent: "trajectory", session_id: "s1", now: tick });
    await expect(remove(failing.store)).rejects.toThrow(/injected/);
    expect((await feed()).map((e) => e.entry.kind)).toEqual(["published", "tombstone"]);
    expect(await metadata("s1")).toEqual(before);
    expect(await store.stat(keys.trace("alice", archive("s1"), before?.head as string))).not.toBe(
      null,
    );
    expect(await remove(store)).toEqual({ removed: 1 });
    expect((await metadata("s1"))?.status).toBe("redacted");
    expect((await feed()).map((e) => e.entry.kind)).toEqual([
      "published",
      "tombstone",
      "tombstone",
    ]);
  });

  it("finishes a tombstone whose pointer write landed but answered as failed", async () => {
    // Found by the scenario explorer (33): the redacted pointer landed, the caller saw an error
    // before the deletes, and its retry found the session already redacted, so the trace
    // objects of a retracted session stayed in the bucket.
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("a") });
    const head = (await metadata("s1"))?.head as string;
    let armed = true;
    const lost = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, body: Uint8Array, options?: Parameters<Store["put"]>[2]) => {
            const put = await target.put(key, body, options);
            if (armed && key.endsWith("/metadata.json")) {
              armed = false;
              throw new StoreError("injected: the answer was lost");
            }
            return put;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    const input = { owner: "alice", agent: "trajectory", session_id: "s1", now: tick };
    await expect(tombstone({ store: lost, ...input })).rejects.toThrow(/injected/);
    expect((await metadata("s1"))?.status).toBe("redacted");
    const trace = keys.trace("alice", archive("s1"), head);
    expect(await store.stat(trace)).not.toBe(null);
    expect(await finishTombstone({ store, ...input })).toBe(1);
    expect(await store.stat(trace)).toBe(null);
    // Nothing more to do, and nothing done to a session that is not redacted.
    expect(await finishTombstone({ store, ...input })).toBe(0);
    await db().ingest({ agent: "trajectory", session_id: "s2", transcript: log("b") });
    expect(await finishTombstone({ store, ...input, session_id: "s2" })).toBe(0);
    expect((await metadata("s2"))?.traces).toHaveLength(1);
  });

  it("removes the traces when the redacted pointer landed but answered PreconditionFailed", async () => {
    // Found by the scenario explorer (33): the compare-and-swap was tried again on the redacted
    // pointer it had written, which names no trace, so nothing was deleted, and the retraction
    // reported success.
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("a") });
    const head = (await metadata("s1"))?.head as string;
    let armed = true;
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, body: Uint8Array, options?: Parameters<Store["put"]>[2]) => {
            const put = await target.put(key, body, options);
            if (armed && key.endsWith("/metadata.json")) {
              armed = false;
              throw new PreconditionFailed(key, "injected: the write landed");
            }
            return put;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    const removed = await tombstone({
      store: racing,
      owner: "alice",
      agent: "trajectory",
      session_id: "s1",
      now: tick,
    });
    expect(removed).toEqual({ removed: 1 });
    expect((await metadata("s1"))?.status).toBe("redacted");
    expect(await store.stat(keys.trace("alice", archive("s1"), head))).toBe(null);
  });

  it("leaves a visibility change's entry, and the visibility as it was, when the pointer update fails", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("a") });
    const failing = failingPointer();
    failing.arm();
    const hide = (over: Store) =>
      setVisibility({
        store: over,
        owner: "alice",
        agent: "trajectory",
        session_id: "s1",
        visibility: "owner",
        now: tick,
      });
    await expect(hide(failing.store)).rejects.toThrow(/injected/);
    const entries = await feed();
    expect(entries.at(-1)?.entry).toMatchObject({
      kind: "visibility_changed",
      visibility: "owner",
    });
    expect((await metadata("s1"))?.visibility).toBe("org");
    expect((await hide(store))?.visibility).toBe("owner");
  });
});

describe("unique change keys (decision 8 of 18)", () => {
  it("keeps two tombstones and two visibility changes of one owner in one millisecond", async () => {
    for (const id of ["s1", "s2", "s3"]) {
      await db().ingest({ agent: "trajectory", session_id: id, transcript: log(id) });
    }
    const cursor = (await readChanges(store, "alice")).cursor as string;
    // A bulk delete and a session made private and back, all stamped by one millisecond.
    const instant = new Date(clock.getTime() + 1000);
    const now = () => instant;
    const base = { store, owner: "alice", agent: "trajectory", now };
    await tombstone({ ...base, session_id: "s1" });
    await tombstone({ ...base, session_id: "s2" });
    await setVisibility({ ...base, session_id: "s3", visibility: "owner" });
    await setVisibility({ ...base, session_id: "s3", visibility: "org" });

    const entries = await feed(cursor);
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((e) => e.key)).size).toBe(4);
    const parts = entries.map((e) => parseChangeKey(e.key));
    expect(parts.every((p) => p?.at === instant.getTime())).toBe(true);
    expect(
      entries.map((e) => [e.entry.kind, e.entry.session_id, e.entry.visibility]).sort(),
    ).toEqual(
      [
        ["tombstone", "s1", undefined],
        ["tombstone", "s2", undefined],
        ["visibility_changed", "s3", "org"],
        ["visibility_changed", "s3", "owner"],
      ].sort(),
    );
    // Each key names its session and kind; the two changes of s3 differ only in the suffix.
    for (const { key, entry } of entries) {
      expect(parseChangeKey(key)).toMatchObject({ archive_id: entry.archive_id, kind: entry.kind });
    }
    const s3 = parts.filter((p) => p?.archive_id === archive("s3"));
    expect(s3).toHaveLength(2);
    expect(s3[0]?.suffix).not.toBe(s3[1]?.suffix);
  });

  it("lists every key written after a cursor, in stamp order, a page at a time", async () => {
    await db().ingest({ agent: "trajectory", session_id: "s1", transcript: log("s1") });
    const cursor = (await readChanges(store, "alice")).cursor as string;
    // `since` takes its millisecond in: the one after s1's entry.
    const since = new Date(clock.getTime() + 1).toISOString();
    // Two sessions published in one millisecond, then later changes.
    const instant = new Date(clock.getTime() + 1000);
    await db(store, () => instant).ingest({
      agent: "trajectory",
      session_id: "s2",
      transcript: log("s2"),
    });
    await db(store, () => instant).ingest({
      agent: "trajectory",
      session_id: "s3",
      transcript: log("s3"),
    });
    clock = instant;
    await setVisibility({
      store,
      owner: "alice",
      agent: "trajectory",
      session_id: "s2",
      visibility: "owner",
      now: tick,
    });
    await tombstone({ store, owner: "alice", agent: "trajectory", session_id: "s3", now: tick });

    const paged: string[] = [];
    let after = cursor;
    for (;;) {
      const page = await readChanges(store, "alice", { after, limit: 2 });
      paged.push(...page.entries.map((e) => e.key));
      if (!page.truncated || page.cursor === undefined) break;
      after = page.cursor;
    }
    expect(paged).toHaveLength(4);
    expect(paged.every((k) => k > cursor)).toBe(true);
    expect([...paged].sort()).toEqual(paged);
    const stamps = paged.map((k) => parseChangeKey(k)?.at ?? 0);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(stamps[0]).toBe(instant.getTime());
    expect(stamps[1]).toBe(instant.getTime());
    // A time cursor (`since`, a bare stamp) finds the same keys.
    const bySince = (await readChanges(store, "alice", { since })).entries.map((e) => e.key);
    expect(bySince).toEqual(paged);
  });
});
