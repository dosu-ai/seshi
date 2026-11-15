/** The orphan sweep (F2.5, revised 15 Nov 2026) on both stores: the folder store, whose ages
 * are file mtimes, and an S3 store over an in-memory S3 bucket served through `fetch`, whose
 * ages are the listing's `LastModified`. Sessions are written through the pipeline, so what
 * "named" means is what a real publish leaves (the head and a chunked session's continuations).
 * Crosses store, pipeline and the S3 fake, so it lives in tests/ (X3.6). */

import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { StoreSessionResult } from "@seshi/model";
import { Pipeline, uploadEnvelope } from "@seshi/pipeline";
import { FakeS3 } from "@seshi/sources/testing";
import {
  archiveId,
  FsStore,
  getBytes,
  keys,
  readMetadata,
  S3Store,
  type Store,
  SWEEP_MIN_AGE_MS,
  sweepTraces,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const HOUR = 60 * 60 * 1000;
const ts = "2026-09-01T00:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const meta = () => line({ role: "meta", source: "trajectory" });
/** Long enough that the session filter keeps it. */
const user = (content: string) =>
  line({ role: "user", content: `${content} ${"x".repeat(2000)}`, timestamp: ts });
const reply = (content: string) => line({ role: "assistant", content, timestamp: ts });

/** A store, and a way to make one of its objects look `ms` old to its listing. */
interface Backend {
  store: Store;
  age(key: string, ms: number): void;
  close(): void;
}

function folder(): Backend {
  const dir = mkdtempSync(join(tmpdir(), "seshi-sweep-"));
  const store = new FsStore(dir);
  return {
    store,
    age(key, ms) {
      const at = new Date(Date.now() - ms);
      utimesSync(join(dir, ...key.split("/")), at, at);
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function bucket(): Backend {
  const fake = new FakeS3({ bucket: "seshi", accessKeyId: "AKID", writable: true });
  const store = new S3Store({
    bucket: "seshi",
    prefix: "org",
    endpoint: "http://s3.test",
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    fetch: fake.fetch,
  });
  return {
    store,
    age(key, ms) {
      const object = fake.objects.get(`org/${key}`);
      if (!object) throw new Error(`no object ${key}`);
      object.modified = new Date(Date.now() - ms);
    },
    close: () => {},
  };
}

describe.each([
  ["the folder store", folder],
  ["an S3 store", bucket],
])("sweepTraces on %s (F2.5)", (_name, make) => {
  let backend: Backend;
  let store: Store;
  beforeEach(() => {
    backend = make();
    store = backend.store;
  });
  afterEach(() => backend.close());

  async function upload(sessionId: string, transcript: string, offset = 0, owner = "alice") {
    const pipeline = new Pipeline({ store, formats });
    const result = (await pipeline.submit(
      uploadEnvelope(
        { owner, agent: "trajectory", session_id: sessionId, transcript, format: "jsonl", offset },
        { caller: { kind: "static", principal: owner }, owner_basis: "verified" },
      ),
    )) as StoreSessionResult;
    expect(result.status).toBe("stored");
    return result;
  }

  const archive = (sessionId: string, owner = "alice") => archiveId(owner, "trajectory", sessionId);

  /** An unnamed trace object in the session's folder, `ms` old. */
  async function orphan(sessionId: string, hash: string, ms: number, owner = "alice") {
    const key = keys.trace(owner, archive(sessionId, owner), hash);
    await store.put(key, new TextEncoder().encode("left behind"));
    backend.age(key, ms);
    return key;
  }

  const exists = async (key: string) => (await getBytes(store, key)) !== null;

  it("lists each object's last change when asked", async () => {
    await store.put("a/one", new Uint8Array([1, 2, 3]));
    backend.age("a/one", 2 * HOUR);
    const plain = await store.list("a/");
    expect(plain).toEqual({ keys: ["a/one"], truncated: false });
    const detailed = await store.list("a/", { details: true });
    expect(detailed.keys).toEqual(["a/one"]);
    const modified = Date.parse(detailed.objects?.[0]?.modified as string);
    expect(Math.abs(Date.now() - 2 * HOUR - modified)).toBeLessThan(5_000);
    expect(detailed.objects?.[0]).toMatchObject({ key: "a/one", size: 3 });
  });

  it("deletes an unnamed trace object over an hour old, and keeps one under", async () => {
    await upload("s1", meta() + user("hello") + reply("hi"));
    const old = await orphan("s1", "a".repeat(64), HOUR + 60_000);
    const fresh = await orphan("s1", "b".repeat(64), HOUR - 60_000);
    const report = await sweepTraces(store);
    expect(report).toMatchObject({ sessions: 1, traces: 3, deleted: 1, young: 1, errors: 0 });
    expect(report.swept).toEqual([
      expect.objectContaining({
        owner: "alice",
        archive_id: archive("s1"),
        content_hash: "a".repeat(64),
      }),
    ]);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it("keeps a named head and a named continuation chunk, however old", async () => {
    const first = await upload("s1", meta() + user("hello") + reply("hi"));
    await upload("s1", user("more") + reply("done"), first.bytes_total);
    const session = await readMetadata(store, "alice", archive("s1"));
    expect(session?.traces).toHaveLength(2);
    expect(session?.traces[1]?.continuation).toBeDefined();
    const named = (session?.traces ?? []).map((t) =>
      keys.trace("alice", archive("s1"), t.content_hash),
    );
    for (const key of named) backend.age(key, 365 * 24 * HOUR);
    const old = await orphan("s1", "c".repeat(64), 2 * HOUR);

    const report = await sweepTraces(store);
    expect(report).toMatchObject({ deleted: 1, young: 0, errors: 0 });
    for (const key of named) expect(await exists(key)).toBe(true);
    expect(await exists(old)).toBe(false);
    expect((await readMetadata(store, "alice", archive("s1")))?.traces).toEqual(session?.traces);
  });

  it("deletes the object of a publish that died before any pointer, once it is old", async () => {
    const lost = await orphan("never", "d".repeat(64), 3 * HOUR);
    const report = await sweepTraces(store);
    expect(report.deleted).toBe(1);
    expect(await exists(lost)).toBe(false);
  });

  it("sweeps only the sessions or owners it is given", async () => {
    await upload("s1", meta() + user("one") + reply("ok"));
    await upload("s2", meta() + user("two") + reply("ok"));
    await upload("s3", meta() + user("three") + reply("ok"), 0, "bob");
    const one = await orphan("s1", "a".repeat(64), 2 * HOUR);
    const two = await orphan("s2", "a".repeat(64), 2 * HOUR);
    const bobs = await orphan("s3", "a".repeat(64), 2 * HOUR, "bob");

    const scoped = await sweepTraces(store, {
      sessions: [{ owner: "alice", archive_id: archive("s1") }],
    });
    expect(scoped).toMatchObject({ sessions: 1, deleted: 1 });
    expect([await exists(one), await exists(two), await exists(bobs)]).toEqual([false, true, true]);

    const bob = await sweepTraces(store, { owners: ["bob"] });
    expect(bob.deleted).toBe(1);
    expect([await exists(two), await exists(bobs)]).toEqual([true, false]);
    await expect(sweepTraces(store, { owners: ["not an owner"] })).rejects.toThrow(/not an owner/);
  });

  it("deletes nothing in a dry run, and says what it would", async () => {
    await upload("s1", meta() + user("hello") + reply("hi"));
    const old = await orphan("s1", "a".repeat(64), 2 * HOUR);
    const report = await sweepTraces(store, { dryRun: true });
    expect(report).toMatchObject({ dry_run: true, deleted: 1 });
    expect(await exists(old)).toBe(true);
  });

  it("deletes only trace objects: span records and reviews stay, however old", async () => {
    await upload("s1", meta() + user("hello") + reply("hi"));
    const folderKey = keys.session("alice", archive("s1"));
    const others = [
      `${folderKey}/spans/0123456789abcdef0123456789abcdef-0123456789abcdef.json`,
      `${folderKey}/review/00000000.json`,
      `${folderKey}/notes.txt`,
    ];
    for (const key of others) {
      await store.put(key, new TextEncoder().encode("{}"));
      backend.age(key, 48 * HOUR);
    }
    // A trace object after the span folder in key order is still found.
    const old = await orphan("s1", "e".repeat(64), 2 * HOUR);
    const report = await sweepTraces(store);
    expect(report.deleted).toBe(1);
    expect(await exists(old)).toBe(false);
    for (const key of others) expect(await exists(key)).toBe(true);
  });

  it("goes on past a session it cannot read, deleting nothing of that one", async () => {
    await upload("s1", meta() + user("one") + reply("ok"));
    await upload("s2", meta() + user("two") + reply("ok"));
    const broken = await orphan("s1", "a".repeat(64), 2 * HOUR);
    const fine = await orphan("s2", "a".repeat(64), 2 * HOUR);
    await store.put(keys.metadata("alice", archive("s1")), new TextEncoder().encode("{not json"));
    const report = await sweepTraces(store);
    expect(report).toMatchObject({ errors: 1, deleted: 1 });
    expect(report.error).toBeDefined();
    expect(await exists(broken)).toBe(true);
    expect(await exists(fine)).toBe(false);
  });

  it("uses the age guard it is given", async () => {
    await upload("s1", meta() + user("hello") + reply("hi"));
    const key = await orphan("s1", "a".repeat(64), 10 * 60_000);
    expect((await sweepTraces(store)).deleted).toBe(0);
    expect(SWEEP_MIN_AGE_MS).toBe(HOUR);
    expect((await sweepTraces(store, { minAgeMs: 5 * 60_000 })).deleted).toBe(1);
    expect(await exists(key)).toBe(false);
  });
});
