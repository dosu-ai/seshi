import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeEntry } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChanges } from "./changes";
import { FsStore } from "./fs";
import { archiveId } from "./layout";
import { appendChange } from "./publish";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-changes-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (at: string, sessionId: string): Omit<ChangeEntry, "schema"> => ({
  kind: "tombstone",
  at,
  owner: "alice",
  archive_id: archiveId("alice", "trajectory", sessionId),
  session_id: sessionId,
  content_hash: null,
  writer: { kind: "local", principal: "alice", source_id: "upload" },
});

describe("readChanges", () => {
  it("reads from a time including the entries stamped at it, not the millisecond before", async () => {
    const boundary = "2026-11-14T09:00:00.000Z";
    await appendChange(store, entry("2026-11-14T08:59:59.999Z", "before"));
    await appendChange(store, entry(boundary, "at"));
    await appendChange(store, entry("2026-11-14T09:00:00.001Z", "after"));
    const page = await readChanges(store, "alice", { since: boundary });
    expect(page.entries.map((e) => e.entry.session_id)).toEqual(["at", "after"]);
  });
});
