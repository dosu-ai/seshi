import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { IngestRejected } from "@seshi/model";
import { archiveId, FsStore, readChanges, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setVisibility, tombstone } from "./ingest";
import { StoreSeshi } from "./store-seshi";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-visibility-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const formats = new FormatRegistry(BUILTIN_FORMATS);
const ts = "2026-09-01T00:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const LOG =
  line({ role: "meta", source: "trajectory" }) +
  line({ role: "user", content: "x".repeat(2000), timestamp: ts }) +
  line({ role: "assistant", content: "done", timestamp: ts });
const now = () => new Date("2026-11-14T09:00:00.000Z");
const writer = {
  kind: "admin" as const,
  principal: "ops",
  credential_id: "t9",
  source_id: "upload",
};

function db(options: Partial<ConstructorParameters<typeof StoreSeshi>[0]> = {}) {
  return new StoreSeshi({ store, owner: "alice", formats, now, ...options });
}

describe("setVisibility (X5.10)", () => {
  it("changes who may read a session and appends a visibility_changed entry", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: LOG });
    const changed = await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      visibility: "owner",
      now,
      writer,
    });
    expect(changed?.visibility).toBe("owner");
    const stored = await readMetadata(store, "alice", archiveId("alice", "trajectory", "s1"));
    expect(stored?.visibility).toBe("owner");
    // Both entries share a millisecond here, so key order is not write order: find it by kind.
    const { entries } = await readChanges(store, "alice");
    const entry = entries.find((e) => e.entry.kind === "visibility_changed");
    expect(entry?.key).toMatch(/-visibility\.json$/);
    expect(entry?.entry).toMatchObject({
      kind: "visibility_changed",
      visibility: "owner",
      writer,
      owner_basis: "verified",
      content_hash: stored?.head,
    });
  });

  it("writes nothing for a session already so, and answers null for one not stored", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: LOG });
    const before = (await readChanges(store, "alice")).entries.length;
    const same = await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      visibility: "org",
    });
    expect(same?.visibility).toBe("org");
    expect((await readChanges(store, "alice")).entries.length).toBe(before);
    expect(
      await setVisibility({
        store,
        owner: "alice",
        format: "trajectory",
        session_id: "nope",
        visibility: "owner",
      }),
    ).toBeNull();
  });

  it("refuses a redacted session", async () => {
    await db().ingest({ format: "trajectory", session_id: "s1", transcript: LOG });
    await tombstone({ store, owner: "alice", format: "trajectory", session_id: "s1" });
    await expect(
      setVisibility({
        store,
        owner: "alice",
        format: "trajectory",
        session_id: "s1",
        visibility: "owner",
      }),
    ).rejects.toBeInstanceOf(IngestRejected);
    const { entries } = await readChanges(store, "alice");
    expect(entries.at(-1)?.entry).toMatchObject({ kind: "tombstone", owner_basis: "verified" });
  });
});

describe("StoreSeshi as a credential's client (X5.5, X5.10)", () => {
  it("writes the credential's claims over the upload's, and its default visibility", async () => {
    const client = db({
      writer: { kind: "person", principal: "alice", credential_id: "org", source_id: "upload" },
      owner_basis: "claimed",
      claims: { username: "Alice" },
      visibility: "owner",
    });
    await client.ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: LOG,
      claims: { username: "mallory", git_email: "a@acme.com" },
    });
    const stored = await client.getSession("trajectory", "s1");
    expect(stored).toMatchObject({
      owner_basis: "claimed",
      visibility: "owner",
      claims: { username: "Alice", git_email: "a@acme.com" },
      writer: { kind: "person", principal: "alice", credential_id: "org" },
    });
    await client.ingest({
      format: "trajectory",
      session_id: "s2",
      transcript: LOG,
      visibility: "org",
    });
    expect((await client.getSession("trajectory", "s2"))?.visibility).toBe("org");
    expect((await client.setVisibility("trajectory", "s2", "owner"))?.visibility).toBe("owner");
  });
});
