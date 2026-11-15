import { describe, expect, it } from "vitest";
import {
  archiveId,
  assertSourceId,
  changeStamp,
  keys,
  LAYOUT_KEY,
  LEGACY_LAYOUT_KEY,
  recordKeyHash,
  stampTime,
} from "./layout";
import { StoreError } from "./store";

const archive = archiveId("acme", "claude-code", "s1");
const hash = "a".repeat(64);

describe("layout", () => {
  it("derives a deterministic archive id", () => {
    expect(archiveId("acme", "claude", "s1")).toBe(archiveId("acme", "claude", "s1"));
    expect(archiveId("acme", "claude", "s1")).not.toBe(archiveId("acme", "codex", "s1"));
    expect(archiveId("acme", "claude", "s1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates owners, archive ids and content hashes", () => {
    expect(() => keys.owner("a/b")).toThrow(StoreError);
    expect(() => keys.owner("")).toThrow(StoreError);
    expect(keys.owner("acme.dev_1")).toBe("owners/acme.dev_1");
    expect(() => keys.metadata("acme", "../x")).toThrow(/invalid archive id/);
    expect(() => keys.trace("acme", archive, "nothex")).toThrow(/invalid content hash/);
  });

  it("names the session's objects", () => {
    const base = `owners/acme/sessions/${archive}`;
    expect(keys.metadata("acme", archive)).toBe(`${base}/metadata.json`);
    expect(keys.trace("acme", archive, hash)).toBe(`${base}/trace.${hash}.json.gz`);
    expect(keys.raw("acme", archive, 2, "jsonl")).toBe(`${base}/raw.2.jsonl.gz`);
    expect(keys.spans("acme", archive)).toBe(`${base}/spans/`);
    expect(keys.span("acme", archive, "0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331")).toBe(
      `${base}/spans/0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331.json`,
    );
    expect(() => keys.span("acme", archive, "../", "b7")).toThrow(StoreError);
    expect(keys.reviews("acme", archive)).toBe(`${base}/review/`);
    expect(keys.review("acme", archive, 3)).toBe(`${base}/review/00000003.json`);
    expect(keys.review("acme", archive, 12) > keys.review("acme", archive, 3)).toBe(true);
    expect(() => keys.review("acme", archive, -1)).toThrow(StoreError);
    expect(() => keys.review("acme", archive, 1.5)).toThrow(StoreError);
  });

  it("names the deployment-wide objects", () => {
    expect(keys.marker()).toBe(LAYOUT_KEY);
    expect(LAYOUT_KEY).toBe("seshi.json");
    expect(LEGACY_LAYOUT_KEY).toBe("sessionstorage.json");
    expect(keys.token("tok_0123456789")).toBe("tokens/tok_0123456789.json");
    expect(() => keys.token("short")).toThrow(/invalid token id/);
    expect(() => keys.token("../../../etc")).toThrow(StoreError);
    expect(keys.checkpoint("datadog-prod")).toBe("sources/datadog-prod/checkpoint.json");
    expect(keys.heartbeat()).toBe("worker/heartbeat.json");
    expect(keys.pending(archive)).toBe(`assembly/pending/${archive}`);
    expect(keys.pendingAll()).toBe("assembly/pending/");
  });

  it("validates source ids as config does, upload included", () => {
    expect(assertSourceId("upload")).toBe("upload");
    expect(assertSourceId("dd-prod-2")).toBe("dd-prod-2");
    for (const bad of ["", "DD", "dd--prod", "-dd", "dd-", "dd/x", "a".repeat(65)]) {
      expect(() => assertSourceId(bad)).toThrow(/invalid source id/);
    }
  });

  it("files drop and failure records by time, under a hash of the idempotency key", () => {
    const at = "2026-11-14T09:00:00.000Z";
    const key = keys.record("failed", "upload", at, "session/s1@0");
    expect(key).toBe(
      `sources/upload/failed/20261114T090000.000Z-${recordKeyHash("session/s1@0")}.json`,
    );
    expect(key).not.toContain("s1");
    expect(keys.record("dropped", "upload", at, "x")).toMatch(/^sources\/upload\/dropped\//);
    expect(recordKeyHash("a")).toMatch(/^[0-9a-f]{24}$/);
    expect(() => recordKeyHash("")).toThrow(/idempotency key/);
  });

  it("makes sortable change keys", () => {
    const at = "2026-10-21T21:04:05.123Z";
    expect(changeStamp(at)).toBe("20261021T210405.123Z");
    const key = keys.change("acme", at, "published", hash);
    expect(key).toBe(`owners/acme/changes/20261021T210405.123Z-${hash}.json`);
    expect(keys.change("acme", at, "tombstone", hash)).toBe(
      "owners/acme/changes/20261021T210405.123Z-tombstone.json",
    );
    expect(keys.change("acme", at, "visibility_changed", null)).toBe(
      "owners/acme/changes/20261021T210405.123Z-visibility.json",
    );
    expect(() => keys.change("acme", at, "published", null)).toThrow(StoreError);
    expect(keys.change("acme", "2026-10-21T21:04:06.000Z", "published", hash) > key).toBe(true);
  });

  it("reads a stamp back as a time", () => {
    const at = "2026-10-21T21:04:05.123Z";
    expect(stampTime(changeStamp(at))).toBe(Date.parse(at));
    expect(stampTime(`${changeStamp(at)}-abc.json`)).toBe(Date.parse(at));
    expect(stampTime("nope")).toBeNull();
    expect(() => changeStamp("not a time")).toThrow(StoreError);
  });
});
