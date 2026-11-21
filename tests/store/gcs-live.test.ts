/** Runs only against a Google Cloud Storage endpoint, given by environment. Either an emulator:
 *
 *   SESHI_TEST_GCS_EMULATOR=http://127.0.0.1:4443   (fake-gcs-server; no credentials)
 *   SESHI_TEST_GCS_BUCKET=seshi-test           (created when missing)
 *
 * or a real bucket, with SESHI_TEST_GCS_BUCKET alone and Application Default Credentials
 * in the environment (GOOGLE_APPLICATION_CREDENTIALS, gcloud's application-default login, or the
 * metadata server). The same cases as azure-live.test.ts: the store, the pipeline, the source
 * bucket the poller reads, and seshi init --serverless.
 *
 * fake-gcs-server honours `ifGenerationMatch` on uploads but ignores it on deletes and reads.
 * The client checks a read's generation itself, so conditional reads hold on the emulator too;
 * conditional deletes are asserted only against a real bucket, and covered by the unit tests in
 * packages/ts/store/src/gcs*.test.ts against a bucket that honours them. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRecord } from "@seshi/model";
import { getSession, getTrace, ingest, tombstone } from "@seshi/pipeline";
import { GcsSourceBucket, ObjectChanged } from "@seshi/sources";
import {
  FetchGcsClient,
  GcsStore,
  getBytes,
  openStore,
  PreconditionFailed,
  publishObject,
  readChanges,
  storageTest,
  updateObject,
} from "@seshi/store";
import { beforeAll, describe, expect, it } from "vitest";
import { Machine } from "../tooling/cli";
import { golden, transcript } from "../tooling/testdata";

const emulator = process.env.SESHI_TEST_GCS_EMULATOR;
const bucket = process.env.SESHI_TEST_GCS_BUCKET ?? (emulator ? "seshi-test" : undefined);
const configured = Boolean(bucket);
/** What the store reads its endpoint and credentials from: the emulator's host, else this
 * process's Application Default Credentials. */
const env: Record<string, string | undefined> = emulator
  ? { STORAGE_EMULATOR_HOST: emulator }
  : process.env;

const records = golden<Record<string, unknown>[]>("claude-basic.records.json").map(
  ({ llm_call: _, ...record }) => record as unknown as NormalizedRecord,
);

/** A session past the default session filter's minimum size, as tests/cli/serverless.test.ts. */
const LONG_SESSION = `${transcript("claude-basic.claude-code.jsonl").trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

const enc = (v: string) => new TextEncoder().encode(v);
const run = Date.now().toString(36);
const store = (prefix: string) => GcsStore.fromUrl(`gs://${bucket}/${prefix}-${run}`, { env });

