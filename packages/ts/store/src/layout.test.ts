import { describe, expect, it } from "vitest";
import {
  archiveId,
  assertSourceId,
  changeStamp,
  changeSuffix,
  keys,
  LAYOUT_KEY,
  parseChangeKey,
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
    // No raw parts any more (X6.3): a session is its pointer, traces and change entries.
    expect("raw" in keys).toBe(false);
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
    expect(keys.token("tok_0123456789")).toBe("tokens/tok_0123456789.json");
    expect(() => keys.token("short")).toThrow(/invalid token id/);
    expect(() => keys.token("../../../etc")).toThrow(StoreError);
    expect(keys.checkpoint("datadog-prod")).toBe("sources/datadog-prod/checkpoint.json");
    expect(keys.heartbeat()).toBe("worker/heartbeat.json");
    expect(keys.pending(archive)).toBe(`assembly/pending/${archive}`);
    expect(keys.pendingAll()).toBe("assembly/pending/");
    expect(keys.health("upload", "2026-11-14", "i-01")).toBe(
      "sources/upload/health/2026-11-14/i-01.json",
    );
    expect(keys.healthDay("upload", "2026-11-14")).toBe("sources/upload/health/2026-11-14/");
    expect(() => keys.health("upload", "2026-13-99", "i")).toThrow(/invalid day/);
    expect(() => keys.health("upload", "14-11-2026", "i")).toThrow(/invalid day/);
    expect(() => keys.health("upload", "2026-11-14", "../x")).toThrow(/invalid instance id/);
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

  it("makes sortable, unique change keys (decision 8 of 18)", () => {
    const at = "2026-10-21T21:04:05.123Z";
    expect(changeStamp(at)).toBe("20261021T210405.123Z");
    const key = keys.change("acme", at, archive, "0a1b2c3d", "published", hash);
    expect(key).toBe(`owners/acme/changes/20261021T210405.123Z-${archive}-0a1b2c3d-${hash}.json`);
    expect(keys.change("acme", at, archive, "0a1b2c3d", "tombstone", hash)).toBe(
      `owners/acme/changes/20261021T210405.123Z-${archive}-0a1b2c3d-tombstone.json`,
    );
    expect(keys.change("acme", at, archive, "0a1b2c3d", "visibility_changed", null)).toBe(
      `owners/acme/changes/20261021T210405.123Z-${archive}-0a1b2c3d-visibility.json`,
    );
    expect(() => keys.change("acme", at, archive, "0a1b2c3d", "published", null)).toThrow(
      StoreError,
    );
    expect(() => keys.change("acme", at, "s1", "0a1b2c3d", "tombstone", null)).toThrow(
      /archive id/,
    );
    expect(() => keys.change("acme", at, archive, "../x", "tombstone", null)).toThrow(/suffix/);
    // The stamp leads, so a later change sorts after, whatever its session or suffix, and a
    // cursor at a stamp (`since`) sorts before every key with it.
    const later = keys.change(
      "acme",
      "2026-10-21T21:04:05.124Z",
      "0".repeat(64),
      "00000000",
      "tombstone",
      null,
    );
    expect(later > keys.change("acme", at, "f".repeat(64), "ffffffff", "published", hash)).toBe(
      true,
    );
    expect(key > `owners/acme/changes/${changeStamp(at)}`).toBe(true);
  });

  it("draws a fresh suffix for every change", () => {
    const suffixes = new Set(Array.from({ length: 64 }, () => changeSuffix()));
    expect(suffixes.size).toBe(64);
    for (const s of suffixes) expect(s).toMatch(/^[0-9a-f]{8}$/);
  });

  it("parses a change key back", () => {
    const at = "2026-10-21T21:04:05.123Z";
    const key = keys.change("acme", at, archive, "0a1b2c3d", "published", hash);
    expect(parseChangeKey(key)).toEqual({
      at: Date.parse(at),
      archive_id: archive,
      suffix: "0a1b2c3d",
      kind: "published",
      content_hash: hash,
    });
    const name = key.slice("owners/acme/changes/".length);
    expect(parseChangeKey(name)?.kind).toBe("published");
    expect(
      parseChangeKey(keys.change("acme", at, archive, "0a1b2c3d", "tombstone", null)),
    ).toMatchObject({ kind: "tombstone", content_hash: null });
    expect(
      parseChangeKey(keys.change("acme", at, archive, "0a1b2c3d", "visibility_changed", null)),
    ).toMatchObject({ kind: "visibility_changed", content_hash: null });
    // The old layout's keys, and anything else, are not change keys.
    expect(parseChangeKey("20261021T210405.123Z-tombstone.json")).toBeNull();
    expect(parseChangeKey(`20261021T210405.123Z-${hash}.json`)).toBeNull();
    expect(parseChangeKey("notes.txt")).toBeNull();
  });

  it("reads a stamp back as a time", () => {
    const at = "2026-10-21T21:04:05.123Z";
    expect(stampTime(changeStamp(at))).toBe(Date.parse(at));
    expect(stampTime(`${changeStamp(at)}-abc.json`)).toBe(Date.parse(at));
    expect(stampTime("nope")).toBeNull();
    expect(() => changeStamp("not a time")).toThrow(StoreError);
  });
});
