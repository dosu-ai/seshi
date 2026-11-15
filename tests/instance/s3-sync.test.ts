/** S3 sync end to end (F6): a bucket served over real HTTP by `FakeS3`, polled by the built-in
 * S3 connector of an Instance booted the way `seshi serve` boots one, through the real
 * pipeline, formats and session filter, into a folder store. */

import { gzipSync } from "node:zlib";
import { getTrace } from "@seshi/pipeline";
import { FakeS3 } from "@seshi/sources/testing";
import { archiveId, listRecords, readChanges, readCheckpoint, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const CLAUDE = transcript("claude-basic.claude-code.jsonl");
const ATIF = transcript("atif-claude-session.atif.json");
const OWNER = "svc:evals";

/** One Claude Code transcript line. */
function claudeLine(uuid: string, role: "user" | "assistant", text: string, session = "sess1") {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: "2026-09-01T00:01:00.000Z",
    sessionId: session,
    message:
      role === "user"
        ? { role, content: text }
        : { role, model: "claude-x", content: [{ type: "text", text }] },
  })}\n`;
}

let fake: FakeS3;
let server: { endpoint: string; stop(): void };
let booted: Awaited<ReturnType<typeof bootInstance>> | undefined;

beforeEach(() => {
  fake = new FakeS3({ bucket: "eval-runs", accessKeyId: "AKID" });
  server = fake.listen();
});
afterEach(async () => {
  server.stop();
  await booted?.cleanup();
  booted = undefined;
});

async function boot(extra = "") {
  booted = await bootInstance(`
