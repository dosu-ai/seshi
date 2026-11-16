/** Runs only against a real S3-compatible endpoint, given by environment:
 *
 *   SESSIONDB_TEST_S3_ENDPOINT=http://127.0.0.1:9000
 *   SESSIONDB_TEST_S3_BUCKET=sessionstorage-test
 *   SESSIONDB_TEST_S3_ACCESS_KEY / SESSIONDB_TEST_S3_SECRET_KEY
 *
 * The bucket must exist. MinIO, RustFS, Garage, R2 and AWS all qualify. It crosses packages (the
 * store and the pipeline over it), so it lives in tests/ (X3.6). */

import type { NormalizedRecord } from "@seshi/model";
import { getSession, getTrace, ingest, tombstone } from "@seshi/pipeline";
import { getBytes, PreconditionFailed, readChanges, S3Store, updateObject } from "@seshi/store";
import { describe, expect, it } from "vitest";
import { golden } from "../tooling/testdata";

const endpoint = process.env.SESSIONDB_TEST_S3_ENDPOINT;
const bucket = process.env.SESSIONDB_TEST_S3_BUCKET;
const accessKeyId = process.env.SESSIONDB_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.SESSIONDB_TEST_S3_SECRET_KEY;
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
// `S3Store` signs its own requests over `fetch` on every runtime (Bun.S3Client cannot send
// If-Match / If-None-Match); the global fetch and an explicit one should agree.
const clients = [
  { name: "global fetch", fetch: undefined },
  { name: "explicit fetch", fetch: (input: string, init?: RequestInit) => fetch(input, init) },
];

const records = golden<Record<string, unknown>[]>("claude-basic.records.json").map(
  ({ llm_call: _, ...record }) => record as unknown as NormalizedRecord,
);

describe.skipIf(!configured).each(clients)(
  "S3Store over $name against a live endpoint",
  (client) => {
    const prefix = `test-${client.name.replace(/\W/g, "")}-${Date.now().toString(36)}`;
    const store = () =>
      S3Store.fromUrl(`s3://${bucket}/${prefix}`, {
        endpoint,
        credentials: {
          accessKeyId: accessKeyId as string,
          secretAccessKey: secretAccessKey as string,
        },
        fetch: client.fetch,
      });

    it("round-trips objects, stats with an MD5 etag, lists and deletes", async () => {
      const s = store();
      const body = new TextEncoder().encode("hello");
      await s.put("a/b.txt", body, { contentType: "text/plain" });
      expect(await s.get("a/b.txt")).toEqual({ body, etag: "5d41402abc4b2a76b9719d911017c592" });
      expect(await s.stat("a/b.txt")).toEqual({
        size: 5,
        etag: "5d41402abc4b2a76b9719d911017c592",
        modified: expect.any(String),
      });
      expect(await getBytes(s, "a/missing")).toBeNull();
      expect(await s.stat("a/missing")).toBeNull();
      await s.put("a/c.txt", body);
      expect((await s.list("a/")).keys).toEqual(["a/b.txt", "a/c.txt"]);
      expect((await s.list("a/", { startAfter: "a/b.txt" })).keys).toEqual(["a/c.txt"]);
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
      await Promise.all(
        Array.from({ length: 4 }, () =>
          updateObject(s, "c/n", (cur) =>
            enc(String(Number(cur ? new TextDecoder().decode(cur.body) : "0") + 1)),
          ),
        ),
      );
      expect(new TextDecoder().decode((await getBytes(s, "c/n")) as Uint8Array)).toBe("4");
    });

    it("ingests, dedupes, tails the change feed and tombstones", async () => {
      const s = store();
      const meta = { session_id: "s3-sess", agent: "claude", project: "github.com/acme/widget" };
      const first = await ingest({ store: s, owner: "acme", records, metadata: meta });
      expect(first.status).toBe("stored");
      const again = await ingest({ store: s, owner: "acme", records, metadata: meta });
      expect(again.status).toBe("duplicate");
      expect(await getTrace(s, "acme", first.archive_id, first.content_hash)).toMatchObject({
        content_hash: first.content_hash,
      });
      expect((await readChanges(s, "acme")).entries.map((e) => e.entry.kind)).toEqual([
        "published",
      ]);
      expect(
        await tombstone({ store: s, owner: "acme", agent: "claude", session_id: "s3-sess" }),
      ).toEqual({
        removed: 1,
      });
      expect((await getSession(s, "acme", "claude", "s3-sess"))?.status).toBe("redacted");
    });
  },
);
