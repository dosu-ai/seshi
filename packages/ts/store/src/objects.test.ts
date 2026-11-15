import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { readJson, updateJson } from "./json";
import { archiveId, keys } from "./layout";
import {
  clearPending,
  createToken,
  listPending,
  listReviews,
  listTokens,
  readCheckpoint,
  readHeartbeat,
  readPending,
  readToken,
  type TokenRecord,
  touchPending,
  updateToken,
  writeCheckpoint,
  writeHeartbeat,
  writeReview,
} from "./objects";
import { PreconditionFailed } from "./store";

let dir: string;
let store: FsStore;
const at = (s: string) => () => new Date(`2026-11-14T09:00:${s}.000Z`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-objects-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const token = (id: string): TokenRecord => ({
  schema: "seshi/token/1",
  id,
  hash: "h".repeat(64),
  kind: "device",
  owner: "alice@example.com",
  scopes: ["sessions:write"],
  created_at: "2026-11-14T09:00:00.000Z",
  expires_at: null,
  revoked: false,
});

describe("token records", () => {
  it("are created once (If-None-Match), read, listed and revoked", async () => {
    await createToken(store, token("tok_aaaaaaaa"));
    await createToken(store, token("tok_bbbbbbbb"));
    await expect(createToken(store, token("tok_aaaaaaaa"))).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    expect((await readToken(store, "tok_aaaaaaaa"))?.value.owner).toBe("alice@example.com");
    expect(await listTokens(store)).toEqual({
      ids: ["tok_aaaaaaaa", "tok_bbbbbbbb"],
      cursor: "tok_bbbbbbbb",
      truncated: false,
    });
    expect((await listTokens(store, { after: "tok_aaaaaaaa" })).ids).toEqual(["tok_bbbbbbbb"]);
    const revoked = await updateToken(store, "tok_aaaaaaaa", (t) => ({
      ...t,
      revoked: true,
      revoked_at: "2026-11-15T00:00:00.000Z",
    }));
    expect(revoked?.revoked).toBe(true);
    expect((await readToken(store, "tok_aaaaaaaa"))?.value.revoked).toBe(true);
    expect(await updateToken(store, "tok_missing1", (t) => t)).toBeNull();
    expect(await readToken(store, "tok_missing1")).toBeNull();
  });
});

describe("checkpoints", () => {
  it("are written with If-None-Match first, then If-Match, so a second worker's write fails", async () => {
    expect(await readCheckpoint(store, "dd-prod")).toBeNull();
    const first = await writeCheckpoint(store, "dd-prod", { cursor: "a" }, null, at("01"));
    const read = await readCheckpoint(store, "dd-prod");
    expect(read?.value).toEqual({
      schema: "seshi/checkpoint/1",
      source: "dd-prod",
      updated_at: "2026-11-14T09:00:01.000Z",
      cursor: { cursor: "a" },
    });
    expect(read?.etag).toBe(first);
    // Two workers read the same version; only the first write lands (X7.3).
    await writeCheckpoint(store, "dd-prod", { cursor: "b" }, first, at("02"));
    await expect(
      writeCheckpoint(store, "dd-prod", { cursor: "c" }, first, at("03")),
    ).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(writeCheckpoint(store, "dd-prod", { cursor: "d" }, null)).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    expect((await readCheckpoint(store, "dd-prod"))?.value.cursor).toEqual({ cursor: "b" });
  });
});

describe("worker heartbeat", () => {
  it("is last-writer-wins, so status sees which instance ran last", async () => {
    expect(await readHeartbeat(store)).toBeNull();
    const beat = { version: "0.9.0", roles: ["worker"], started_at: "s", at: "t" };
    await writeHeartbeat(store, { instance: "one", ...beat });
    await writeHeartbeat(store, { instance: "two", ...beat });
    expect((await readHeartbeat(store))?.value).toMatchObject({
      schema: "seshi/heartbeat/1",
      instance: "two",
    });
  });
});

describe("assembly pending markers", () => {
  it("are touched per batch and cleared with If-Match, so a batch during publish keeps its marker", async () => {
    const a = archiveId("svc:otlp-console", "otlp-genai", "sess-1");
    const b = archiveId("svc:otlp-console", "otlp-genai", "sess-2");
    await touchPending(store, "acme", a, at("01"));
    await touchPending(store, "acme", b, at("01"));
    expect((await listPending(store)).archives).toEqual([a, b].sort());
    const read = await readPending(store, a);
    expect(read?.value).toEqual({
      schema: "seshi/pending/1",
      owner: "acme",
      archive_id: a,
      touched_at: "2026-11-14T09:00:01.000Z",
      touch: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    // A batch arrives while the assembler publishes, even in the same millisecond: its clear
    // fails and the marker stays.
    await touchPending(store, "acme", a, at("01"));
    await expect(clearPending(store, a, read?.etag as string)).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    const again = await readPending(store, a);
    await clearPending(store, a, again?.etag as string);
    expect(await readPending(store, a)).toBeNull();
    expect((await listPending(store)).archives).toEqual([b]);
    const [first, second] = [a, b].sort();
    await touchPending(store, "acme", a);
    expect((await listPending(store, { after: first })).archives).toEqual([second]);
  });
});

describe("review decisions", () => {
  it("are numbered per session, written once and listed in order", async () => {
    const archive = archiveId("acme", "claude-code", "s1");
    const review = (n: number) => ({
      n,
      at: "2026-11-14T09:00:00.000Z",
      content_hash: "c".repeat(64),
      policy: "default",
      policy_hash: "p".repeat(64),
      decision: "redact" as const,
      decision_model: "jev",
      redactor_model: "claude-haiku-5-5",
      findings: [{ record: 3, field: "content", category: "secret", action: "redact" as const }],
    });
    for (const n of [10, 2, 0]) await writeReview(store, "acme", archive, review(n));
    await expect(writeReview(store, "acme", archive, review(2))).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    const reviews = await listReviews(store, "acme", archive);
    expect(reviews.map((r) => r.n)).toEqual([0, 2, 10]);
    expect(reviews[0]).toMatchObject({ schema: "seshi/review/1", findings: [{ record: 3 }] });
  });
});

describe("updateJson", () => {
  it("parses, steps and writes JSON, and refuses an object that is not JSON", async () => {
    const key = keys.heartbeat();
    const first = await updateJson<{ n: number }>(store, key, (c) => ({ n: (c?.n ?? 0) + 1 }));
    expect(first).toEqual({ written: true, value: { n: 1 } });
    const same = await updateJson<{ n: number }>(store, key, () => null);
    expect(same).toEqual({ written: false, value: { n: 1 } });
    expect((await readJson<{ n: number }>(store, key))?.value).toEqual({ n: 1 });
    await store.put("bad.json", new TextEncoder().encode("{"));
    await expect(readJson(store, "bad.json")).rejects.toThrow(/not JSON/);
  });
});