[[sources]]
id = "evals"
type = "s3"
url = "s3://eval-runs/harness"
endpoint = "${server.endpoint}"
credentials = { access_key_id = "AKID", secret_access_key = "not-a-real-secret" }
path = "{email}/{session}.*"
visibility = "owner"
filter = { min_chars = 100 }
${extra}
`);
  return booted.instance;
}

const claudeArchive = archiveId(OWNER, "claude-code", "sess1");

describe("S3 sync (F6)", () => {
  it("stores a new object as the source's service account, with claims and provenance", async () => {
    const object = fake.put("harness/alice@x.io/sess1.jsonl", CLAUDE);
    const instance = await boot();
    expect(instance.sources.get("evals")).toMatchObject({ polled: true, connector: "s3" });
    const report = await instance.sources.run("evals");
    expect(report).toMatchObject({ outcome: "ok", outcomes: { stored: 1 } });

    const meta = await readMetadata(instance.store, OWNER, claudeArchive);
    expect(meta).toMatchObject({
      agent: "claude-code",
      session_id: "sess1",
      owner_basis: "service",
      visibility: "owner",
      writer: { kind: "service", principal: OWNER, source_id: "evals" },
      claims: { email: "alice@x.io" },
      provenance: {
        source: "s3",
        source_id: "evals",
        format: "claude-code",
        location: {
          object_key: "s3://eval-runs/harness/alice@x.io/sess1.jsonl",
          etag: object.etag,
        },
      },
    });
    // The transcript ends without a newline; its complete last line was kept.
    expect(meta?.normalized?.bytes).toBe(CLAUDE.length);
    const trace = await getTrace(instance.store, OWNER, claudeArchive, meta?.head as string);
    expect(JSON.stringify(trace)).not.toContain("hunter2secretvalue42");
  });

  it("continues a grown log, and never filters the continuation", async () => {
    fake.put("harness/alice@x.io/sess1.jsonl", CLAUDE);
    const instance = await boot();
    await instance.sources.run("evals");
    const head = (await readMetadata(instance.store, OWNER, claudeArchive))?.head;

    // A short, agent-only tail, far under the source's min_chars: a first trace this small
    // would be filtered; a continuation never is (X4.10).
    fake.append("harness/alice@x.io/sess1.jsonl", `\n${claudeLine("a9", "assistant", "Done.")}`);
    const report = await instance.sources.run("evals");
    expect(report.outcomes).toEqual({ stored: 1 });
    expect(fake.reads().at(-1)?.range).toBeUndefined(); // under 4 KiB: read from the start

    const meta = await readMetadata(instance.store, OWNER, claudeArchive);
    expect(meta?.head).not.toBe(head);
    const object = fake.objects.get("harness/alice@x.io/sess1.jsonl");
    expect(meta?.normalized?.bytes).toBe(object?.body.length);
    const trace = await getTrace(instance.store, OWNER, claudeArchive, meta?.head as string);
    expect(trace?.metadata?.continuation).toMatchObject({ from_record: expect.any(Number) });
    expect(JSON.stringify(trace?.records)).toContain("Done.");
  });

  it("takes a log that grew by a newline only, and continues once a line follows", async () => {
    fake.put("harness/alice@x.io/sess1.jsonl", CLAUDE); // no final newline
    const instance = await boot();
    await instance.sources.run("evals");
    fake.append("harness/alice@x.io/sess1.jsonl", "\n");
    const report = await instance.sources.run("evals");
    expect(report.outcomes).toEqual({ unchanged: 1 });
    expect((await listRecords(instance.store, "failed", "evals")).records).toEqual([]);
    fake.append("harness/alice@x.io/sess1.jsonl", claudeLine("a9", "assistant", "Done."));
    expect((await instance.sources.run("evals")).outcomes).toEqual({ stored: 1 });
    const meta = await readMetadata(instance.store, OWNER, claudeArchive);
    expect(meta?.normalized?.bytes).toBe(
      fake.objects.get("harness/alice@x.io/sess1.jsonl")?.body.length,
    );
  });

  it("reads only the tail of a long log over HTTP (Range)", async () => {
    const long = `${CLAUDE}\n${claudeLine("a2", "assistant", `Long answer ${"text ".repeat(1200)}`)}`;
    fake.put("harness/alice@x.io/sess1.jsonl", long);
    const instance = await boot();
    await instance.sources.run("evals");
    fake.append("harness/alice@x.io/sess1.jsonl", claudeLine("a9", "assistant", "Short."));
    expect((await instance.sources.run("evals")).outcomes).toEqual({ stored: 1 });
    expect(fake.reads().at(-1)?.range).toBe(`bytes=${long.length - 4096}-`);
    const meta = await readMetadata(instance.store, OWNER, claudeArchive);
    expect(meta?.normalized?.bytes).toBe(
      fake.objects.get("harness/alice@x.io/sess1.jsonl")?.body.length,
    );
  });

  it("filters a first trace that is too small, and stores it whole once it grows", async () => {
    fake.put(
      "harness/bob@x.io/s2.jsonl",
      claudeLine("u1", "user", "hi", "s2") + claudeLine("a1", "assistant", "hello", "s2"),
    );
    const instance = await boot();
    expect((await instance.sources.run("evals")).outcomes).toEqual({ filtered: 1 });
    fake.append(
      "harness/bob@x.io/s2.jsonl",
      claudeLine("a2", "assistant", `The answer: ${"detail ".repeat(60)}`, "s2"),
    );
    expect((await instance.sources.run("evals")).outcomes).toEqual({ stored: 1 });
    const meta = await readMetadata(instance.store, OWNER, archiveId(OWNER, "claude-code", "s2"));
    expect(meta?.normalized?.records).toBeGreaterThan(2);
  });

  it("replaces the session when the object is rewritten (F6.3)", async () => {
    fake.put("harness/alice@x.io/sess1.jsonl", CLAUDE);
    const instance = await boot();
    await instance.sources.run("evals");
    fake.put(
      "harness/alice@x.io/sess1.jsonl",
      claudeLine("u1", "user", `A different start ${"words ".repeat(40)}`) +
        claudeLine("a1", "assistant", `A different reply ${"words ".repeat(40)}`),
    );
    expect((await instance.sources.run("evals")).outcomes).toEqual({ stored: 1 });
    const page = await readChanges(instance.store, OWNER);
    const last = page.entries.at(-1)?.entry;
    expect(last).toMatchObject({ archive_id: claudeArchive, replace: true });
  });

  it("stores an ATIF document, detected, and extends it when it grows", async () => {
    fake.put("harness/carol@x.io/atif-1.json", ATIF);
    const instance = await boot();
    await instance.sources.run("evals");
    const archive = archiveId(OWNER, "atif", "atif-1");
    const first = await readMetadata(instance.store, OWNER, archive);
    expect(first).toMatchObject({ agent: "atif", claims: { email: "carol@x.io" } });

    const doc = JSON.parse(ATIF) as { steps: Record<string, unknown>[] };
    const lastStep = doc.steps.at(-1) as { step_id: number };
    doc.steps.push({
      step_id: lastStep.step_id + 1,
      timestamp: "2026-11-01T10:00:00.000Z",
      source: "user",
      message: "One more question about the tokens.",
    });
    fake.put("harness/carol@x.io/atif-1.json", JSON.stringify(doc, null, 2));
    expect((await instance.sources.run("evals")).outcomes).toEqual({ stored: 1 });
    const second = await readMetadata(instance.store, OWNER, archive);
    expect(second?.head).not.toBe(first?.head);
  });

  it("never stores again a session an admin deleted, and ignores source deletions (F6.4)", async () => {
    fake.put("harness/alice@x.io/sess1.jsonl", CLAUDE);
    const instance = await boot();
    await instance.sources.run("evals");
    const admin = instance.sessions({
      owner: OWNER,
      writer: { kind: "admin", principal: "admin", source_id: "upload" },
      owner_basis: "service",
    });
    expect(await admin.tombstone("claude-code", "sess1")).not.toBeNull();

    fake.append("harness/alice@x.io/sess1.jsonl", `\n${claudeLine("a9", "assistant", "More.")}`);
    await instance.sources.run("evals");
    fake.append("harness/alice@x.io/sess1.jsonl", claudeLine("a10", "assistant", "Again."));
    const report = await instance.sources.run("evals");
    expect(report.submitted).toBe(0);
    expect((await readMetadata(instance.store, OWNER, claudeArchive))?.status).toBe("redacted");

    // Deleting the source object changes nothing in seshi; the key leaves the manifest.
    fake.put("harness/dave@x.io/s3.jsonl", CLAUDE.replaceAll("sess1", "s3"));
    await instance.sources.run("evals");
    fake.delete("harness/dave@x.io/s3.jsonl");
    await instance.sources.run("evals");
    const archive = archiveId(OWNER, "claude-code", "s3");
    expect((await readMetadata(instance.store, OWNER, archive))?.head).toBeDefined();
    const cursor = (await readCheckpoint(instance.store, "evals"))?.value.cursor as {
      objects: Record<string, unknown>;
    };
    expect(Object.keys(cursor.objects)).not.toContain("harness/dave@x.io/s3.jsonl");
  });

  it("records what it cannot read where status and seshi sync failed see it (X4.8)", async () => {
    fake.put("harness/erin@x.io/notes.txt", "meeting notes, not a transcript\n");
    const instance = await boot();
    await instance.sources.run("evals");
    const records = (await listRecords(instance.store, "failed", "evals")).records;
    expect(records.map((r) => (r.record as { code: string }).code)).toEqual(["unknown_format"]);
    const status = await instance.sources.status("evals");
    expect(status.failed).toBe(1);
  });

  it("unzips a gzip-encoded object itself, within the size limit, over real HTTP", async () => {
    // Bun's fetch would inflate `Content-Encoding: gzip` before anyone checked the size.
    fake.put("harness/alice@x.io/sess1.jsonl", gzipSync(CLAUDE), { contentEncoding: "gzip" });
    fake.put("harness/bob@x.io/bomb.jsonl", gzipSync(Buffer.alloc(4 << 20, 0x20)), {
      contentEncoding: "gzip",
    });
    fake.put("harness/carol@x.io/odd.jsonl", new Uint8Array([0x8b, 0x00, 0xff, 0xfe]), {
      contentEncoding: "br",
    });
    const instance = await boot(`\n[limits]\nmax_upload_bytes = "1MiB"\n`);
    const report = await instance.sources.run("evals");
    expect(report.outcomes).toEqual({ stored: 1, failed: 2 });
    expect((await readMetadata(instance.store, OWNER, claudeArchive))?.head).toBeDefined();
    const codes = (await listRecords(instance.store, "failed", "evals")).records.map(
      (r) => (r.record as { code: string }).code,
    );
    expect(codes.sort()).toEqual(["too_large", "unsupported_encoding"]);
  });

  it("normalizes again what reprocess rewound, rather than replaying the old answer (X4.9)", async () => {
    fake.put("harness/carol@x.io/atif-1.json", ATIF, {
      modified: new Date("2026-11-10T00:00:00Z"),
    });
    const instance = await boot();
    expect((await instance.sources.run("evals")).outcomes).toEqual({ stored: 1 });

    // To a time: the object changed since, so it is read whole and normalized again.
    await instance.sources.rewind("evals", { since: new Date("2026-11-01T00:00:00Z") });
    expect((await instance.sources.run("evals")).outcomes).toEqual({ unchanged: 1 });
    // Twice to the same time still normalizes again.
    await instance.sources.rewind("evals", { since: new Date("2026-11-01T00:00:00Z") });
    expect((await instance.sources.run("evals")).outcomes).toEqual({ unchanged: 1 });
    // To the start: the manifest is gone, and every object is normalized again.
    await instance.sources.rewind("evals");
    expect((await instance.sources.run("evals")).outcomes).toEqual({ unchanged: 1 });
  });

  it("is run by the worker's job like any polled source (X7)", async () => {
    fake.put("harness/alice@x.io/sess1.jsonl", CLAUDE);
    const instance = await boot();
    await instance.jobs.runNow("source:evals");
    expect((await readMetadata(instance.store, OWNER, claudeArchive))?.head).toBeDefined();
    const status = await instance.status();
    expect(status.sources.find((s) => s.id === "evals")?.checkpoint).not.toBeNull();
  });
});
