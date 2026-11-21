/** Runs only against a real Azure Blob Storage endpoint, given by environment:
 *
 *   SESSIONDB_TEST_AZURE_ENDPOINT=http://127.0.0.1:10000/devstoreaccount1   (Azurite)
 *   SESSIONDB_TEST_AZURE_ACCOUNT=devstoreaccount1
 *   SESSIONDB_TEST_AZURE_KEY=<the account key; Azurite's is its documented well-known key>
 *   SESSIONDB_TEST_AZURE_CONTAINER=sessiondb-test   (created when missing)
 *
 * Azurite (Azure's emulator) and a real storage account both qualify. The same cases as
 * s3-live.test.ts, over a Shared Key and over a SAS token made from it, plus the source bucket
 * the poller reads. It crosses packages (the store, the pipeline, the sources), so it lives in
 * tests/ (X3.6). */

import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRecord } from "@seshi/model";
import { getSession, getTrace, ingest, tombstone } from "@seshi/pipeline";
import { AzureSourceBucket, ObjectChanged } from "@seshi/sources";
import {
  AZURE_API_VERSION,
  type AzureKey,
  AzureStore,
  FetchAzureBlobClient,
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

const endpoint = process.env.SESSIONDB_TEST_AZURE_ENDPOINT;
const account = process.env.SESSIONDB_TEST_AZURE_ACCOUNT;
const accountKey = process.env.SESSIONDB_TEST_AZURE_KEY;
const container = process.env.SESSIONDB_TEST_AZURE_CONTAINER ?? "sessiondb-test";
const configured = Boolean(endpoint && account && accountKey);

/** An account SAS (version 2020-12-06 and later) for the blob service, signed with the
 * account key: what an operator would hand seshi instead of the key. */
function accountSas(): string {
  const params = {
    sv: AZURE_API_VERSION,
    ss: "b",
    srt: "sco",
    sp: "rwdlc",
    se: new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    spr: endpoint?.startsWith("https:") ? "https" : "https,http",
  };
  const toSign = [
    account,
    params.sp,
    params.ss,
    params.srt,
    "", // start
    params.se,
    "", // IP
    params.spr,
    params.sv,
    "", // encryption scope
    "",
  ].join("\n");
  const sig = createHmac("sha256", Buffer.from(accountKey as string, "base64"))
    .update(toSign)
    .digest("base64");
  return new URLSearchParams({ ...params, sig }).toString();
}

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

const auths: { name: string; credentials: () => AzureKey }[] = [
  { name: "a shared key", credentials: () => ({ accountKey: accountKey as string }) },
  { name: "a SAS token", credentials: () => ({ sasToken: accountSas() }) },
];

describe.skipIf(!configured)("Azure Blob Storage against a live endpoint", () => {
  beforeAll(async () => {
    await new FetchAzureBlobClient({
      account: account as string,
      container,
      endpoint: endpoint as string,
      credentials: { accountKey: accountKey as string },
    }).createContainer();
  });

  describe.each(auths)("AzureStore with $name", (auth) => {
    const prefix = `test-${auth.name.replace(/\W/g, "")}-${Date.now().toString(36)}`;
    const store = () =>
      AzureStore.fromUrl(`az://${container}/${prefix}`, {
        account: account as string,
        endpoint: endpoint as string,
        credentials: auth.credentials(),
        env: {},
      });

    it("passes the serverless storage test (F11): conditional uploads and deletes", async () => {
      const result = await storageTest(store(), "alice");
      expect(result.steps.filter((step) => !step.ok)).toEqual([]);
      expect(result).toMatchObject({ conditionalWrites: true, conditionalDelete: true });
      expect((await store().list("owners/alice/")).keys).toEqual([]);
    });

    it("round-trips objects, stats, lists after a key and deletes", async () => {
      const s = store();
      const body = new TextEncoder().encode("hello");
      const put = await s.put("a/b.txt", body, { contentType: "text/plain" });
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

    it("honours If-None-Match and If-Match on PUT (X6.5)", async () => {
      const s = store();
      const enc = (v: string) => new TextEncoder().encode(v);
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

    it("publishes and replaces, verifying by reading back (Azure's ETag is not an MD5)", async () => {
      const s = store();
      const enc = (v: string) => new TextEncoder().encode(v);
      const json = "application/json";
      expect(await publishObject(s, "t/x.json", enc('{"trace":1}'), json)).toBe("written");
      expect(await publishObject(s, "t/x.json", enc('{"trace":1}'), json)).toBe("exists");
      expect(await publishObject(s, "t/x.json", enc('{"trace":2}'), json, "replace")).toBe(
        "written",
      );
      expect(new TextDecoder().decode((await getBytes(s, "t/x.json")) as Uint8Array)).toBe(
        '{"trace":2}',
      );
    });
  });

  it("ingests, dedupes, replaces, tails the change feed and tombstones", async () => {
    const { store: s } = openStore(`az://${container}/pipeline-${Date.now().toString(36)}`, {
      accountName: account as string,
      endpoint: endpoint as string,
      credentials: { accountKey: accountKey as string },
      env: {},
    });
    const meta = { session_id: "az-sess", format: "claude", project: "github.com/acme/widget" };
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
    const session = await getSession(s, "acme", "claude", "az-sess");
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
      await tombstone({ store: s, owner: "acme", format: "claude", session_id: "az-sess" }),
    ).toMatchObject({ removed: expect.any(Number) });
    expect((await getSession(s, "acme", "claude", "az-sess"))?.status).toBe("redacted");
  });

  it("serves a source poller: pages, ranged and conditional reads", async () => {
    const prefix = `source-${Date.now().toString(36)}`;
    const writer = AzureStore.fromUrl(`az://${container}/${prefix}`, {
      account: account as string,
      endpoint: endpoint as string,
      credentials: { accountKey: accountKey as string },
      env: {},
    });
    await writer.put("a.jsonl", new TextEncoder().encode("one\ntwo\n"));
    await writer.put("b.jsonl", new TextEncoder().encode("three\n"));
    const bucket = new AzureSourceBucket({
      url: `az://${container}/${prefix}`,
      fetch: (input, init) => fetch(input, init),
      env: {
        AZURE_STORAGE_ACCOUNT: account as string,
        AZURE_STORAGE_CONNECTION_STRING: `AccountName=${account};BlobEndpoint=${endpoint}`,
        AZURE_STORAGE_SAS_TOKEN: accountSas(),
      },
    });
    const first = await bucket.list(`${prefix}/`, { limit: 1 });
    expect(first.objects.map((o) => o.key)).toEqual([`${prefix}/a.jsonl`]);
    expect(first.truncated).toBe(true);
    const second = await bucket.list(`${prefix}/`, { limit: 5, startAfter: `${prefix}/a.jsonl` });
    expect(second.objects.map((o) => o.key)).toEqual([`${prefix}/b.jsonl`]);
    const a = first.objects[0] as { key: string; etag: string };
    const tail = await bucket.read(a.key, { etag: a.etag, start: 4 });
    expect(new TextDecoder().decode(tail?.body)).toBe("two\n");
    expect(tail).toMatchObject({ start: 4, size: 8 });
    expect(bucket.locate(a.key)).toBe(`az://${container}/${a.key}`);
    await writer.put("a.jsonl", new TextEncoder().encode("one\ntwo\nthree\n"));
    await expect(bucket.read(a.key, { etag: a.etag })).rejects.toBeInstanceOf(ObjectChanged);
    expect(await bucket.read(`${prefix}/none`, { etag: a.etag })).toBeNull();
  });

  it("sets up a serverless machine with seshi init --serverless --url az://, and uploads", async () => {
    const machine = new Machine({ AZURE_STORAGE_KEY: accountKey as string });
    try {
      const url = `az://${container}/serverless-${Date.now().toString(36)}`;
      const init = await machine.seshi([
        "init",
        "--serverless",
        "--url",
        url,
        "--account-name",
        account as string,
        "--endpoint",
        endpoint as string,
        "--owner",
        "alice",
        "--key-from-env",
      ]);
      expect(init.code, init.err).toBe(0);
      expect(init.out).toContain("conditional uploads ok; conditional deletes ok");
      // The key is kept in the machine's secrets: later commands need no variable.
      const file = join(machine.dir, "s1.jsonl");
      writeFileSync(file, LONG_SESSION);
      const sent = await machine.seshi(["upload", "--agent", "claude-code", file], {
        env: { AZURE_STORAGE_KEY: "" },
      });
      expect(sent.code, sent.out + sent.err).toBe(0);
      expect((await machine.seshi(["sessions", "ls"])).out).toContain("claude-code/s1");
    } finally {
      machine.cleanup();
    }
  });
});
