import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { keys } from "./layout";
import {
  countRecords,
  DEFAULT_RECORD_RETENTION_MS,
  listRecords,
  pruneRecords,
  sourcesWithRecords,
  writeDropped,
  writeFailed,
} from "./records";
import { getBytes } from "./store";

let dir: string;
let store: FsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-records-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const failure = (day: string, key: string) => ({
  at: `2026-11-${day}T09:00:00.000Z`,
  source: "s3-archive",
  source_kind: "s3" as const,
  owner: "svc:s3-archive",
  session_key: "sess-1",
  idempotency_key: key,
  provenance: { object_key: "logs/a.jsonl", etag: "abc" },
  code: "unsupported_agent",
  message: "no adapter for this format",
});

describe("drop and failure records", () => {
  it("share the base fields, live under separate prefixes and never hold content", async () => {
    const failed = await writeFailed(store, failure("01", "bucket/logs/a.jsonl@abc"));
    const dropped = await writeDropped(store, {
      at: "2026-11-01T10:00:00.000Z",
      source: "upload",
      source_kind: "hook",
      owner: "alice",
      session_key: "s1",
      idempotency_key: "s1@0",
      reason: "review_drop",
      policy: "default",
      policy_hash: "p".repeat(64),
      decision_model: "jev",
    });
    expect(failed).toMatch(
      /^sources\/s3-archive\/failed\/20261101T090000\.000Z-[0-9a-f]{24}\.json$/,
    );
    expect(dropped).toMatch(/^sources\/upload\/dropped\//);
    const page = await listRecords(store, "failed", "s3-archive");
    expect(page.records).toEqual([
      {
        key: failed,
        record: { schema: "seshi/failed/1", ...failure("01", "bucket/logs/a.jsonl@abc") },
      },
    ]);
    expect((await listRecords(store, "dropped", "upload")).records[0]?.record).toMatchObject({
      schema: "seshi/dropped/1",
      reason: "review_drop",
      decision_model: "jev",
    });
    expect(await sourcesWithRecords(store)).toEqual(["s3-archive", "upload"]);
  });

  it("is written once per envelope and millisecond", async () => {
    const a = await writeFailed(store, failure("01", "k"));
    const b = await writeFailed(store, { ...failure("01", "k"), message: "again" });
    expect(b).toBe(a);
    expect(await countRecords(store, "failed", "s3-archive")).toBe(1);
    expect(new TextDecoder().decode((await getBytes(store, a)) as Uint8Array)).toContain(
      "no adapter",
    );
  });

  it("lists oldest first, from a cursor or a time, a page at a time", async () => {
    for (const day of ["03", "01", "02"]) await writeFailed(store, failure(day, `k${day}`));
    const all = await listRecords(store, "failed", "s3-archive");
    expect(all.records.map((r) => r.record.at.slice(8, 10))).toEqual(["01", "02", "03"]);
    const first = await listRecords(store, "failed", "s3-archive", { limit: 1 });
    expect(first.truncated).toBe(true);
    const rest = await listRecords(store, "failed", "s3-archive", { after: first.cursor });
    expect(rest.records.map((r) => r.record.at.slice(8, 10))).toEqual(["02", "03"]);
    const since = await listRecords(store, "failed", "s3-archive", {
      since: "2026-11-02T09:00:00.000Z",
    });
    expect(since.records.map((r) => r.record.at.slice(8, 10))).toEqual(["02", "03"]);
  });

  it("lists from a time including the records stamped at it, not the millisecond before", async () => {
    const boundary = "2026-11-02T09:00:00.000Z";
    for (const [at, key] of [
      ["2026-11-02T08:59:59.999Z", "before"],
      [boundary, "at"],
      ["2026-11-02T09:00:00.001Z", "after"],
    ] as const) {
      await writeFailed(store, { ...failure("01", key), at });
    }
    const since = await listRecords(store, "failed", "s3-archive", { since: boundary });
    expect(since.records.map((r) => r.record.idempotency_key)).toEqual(["at", "after"]);
  });

  it("prunes what is older than the retention, by default 30 days, per kind", async () => {
    expect(DEFAULT_RECORD_RETENTION_MS).toBe(30 * 86_400_000);
    for (const day of ["01", "10", "20"]) await writeFailed(store, failure(day, `k${day}`));
    await writeDropped(store, {
      at: "2026-11-01T00:00:00.000Z",
      source: "s3-archive",
      idempotency_key: "d",
      reason: "review_failed",
      policy: "p",
      policy_hash: "h",
      decision_model: "m",
    });
    const now = () => new Date("2026-12-05T09:00:00.000Z");
    expect(await pruneRecords(store, "failed", "s3-archive", { now })).toBe(1);
    expect(await countRecords(store, "failed", "s3-archive")).toBe(2);
    // Each kind has its own retention: the drop record is left to its own prune.
    expect(await countRecords(store, "dropped", "s3-archive")).toBe(1);
    expect(
      await pruneRecords(store, "failed", "s3-archive", { now, retentionMs: 20 * 86_400_000 }),
    ).toBe(1);
    expect(await pruneRecords(store, "dropped", "s3-archive", { now })).toBe(1);
    expect(await pruneRecords(store, "failed", "nothing-here", { now })).toBe(0);
    expect((await store.list(keys.source("s3-archive"))).keys).toHaveLength(1);
  });
});
