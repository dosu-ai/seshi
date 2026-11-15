import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { addHealth, healthDay, readHealth, sourcesWithHealth } from "./health";
import { writeFailed } from "./records";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-health-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = "2026-11-14T09:00:00.000Z";

describe("source health counters", () => {
  it("sums each day's shards, oldest day first", async () => {
    await addHealth(store, {
      source: "upload",
      day: "2026-11-14",
      instance: "api-1",
      counts: { stored: 2, filtered: 1 },
      at,
    });
    await addHealth(store, {
      source: "upload",
      day: "2026-11-14",
      instance: "api-1",
      counts: { stored: 1 },
      at,
    });
    await addHealth(store, {
      source: "upload",
      day: "2026-11-14",
      instance: "worker",
      counts: { failed: 4 },
      at,
    });
    await addHealth(store, {
      source: "upload",
      day: "2026-11-13",
      instance: "api-1",
      counts: { dropped: 1 },
      at,
    });
    expect(await readHealth(store, "upload")).toEqual([
      { day: "2026-11-13", counts: { dropped: 1 } },
      { day: "2026-11-14", counts: { stored: 3, filtered: 1, failed: 4 } },
    ]);
    expect(await readHealth(store, "upload", { since: "2026-11-14" })).toEqual([
      { day: "2026-11-14", counts: { stored: 3, filtered: 1, failed: 4 } },
    ]);
  });

  it("loses no count when one shard is updated concurrently", async () => {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        addHealth(store, {
          source: "dd-prod",
          day: "2026-11-14",
          instance: "worker",
          counts: { stored: 1 },
          at,
        }),
      ),
    );
    expect(await readHealth(store, "dd-prod")).toEqual([
      { day: "2026-11-14", counts: { stored: 12 } },
    ]);
  });

  it("writes nothing for no counts, and lists the sources that have counters", async () => {
    await addHealth(store, { source: "s3-logs", day: "2026-11-14", instance: "w", counts: {}, at });
    expect(await sourcesWithHealth(store)).toEqual([]);
    await addHealth(store, {
      source: "s3-logs",
      day: "2026-11-14",
      instance: "w",
      counts: { filtered: 1 },
      at,
    });
    await writeFailed(store, {
      at,
      source: "upload",
      idempotency_key: "k",
      code: "invalid",
      message: "m",
    });
    expect(await sourcesWithHealth(store)).toEqual(["s3-logs"]);
  });

  it("names the UTC day", () => {
    expect(healthDay(new Date("2026-11-14T23:59:59.999Z"))).toBe("2026-11-14");
    expect(healthDay(new Date("2026-11-15T00:00:00.000Z"))).toBe("2026-11-15");
  });
});
