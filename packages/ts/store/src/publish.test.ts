import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeEntry, METADATA_SCHEMA, type SessionMetadata } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChanges } from "./changes";
import { FsStore } from "./fs";
import { archiveId, keys } from "./layout";
import { readMetadata, updateMetadata, updateMetadataWithChange } from "./publish";
import type { PutOptions } from "./store";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-publish-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const archive = archiveId("alice", "trajectory", "s1");
const at = "2026-11-14T09:00:00.000Z";
const session: SessionMetadata = {
  schema: METADATA_SCHEMA,
  owner: "alice",
  archive_id: archive,
  session_id: "s1",
  format: "trajectory",
  status: "stored",
  traces: [],
  writer: { kind: "local", principal: "alice", source_id: "upload" },
  owner_basis: "verified",
  visibility: "org",
  created_at: at,
  updated_at: at,
};
const change = (visibility: "org" | "owner"): Omit<ChangeEntry, "schema"> => ({
  kind: "visibility_changed",
  at,
  owner: "alice",
  archive_id: archive,
  session_id: "s1",
  format: "trajectory",
  content_hash: null,
  writer: session.writer,
  visibility,
});

/** A step that makes the session private, with its entry, unless it is already. */
const makePrivate = (current: SessionMetadata | null) =>
  current === null || current.visibility === "owner"
    ? { next: null, change: null }
    : { next: { ...current, visibility: "owner" as const }, change: change("owner") };

describe("updateMetadataWithChange (decision 7 of 18)", () => {
  it("writes the entry before the pointer, and none when nothing changes", async () => {
    await updateMetadata(store, "alice", archive, () => session);
    const order: string[] = [];
    const watched = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return (key: string, body: Uint8Array, options?: PutOptions) => {
            order.push(key.includes("/changes/") ? "change" : "metadata");
            return target.put(key, body, options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const done = await updateMetadataWithChange(watched, "alice", archive, makePrivate);
    expect(order).toEqual(["change", "metadata"]);
    expect(done.change).toMatch(/-visibility\.json$/);
    expect((await readMetadata(store, "alice", archive))?.visibility).toBe("owner");
    const again = await updateMetadataWithChange(watched, "alice", archive, makePrivate);
    expect(again.change).toBeNull();
    expect((await readChanges(store, "alice")).entries).toHaveLength(1);
  });

  it("writes the entry a retry finds it needs, once, when the expected pointer needed none", async () => {
    await updateMetadata(store, "alice", archive, () => session);
    // The caller expected a private session (no entry needed); the pointer says otherwise.
    const done = await updateMetadataWithChange(store, "alice", archive, makePrivate, {
      expected: { ...session, visibility: "owner" },
    });
    expect(done.change).not.toBeNull();
    expect((await readChanges(store, "alice")).entries).toHaveLength(1);
    expect((await readMetadata(store, "alice", archive))?.visibility).toBe("owner");
  });

  it("keeps the one entry it wrote when another writer makes it retry", async () => {
    await updateMetadata(store, "alice", archive, () => session);
    let raced = false;
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            if (!raced && key === keys.metadata("alice", archive)) {
              raced = true;
              const read = await target.get(key);
              // Another writer lands between this read and the conditional write.
              await updateMetadata(target, "alice", archive, (m) =>
                m ? { ...m, project: "github.com/acme/widget" } : null,
              );
              return read;
            }
            return target.get(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await updateMetadataWithChange(racing, "alice", archive, makePrivate, {
      sleep: async () => {},
    });
    expect((await readChanges(store, "alice")).entries).toHaveLength(1);
    expect(await readMetadata(store, "alice", archive)).toMatchObject({
      visibility: "owner",
      project: "github.com/acme/widget",
    });
  });
});
