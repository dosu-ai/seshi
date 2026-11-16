import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { storageTest, storageTestKey } from "./storage-test";
import type { DeleteOptions, PutOptions, Store } from "./store";

let dir: string;
let store: FsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-test-"));
  store = new FsStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A store that ignores the conditions it is given, as some S3-compatible stores do. */
function ignoring(inner: Store, what: { put?: "ifNoneMatch" | "ifMatch"; delete?: boolean }) {
  return {
    url: inner.url,
    get: (key: string) => inner.get(key),
    stat: (key: string) => inner.stat(key),
    list: (prefix: string, options?: Parameters<Store["list"]>[1]) => inner.list(prefix, options),
    put: (key: string, body: Uint8Array, options: PutOptions = {}) => {
      const { [what.put ?? "none"]: _dropped, ...kept } = options as Record<string, unknown>;
      return inner.put(key, body, kept as PutOptions);
    },
    delete: (key: string, options: DeleteOptions = {}) =>
      inner.delete(key, what.delete ? {} : options),
  } satisfies Store;
}

describe("the storage test (F11)", () => {
  it("passes on a store with conditional writes and deletes, and leaves nothing behind", async () => {
    const result = await storageTest(store, "alice", { key: storageTestKey("alice", "t1") });
    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true, true, true, true]);
    expect(result).toMatchObject({ conditionalWrites: true, conditionalDelete: true });
    expect(result.missing).toBeUndefined();
    expect((await store.list("owners/alice/")).keys).toEqual([]);
  });

  it("writes only in the owner's folder, beside the probe", () => {
    expect(storageTestKey("alice", "abc")).toBe("owners/alice/.probe-abc");
  });

  it("names a store that ignores If-None-Match, and refuses it", async () => {
    const result = await storageTest(ignoring(store, { put: "ifNoneMatch" }), "alice");
    expect(result.conditionalWrites).toBe(false);
    expect(result.missing).toBe(
      "accepted a second create: this store ignores If-None-Match on upload",
    );
    expect((await store.list("owners/alice/")).keys).toEqual([]);
  });

  it("names a store that ignores If-Match on upload", async () => {
    const result = await storageTest(ignoring(store, { put: "ifMatch" }), "alice");
    expect(result.conditionalWrites).toBe(false);
    expect(result.missing).toMatch(/ignores If-Match on upload/);
  });

  it("keeps uploads when only conditional deletes are missing", async () => {
    const result = await storageTest(ignoring(store, { delete: true }), "alice");
    expect(result).toMatchObject({ conditionalWrites: true, conditionalDelete: false });
    expect(result.missing).toMatch(/ignores If-Match on delete/);
    expect((await store.list("owners/alice/")).keys).toEqual([]);
  });
});
