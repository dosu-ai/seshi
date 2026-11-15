import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore, STALE_LOCK_MS } from "./fs";
import { keys } from "./layout";
import { probe, publishObject } from "./publish";
import { getBytes, PreconditionFailed, StoreError, updateObject } from "./store";

let dir: string;
let store: FsStore;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : null);
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-fs-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FsStore", () => {
  it("round-trips objects with the MD5 of their bytes as the etag", async () => {
    expect(await store.put("a/b/c.txt", enc("hello"))).toEqual({ etag: md5("hello") });
    expect(await store.get("a/b/c.txt")).toEqual({ body: enc("hello"), etag: md5("hello") });
    expect(await store.stat("a/b/c.txt")).toEqual({ size: 5, etag: md5("hello") });
    await store.put("a/b/c.txt", enc("hello!"));
    expect((await store.stat("a/b/c.txt"))?.etag).toBe(md5("hello!"));
    expect(await store.get("a/b/missing")).toBeNull();
    expect(await store.stat("a/b/missing")).toBeNull();
    expect(await getBytes(store, "a/b/c.txt")).toEqual(enc("hello!"));
  });

  it("accepts a file:// URL and refuses keys that escape the root or name its own files", async () => {
    const viaUrl = new FsStore(`file://${dir}`);
    expect(viaUrl.root).toBe(store.root);
    expect(viaUrl.url.startsWith("file://")).toBe(true);
    await expect(store.put("../x", enc("x"))).rejects.toBeInstanceOf(StoreError);
    await expect(store.get("/abs")).rejects.toBeInstanceOf(StoreError);
    await expect(store.put("a.~lock", enc("x"))).rejects.toBeInstanceOf(StoreError);
    await expect(store.put("a.tmp", enc("x"))).rejects.toBeInstanceOf(StoreError);
  });

  it("lists in key order with startAfter and limit, ignoring temp and lock files", async () => {
    for (const k of ["p/3", "p/1", "p/2", "q/1", "p/sub/x"]) await store.put(k, enc(k));
    writeFileSync(join(dir, "p", "4.~lock"), "123");
    writeFileSync(join(dir, "p", "5.abc.tmp"), "x");
    expect((await store.list("p/")).keys).toEqual(["p/1", "p/2", "p/3", "p/sub/x"]);
    expect(await store.list("p/", { startAfter: "p/2", limit: 1 })).toEqual({
      keys: ["p/3"],
      truncated: true,
    });
    expect((await store.list("zzz/")).keys).toEqual([]);
    expect((await store.list("")).keys).toHaveLength(5);
  });

  it("deletes idempotently and leaves no lock behind", async () => {
    await store.put("d", enc("x"));
    await store.delete("d");
    await store.delete("d");
    expect(await store.get("d")).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("conditional writes", () => {
  it("If-None-Match creates once and refuses an existing object", async () => {
    expect(await store.put("k", enc("one"), { ifNoneMatch: "*" })).toEqual({ etag: md5("one") });
    await expect(store.put("k", enc("two"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    expect(dec(await getBytes(store, "k"))).toBe("one");
  });

  it("If-Match replaces only the version read, and refuses a missing object", async () => {
    const first = await store.put("k", enc("one"));
    await store.put("k", enc("two"), { ifMatch: first.etag });
    await expect(store.put("k", enc("three"), { ifMatch: first.etag })).rejects.toThrow(
      /changed since it was read/,
    );
    expect(dec(await getBytes(store, "k"))).toBe("two");
    await expect(store.put("gone", enc("x"), { ifMatch: md5("x") })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
  });

  it("deletes with If-Match only the version read", async () => {
    const put = await store.put("k", enc("one"));
    await store.put("k", enc("two"));
    await expect(store.delete("k", { ifMatch: put.etag })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await store.delete("k", { ifMatch: md5("two") });
    expect(await store.get("k")).toBeNull();
    // A missing object is not an error.
    await store.delete("k", { ifMatch: md5("two") });
  });

  it("serializes read-modify-write: concurrent increments all land", async () => {
    await store.put("counter", enc("0"));
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateObject(store, "counter", (current) => enc(String(Number(dec(current?.body)) + 1)), {
          retries: 50,
          sleep: () => new Promise((r) => setTimeout(r, Math.random() * 3)),
        }),
      ),
    );
    expect(dec(await getBytes(store, "counter"))).toBe("12");
  });

  it("serializes read-modify-write across processes on one machine (X6.1)", async () => {
    // Each child is its own process with its own FsStore: only the lock files keep them apart.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const script = `
      import { FsStore } from ${JSON.stringify(join(here, "fs.ts"))};
      import { updateObject } from ${JSON.stringify(join(here, "store.ts"))};
      const store = new FsStore(process.argv[1]);
      const dec = (b) => (b ? new TextDecoder().decode(b) : "0");
      for (let i = 0; i < 10; i++) {
        await updateObject(store, "counter", (c) => new TextEncoder().encode(String(Number(dec(c?.body)) + 1)),
          { retries: 200, sleep: (ms) => new Promise((r) => setTimeout(r, Math.random() * 4)) });
      }
    `;
    const run = promisify(execFile);
    // The children run TypeScript, so they need Bun whatever runs the tests.
    const bun = process.versions.bun ? process.execPath : "bun";
    await Promise.all(
      Array.from({ length: 4 }, () => run(bun, ["-e", script, dir], { timeout: 30_000 })),
    );
    expect(dec(await getBytes(store, "counter"))).toBe("40");
    expect(await readdir(dir)).toEqual(["counter"]);
  }, 40_000);

  it("never deletes a lock it does not hold", async () => {
    await store.put("k", enc("one"));
    // Another writer's fresh lock: a put waits for it rather than removing it, and gives up
    // with the lock still in place once it has waited long enough.
    const lock = join(dir, "k.~lock");
    writeFileSync(lock, "999 other\n");
    const waiting = store.put("k", enc("two"));
    await new Promise((r) => setTimeout(r, 50));
    expect(dec(await getBytes(store, "k"))).toBe("one");
    rmSync(lock);
    await waiting;
    expect(dec(await getBytes(store, "k"))).toBe("two");
    expect(await readdir(dir)).toEqual(["k"]);
  });

  it("waits for a held lock, and takes over one left by a dead writer", async () => {
    await store.put("k", enc("one"));
    const lock = join(dir, "k.~lock");
    writeFileSync(lock, "999 then\n");
    const old = (Date.now() - STALE_LOCK_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    await store.put("k", enc("two"), { ifMatch: md5("one") });
    expect(dec(await getBytes(store, "k"))).toBe("two");
    expect(await readdir(dir)).toEqual(["k"]);
  });
});

describe("updateObject", () => {
  it("creates with If-None-Match, replaces with If-Match, and skips when step returns null", async () => {
    const created = await updateObject(store, "u", (current) => {
      expect(current).toBeNull();
      return enc("a");
    });
    expect(created).toEqual({ written: true, current: { body: enc("a"), etag: md5("a") } });
    const skipped = await updateObject(store, "u", () => null);
    expect(skipped).toEqual({ written: false, current: { body: enc("a"), etag: md5("a") } });
    await updateObject(store, "u", (current) => enc(`${dec(current?.body)}b`));
    expect(dec(await getBytes(store, "u"))).toBe("ab");
  });

  it("re-reads after a 412 and gives up after its retries", async () => {
    await store.put("busy", enc("start"));
    // A store where another writer always wins: every conditional write fails.
    const contended = Object.create(store) as FsStore;
    let puts = 0;
    contended.put = async (key, _body, options) => {
      puts++;
      if (options?.ifMatch) throw new PreconditionFailed(key, "the object changed");
      return { etag: "" };
    };
    let calls = 0;
    const result = updateObject(
      contended,
      "busy",
      (current) => {
        calls++;
        return enc(`mine ${dec(current?.body)}`);
      },
      { retries: 2, sleep: async () => {} },
    );
    await expect(result).rejects.toBeInstanceOf(PreconditionFailed);
    expect([calls, puts]).toEqual([3, 3]);
  });
});

describe("publishObject", () => {
  it("immutable: the first object wins", async () => {
    expect(await publishObject(store, "o", enc("same"), "text/plain")).toBe("written");
    expect(await publishObject(store, "o", enc("same"), "text/plain")).toBe("exists");
    expect(await publishObject(store, "o", enc("diff"), "text/plain")).toBe("exists");
    expect(dec(await getBytes(store, "o"))).toBe("same");
  });

  it("immutable: of writers racing with different bytes, the first wins and none fails", async () => {
    const bodies = Array.from({ length: 6 }, (_, i) => `body-${i}`);
    const outcomes = await Promise.all(
      bodies.map((b) => publishObject(store, "race", enc(b), "text/plain")),
    );
    expect(outcomes.filter((o) => o === "written")).toHaveLength(1);
    const winner = bodies[outcomes.indexOf("written")];
    expect(dec(await getBytes(store, "race"))).toBe(winner);
  });

  it("replace: the same bytes are a no-op, different bytes replace", async () => {
    expect(await publishObject(store, "p", enc("same"), "text/plain", "replace")).toBe("written");
    expect(await publishObject(store, "p", enc("same"), "text/plain", "replace")).toBe("exists");
    expect(await publishObject(store, "p", enc("diff"), "text/plain", "replace")).toBe("written");
    expect(dec(await getBytes(store, "p"))).toBe("diff");
  });

  it("probe writes and reads back", async () => {
    await probe(store, "acme");
    expect(await store.stat(keys.probe("acme"))).not.toBeNull();
  });
});