describe.skipIf(!configured)("Google Cloud Storage against a live endpoint", () => {
  beforeAll(async () => {
    if (emulator) {
      await new FetchGcsClient({
        bucket: bucket as string,
        endpoint: emulator,
        token: undefined,
      }).createBucket();
    }
  });

  it("passes the serverless storage test (F11): conditional uploads, and deletes on GCS", async () => {
    const s = store("storage");
    const result = await storageTest(s, "alice");
    expect(result.steps.filter((step) => step.step <= 4 && !step.ok)).toEqual([]);
    expect(result.conditionalWrites).toBe(true);
    if (!emulator) expect(result.conditionalDelete).toBe(true);
    expect((await s.list("owners/alice/")).keys).toEqual([]);
  });

  it("round-trips objects, stats, lists after a key and deletes", async () => {
    const s = store("objects");
    const body = enc("hello");
    const put = await s.put("a/b.txt", body, { contentType: "text/plain" });
    expect(put.etag).toMatch(/^\d+$/);
    expect(await s.get("a/b.txt")).toEqual({ body, etag: put.etag });
    expect(await s.stat("a/b.txt")).toEqual({
      size: 5,
      etag: put.etag,
      modified: expect.any(String),
    });
    expect(await getBytes(s, "a/missing")).toBeNull();
    expect(await s.stat("a/missing")).toBeNull();
    await s.put("a/c d.txt", body);
    await s.put("a/e.txt", body);
    expect((await s.list("a/")).keys).toEqual(["a/b.txt", "a/c d.txt", "a/e.txt"]);
    expect(await s.list("a/", { startAfter: "a/b.txt", limit: 1 })).toEqual({
      keys: ["a/c d.txt"],
      truncated: true,
    });
    expect((await s.list("a/", { startAfter: "a/c d.txt" })).keys).toEqual(["a/e.txt"]);
    const detailed = await s.list("a/", { details: true, limit: 1 });
    expect(detailed.objects).toEqual([
      { key: "a/b.txt", size: 5, etag: put.etag, modified: expect.any(String) },
    ]);
    await s.delete("a/b.txt");
    await s.delete("a/b.txt");
    expect(await getBytes(s, "a/b.txt")).toBeNull();
  });

  it("honours generation preconditions on upload (X6.5)", async () => {
    const s = store("conditions");
    const created = await s.put("c/k", enc("one"), { ifNoneMatch: "*" });
    await expect(s.put("c/k", enc("two"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await s.put("c/k", enc("two"), { ifMatch: created.etag });
    await expect(s.put("c/k", enc("three"), { ifMatch: created.etag })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await expect(s.put("c/gone", enc("x"), { ifMatch: created.etag })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        updateObject(s, "c/n", (cur) =>
          enc(String(Number(cur ? new TextDecoder().decode(cur.body) : "0") + 1)),
        ),
      ),
    );
    expect(new TextDecoder().decode((await getBytes(s, "c/n")) as Uint8Array)).toBe("4");
  });

  it("publishes and replaces, verifying by reading back (a generation is not an MD5)", async () => {
    const s = store("publish");
    const json = "application/json";
    expect(await publishObject(s, "t/x.json", enc('{"trace":1}'), json)).toBe("written");
    expect(await publishObject(s, "t/x.json", enc('{"trace":1}'), json)).toBe("exists");
    expect(await publishObject(s, "t/x.json", enc('{"trace":2}'), json, "replace")).toBe("written");
    expect(new TextDecoder().decode((await getBytes(s, "t/x.json")) as Uint8Array)).toBe(
      '{"trace":2}',
    );
  });

  it("ingests, dedupes, replaces, tails the change feed and tombstones", async () => {
    const { store: s } = openStore(`gs://${bucket}/pipeline-${run}`, { env });
    const meta = { session_id: "gs-sess", format: "claude", project: "github.com/acme/widget" };
    const first = await ingest({ store: s, owner: "acme", records, metadata: meta });
    expect(first.status).toBe("stored");
    expect((await ingest({ store: s, owner: "acme", records, metadata: meta })).status).toBe(
      "duplicate",
    );
    expect(await getTrace(s, "acme", first.archive_id, first.content_hash)).toMatchObject({
      content_hash: first.content_hash,
    });

    // A rebuild or redaction backfill publishes the session again under a new hash.
    const replaced = await ingest({
      store: s,
      owner: "acme",
      records: records.slice(0, -1),
      metadata: meta,
      replace: true,
    });
    expect(replaced.status).toBe("stored");
    expect(replaced.content_hash).not.toBe(first.content_hash);
    const session = await getSession(s, "acme", "claude", "gs-sess");
    expect(session?.traces.map((t) => t.content_hash)).toEqual([replaced.content_hash]);
    expect(await getTrace(s, "acme", first.archive_id, first.content_hash)).toBeNull();
    expect(
      (await readChanges(s, "acme")).entries.map((e) => ({
        kind: e.entry.kind,
        replace: "replace" in e.entry ? e.entry.replace : undefined,
      })),
    ).toEqual([
      { kind: "published", replace: undefined },
      { kind: "published", replace: true },
    ]);

    expect(
      await tombstone({ store: s, owner: "acme", format: "claude", session_id: "gs-sess" }),
    ).toMatchObject({ removed: expect.any(Number) });
    expect((await getSession(s, "acme", "claude", "gs-sess"))?.status).toBe("redacted");
  });

  it("serves a source poller: pages, ranged and conditional reads", async () => {
    const prefix = `source-${run}`;
    const writer = GcsStore.fromUrl(`gs://${bucket}/${prefix}`, { env });
    await writer.put("a.jsonl", enc("one\ntwo\n"));
    await writer.put("b.jsonl", enc("three\n"));
    const source = new GcsSourceBucket({
      url: `gs://${bucket}/${prefix}`,
      fetch: (input, init) => fetch(input, init),
      env,
    });
    const first = await source.list(`${prefix}/`, { limit: 1 });
    expect(first.objects.map((o) => o.key)).toEqual([`${prefix}/a.jsonl`]);
    expect(first.truncated).toBe(true);
    const second = await source.list(`${prefix}/`, { limit: 5, startAfter: `${prefix}/a.jsonl` });
    expect(second.objects.map((o) => o.key)).toEqual([`${prefix}/b.jsonl`]);
    const a = first.objects[0] as { key: string; etag: string };
    const tail = await source.read(a.key, { etag: a.etag, start: 4 });
    expect(new TextDecoder().decode(tail?.body)).toBe("two\n");
    expect(tail).toMatchObject({ start: 4, size: 8 });
    expect(source.locate(a.key)).toBe(`gs://${bucket}/${a.key}`);
    await writer.put("a.jsonl", enc("one\ntwo\nthree\n"));
    await expect(source.read(a.key, { etag: a.etag })).rejects.toBeInstanceOf(ObjectChanged);
    expect(await source.read(`${prefix}/none`, { etag: a.etag })).toBeNull();
  });

  it.skipIf(!emulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS)(
    "sets up a serverless machine with seshi init --serverless --url gs://, and uploads",
    async () => {
      const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const machine = new Machine(
        emulator
          ? { STORAGE_EMULATOR_HOST: emulator }
          : { GOOGLE_APPLICATION_CREDENTIALS: keyFile as string },
      );
      try {
        const url = `gs://${bucket}/serverless-${run}`;
        const init = await machine.seshi([
          "init",
          "--serverless",
          "--url",
          url,
          ...(emulator ? ["--endpoint", emulator] : ["--key-from-env"]),
          "--owner",
          "alice",
        ]);
        expect(init.code, init.err).toBe(0);
        expect(init.out).toContain("conditional uploads ok");
        const file = join(machine.dir, "s1.jsonl");
        writeFileSync(file, LONG_SESSION);
        // A key from --key-from-env is kept in the machine's secrets: no variable needed later.
        const sent = await machine.seshi(["upload", "--agent", "claude-code", file], {
          env: { GOOGLE_APPLICATION_CREDENTIALS: "" },
        });
        expect(sent.code, sent.out + sent.err).toBe(0);
        expect((await machine.seshi(["sessions", "ls"])).out).toContain("claude-code/s1");
      } finally {
        machine.cleanup();
      }
    },
  );
});
