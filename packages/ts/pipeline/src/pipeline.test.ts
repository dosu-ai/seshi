import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import {
  EMPTY_PREFIX_SHA256,
  type Envelope,
  Forbidden,
  type NormalizedRecord,
  OffsetMismatch,
  SessionConflict,
  type SessionUpload,
  StoreError,
  type StoreSessionResult,
} from "@seshi/model";
import { redactionRules } from "@seshi/redact";
import {
  archiveId,
  FsStore,
  keys,
  listRecords,
  listReviews,
  readChanges,
  readHealth,
  readMetadata,
  type Store,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UploadEnvelopeOptions, uploadEnvelope } from "./envelope";
import { getTrace } from "./ingest";
import { Pipeline, type PipelineOptions } from "./pipeline";
import {
  MemoryHealthCounters,
  type ReviewDecision,
  type Reviewer,
  type ReviewInput,
  type SpanAssembler,
  StoreHealthCounters,
} from "./stages";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-pipeline-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const formats = new FormatRegistry(BUILTIN_FORMATS);
const ts = "2026-09-01T00:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const META = line({ role: "meta", source: "trajectory" });
const user = (content: string) => line({ role: "user", content, timestamp: ts });
const reply = (content: string) => line({ role: "assistant", content, timestamp: ts });
const call = (id: string, args: unknown) =>
  line({
    role: "assistant",
    content: null,
    tool_calls: [{ id, name: "Read", args: JSON.stringify(args) }],
    timestamp: ts,
  });
const result = (id: string, content: string) =>
  line({ role: "tool", tool_call_id: id, content, timestamp: ts });
const HEAD = META + user("x".repeat(2000)) + reply("done");
const bytes = (text: string) => Buffer.byteLength(text);

const ALICE: UploadEnvelopeOptions = {
  caller: { kind: "static", principal: "alice" },
  owner_basis: "verified",
};

function upload(
  transcript: string,
  offset = 0,
  extra: Partial<SessionUpload> = {},
  options: UploadEnvelopeOptions = ALICE,
): Envelope {
  return uploadEnvelope(
    {
      owner: "alice",
      agent: "trajectory",
      session_id: "s1",
      transcript,
      format: "jsonl",
      offset,
      ...extra,
    },
    options,
  );
}

function pipeline(options: Partial<PipelineOptions> = {}): Pipeline {
  return new Pipeline({ store, formats, ...options });
}

async function submit(p: Pipeline, envelope: Envelope): Promise<StoreSessionResult> {
  return (await p.submit(envelope)) as StoreSessionResult;
}

/** Every object in the store, by key. */
function objects(root = dir): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

const ARCHIVE = archiveId("alice", "trajectory", "s1");
const session = () => readMetadata(store, "alice", ARCHIVE);

/** A reviewer that answers with `decide` and remembers what it was asked. */
function reviewer(
  decide: (input: ReviewInput) => ReviewDecision,
): Reviewer & { seen: ReviewInput[] } {
  const seen: ReviewInput[] = [];
  return {
    seen,
    review: async (input) => {
      seen.push(input);
      return decide(input);
    },
  };
}

describe("stages and the write (X4.3, X6.3)", () => {
  it("stores only the session's pointer, its trace and its change entry: no raw", async () => {
    const answer = await submit(pipeline(), upload(HEAD));
    expect(answer).toMatchObject({ status: "stored", records: 3, records_total: 3 });
    expect(answer.bytes_total).toBe(bytes(HEAD));
    const base = `owners/alice/sessions/${ARCHIVE}`;
    expect(objects().filter((k) => k.startsWith("owners/"))).toEqual([
      expect.stringMatching(/^owners\/alice\/changes\/\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{64}\.json$/),
      `${base}/metadata.json`,
      `${base}/trace.${(answer as { content_hash: string }).content_hash}.json.gz`,
    ]);
    const metadata = await session();
    expect(metadata && "raw" in metadata).toBe(false);
    expect(metadata).toMatchObject({
      origin_agent: "trajectory",
      native_session_id: "s1",
      writer: { kind: "static", principal: "alice", source_id: "upload" },
      provenance: { source: "upload", source_id: "upload", format: "trajectory" },
      normalized: { bytes: bytes(HEAD), records: 3 },
    });
  });

  it("writes nothing when a later stage fails: a reviewer that throws leaves no session", async () => {
    const failing: Reviewer = {
      review: async () => {
        throw new StoreError("review provider unreachable");
      },
    };
    await expect(submit(pipeline({ reviewer: failing }), upload(HEAD))).rejects.toBeInstanceOf(
      StoreError,
    );
    expect(objects()).toEqual(["seshi.json"]);
  });

  it("redacts the records before anything is written, and records what ran", async () => {
    const p = pipeline({ redaction: redactionRules({ patterns: ["cust_[a-z0-9]{6}"] }) });
    const text =
      META +
      user(`cust_abc123 ${"x".repeat(2000)}`) +
      call("t1", { file_path: ".env" }) +
      result("t1", "A=plain") +
      reply("token ghp_abcdefghijklmnopqrstuvwxyz012345");
    const answer = (await submit(p, upload(text))) as { content_hash: string };
    const trace = await getTrace(store, "alice", ARCHIVE, answer.content_hash);
    const stored = JSON.stringify(trace);
    expect(stored).not.toContain("cust_abc123");
    expect(stored).not.toContain("A=plain");
    expect(stored).not.toContain("ghp_");
    expect(trace?.records[3]).toMatchObject({
      content: "[redacted:sensitive-file]",
      withheld: "sensitive-file",
    });
    const metadata = await session();
    expect(metadata?.redaction?.counts).toEqual({
      "custom-pattern": 1,
      "sensitive-file": 1,
      "github-token": 1,
    });
    expect(metadata?.withheld_calls).toEqual({ t1: "sensitive-file" });
  });

  it("withholds a sensitive result in a later chunk than its call", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD + call("t9", { file_path: "/x/.env" })));
    const second = await submit(
      p,
      upload(result("t9", "SECRET=1") + reply("ok"), first.bytes_total),
    );
    const trace = await getTrace(
      store,
      "alice",
      ARCHIVE,
      (second as { content_hash: string }).content_hash,
    );
    expect(trace?.records[1]).toMatchObject({ content: "[redacted:sensitive-file]" });
  });
});

describe("the session filter (X4.10)", () => {
  it("stores nothing for a filtered session and counts it", async () => {
    const health = new MemoryHealthCounters();
    const answer = await submit(pipeline({ health }), upload(META + user("hi") + reply("yo")));
    expect(answer).toEqual({
      status: "filtered",
      records_total: 0,
      prefix_sha256: EMPTY_PREFIX_SHA256,
      bytes_total: 0,
    });
    expect(objects()).toEqual(["seshi.json"]);
    expect(health.counts).toEqual({ upload: { filtered: 1 } });
  });

  it("takes each source's own rules", async () => {
    const asked: string[] = [];
    const p = pipeline({
      filter: (id) => {
        asked.push(id);
        return { enabled: true, min_chars: 1, require_user: true, require_reply: true };
      },
    });
    const answer = await submit(p, upload(META + user("hi") + reply("yo")));
    expect(answer.status).toBe("stored");
    expect(asked).toEqual(["upload"]);
  });

  it("never judges a chunk past the head, however small or agent-only", async () => {
    const p = pipeline({
      filter: { enabled: true, min_chars: 1_000_000, require_user: true, require_reply: true },
    });
    const strict = await submit(p, upload(HEAD));
    expect(strict.status).toBe("filtered");
    const first = await submit(pipeline(), upload(HEAD));
    const tail = await submit(p, upload(reply("one more"), first.bytes_total));
    expect(tail).toMatchObject({ status: "stored", records: 2 });
  });
});

describe("the log protocol without raw (X6.3, F9.1)", () => {
  it("refuses a chunk for a session without a trace with expected 0, storing nothing", async () => {
    const p = pipeline();
    await expect(submit(p, upload(reply("x"), 120))).rejects.toMatchObject({
      code: "offset_mismatch",
      expected: 0,
    });
    // A filtered session holds nothing either, so its chunks go the same way.
    await submit(p, upload(META + user("hi") + reply("yo")));
    const err = await submit(p, upload(reply("more"), 40)).catch((e) => e);
    expect(err).toBeInstanceOf(OffsetMismatch);
    expect(err.expected).toBe(0);
    expect(objects()).toEqual(["seshi.json"]);
  });

  it("continues the head chunk by chunk, from the session's small stored state", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD));
    const two = await submit(p, upload(user("next") + reply("again"), first.bytes_total));
    expect(two).toMatchObject({ status: "stored", records: 3, records_total: 5 });
    await expect(submit(p, upload(reply("x"), first.bytes_total))).rejects.toMatchObject({
      expected: two.bytes_total,
    });
    // Lines with no records move the log on and write nothing.
    const changes = (await readChanges(store, "alice")).entries.length;
    const quiet = await submit(p, upload("\n", two.bytes_total));
    expect(quiet).toMatchObject({ status: "unchanged", bytes_total: two.bytes_total + 1 });
    expect((await readChanges(store, "alice")).entries).toHaveLength(changes);
    expect((await session())?.normalized?.bytes).toBe(two.bytes_total + 1);
  });

  it("refuses what is not whole lines of a chunkable log", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD));
    await expect(submit(p, upload('{"role":"user"', first.bytes_total))).rejects.toMatchObject({
      code: "bad_chunk",
    });
    await expect(
      submit(p, {
        ...upload(reply("x"), first.bytes_total),
        payload: { kind: "log", encoding: "json", text: "{}\n", offset: first.bytes_total },
      }),
    ).rejects.toMatchObject({ code: "bad_chunk" });
  });
});

describe("extend or replace (X4.6)", () => {
  it("ships a grown whole log as a continuation, from the server's own state", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD));
    const grown = await submit(p, upload(HEAD + user("and") + reply("more")));
    expect(grown).toMatchObject({ status: "stored", records: 3, records_total: 5 });
    const metadata = await session();
    expect(metadata?.traces).toHaveLength(2);
    expect(metadata?.traces[1]?.continuation).toEqual({
      from_record: 3,
      prefix_sha256: first.prefix_sha256,
    });
  });

  it("refuses a whole upload that does not extend the session, without replace", async () => {
    const p = pipeline();
    await submit(p, upload(HEAD));
    const other = META + user("y".repeat(2000)) + reply("other");
    await expect(submit(p, upload(other))).rejects.toBeInstanceOf(SessionConflict);
    // Shorter than what is stored is not an extension either.
    await expect(submit(p, upload(META + user("x".repeat(2000))))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await session())?.traces).toHaveLength(1);
  });

  it("lets the original writer replace the session: one trace, the old ones removed", async () => {
    const p = pipeline();
    const first = (await submit(p, upload(HEAD))) as { content_hash: string };
    await submit(p, upload(HEAD + user("a") + reply("b")));
    const other = META + user("y".repeat(2000)) + reply("other");
    const replaced = (await submit(p, upload(other, 0, { replace: true }))) as {
      status: string;
      content_hash: string;
    };
    expect(replaced.status).toBe("stored");
    const metadata = await session();
    expect(metadata?.traces.map((t) => t.content_hash)).toEqual([replaced.content_hash]);
    expect(metadata?.head).toBe(replaced.content_hash);
    expect(metadata?.normalized?.records).toBe(3);
    expect(await getTrace(store, "alice", ARCHIVE, first.content_hash)).toBeNull();
    const traces = objects().filter((k) => k.includes("/trace."));
    expect(traces).toHaveLength(1);
    const { entries } = await readChanges(store, "alice");
    expect(entries.at(-1)?.entry).toMatchObject({
      kind: "published",
      content_hash: replaced.content_hash,
      replace: true,
    });
    expect(entries.slice(0, -1).every((e) => !("replace" in e.entry))).toBe(true);
  });

  it("forbids a replace by anyone else, and allows an admin's", async () => {
    const p = pipeline();
    await submit(p, upload(HEAD));
    const other = META + user("y".repeat(2000)) + reply("other");
    const bob: UploadEnvelopeOptions = {
      caller: { kind: "static", principal: "bob" },
      owner_basis: "verified",
    };
    await expect(submit(p, upload(other, 0, { replace: true }, bob))).rejects.toBeInstanceOf(
      Forbidden,
    );
    const admin: UploadEnvelopeOptions = {
      caller: { kind: "admin", principal: "root" },
      owner_basis: "verified",
    };
    const answer = await submit(p, upload(other, 0, { replace: true }, admin));
    expect(answer.status).toBe("stored");
    // The session keeps its original writer; the change entry names who replaced it.
    expect((await session())?.writer.principal).toBe("alice");
    const { entries } = await readChanges(store, "alice");
    expect(entries.at(-1)?.entry.writer).toMatchObject({ kind: "admin", principal: "root" });
  });

  it("rewrites a whole document (ATIF) that changed as a replace by its writer", async () => {
    const atif = (steps: number) =>
      JSON.stringify({
        schema_version: "ATIF-v1.6",
        session_id: "doc",
        agent: { name: "harness", version: "1" },
        steps: [
          { step_id: 1, source: "user", message: `q ${"x".repeat(2100)}`, timestamp: ts },
          ...Array.from({ length: steps }, (_, i) => ({
            step_id: i + 2,
            source: "agent",
            message: `answer ${i}`,
            timestamp: ts,
          })),
        ],
      });
    const p = pipeline();
    const doc = (text: string, extra: Partial<SessionUpload> = {}) =>
      uploadEnvelope(
        {
          owner: "alice",
          agent: "atif",
          session_id: "doc",
          transcript: text,
          format: "json",
          ...extra,
        },
        ALICE,
      );
    expect((await submit(p, doc(atif(1)))).status).toBe("stored");
    // The document grew: its records extend what is stored.
    expect(await submit(p, doc(atif(2)))).toMatchObject({ status: "stored", records: 2 });
    // Rewritten from the start: a conflict, unless its writer replaces.
    const rewritten = atif(1).replace("answer 0", "a new answer");
    await expect(submit(p, doc(rewritten))).rejects.toBeInstanceOf(SessionConflict);
    expect((await submit(p, doc(rewritten, { replace: true }))).status).toBe("stored");
  });
});

describe("idempotency (X4.7)", () => {
  it("answers a resend as the first time, without running any stage again", async () => {
    const r = reviewer(() => ({ action: "allow" }));
    const health = new MemoryHealthCounters();
    const p = pipeline({ reviewer: r, health });
    const first = await submit(p, upload(HEAD));
    const again = await submit(p, upload(HEAD));
    expect(again).toEqual(first);
    expect(r.seen).toHaveLength(1);
    expect((await readChanges(store, "alice")).entries).toHaveLength(1);
    expect(health.counts.upload).toEqual({ stored: 1, duplicate: 1 });
  });

  it("answers a chunk sent again after later chunks landed", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD));
    const two = await submit(p, upload(user("two") + reply("2"), first.bytes_total));
    const three = await submit(p, upload(user("three") + reply("3"), two.bytes_total));
    // The uploader lost the answer to the second chunk and sends it again.
    expect(await submit(p, upload(user("two") + reply("2"), first.bytes_total))).toEqual(two);
    expect((await session())?.normalized?.bytes).toBe(three.bytes_total);
    // A different chunk at that offset is not a resend: the log has moved on.
    await expect(
      submit(p, upload(user("other") + reply("x"), first.bytes_total)),
    ).rejects.toMatchObject({ expected: three.bytes_total });
  });

  it("uses the key the envelope names, and remembers only the last few", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD, 0, { idempotency_key: "run-1" }));
    // Same key, other bytes: still the same envelope, so the same answer.
    expect(await submit(p, upload(`${HEAD}\n`, 0, { idempotency_key: "run-1" }))).toEqual(first);
    let at = first.bytes_total;
    for (let i = 0; i < 20; i++) {
      at = (await submit(p, upload(reply(`r${i}`), at))).bytes_total;
    }
    const applied = (await session())?.applied ?? [];
    expect(applied).toHaveLength(16);
    expect(applied.some((a) => a.idempotency_key === "run-1")).toBe(false);
  });
});

describe("model review (F3 seam)", () => {
  it("judges only what the envelope adds: not the meta record, not what is stored", async () => {
    const r = reviewer(() => ({ action: "allow" }));
    const p = pipeline({ reviewer: r });
    await submit(p, upload(HEAD));
    await submit(p, upload(HEAD + user("new") + reply("tail")));
    expect(r.seen.map((s) => s.records.map((x) => x.role))).toEqual([
      ["user", "assistant"],
      ["user", "assistant"],
    ]);
    expect(r.seen[1]?.records[0]).toMatchObject({ content: "new" });
    expect(r.seen[1]?.meta).toMatchObject({ role: "meta" });
    expect(r.seen[0]?.session).toBeNull();
    expect(r.seen[1]?.session?.head).toBeDefined();
  });

  it("drops a first trace: nothing of the session stored, a drop record says why", async () => {
    const health = new MemoryHealthCounters();
    const drop = reviewer(() => ({
      action: "drop",
      reason: "review_drop",
      policy: "default",
      policy_hash: "f".repeat(64),
      decision_model: "jev-1",
    }));
    const answer = await submit(pipeline({ reviewer: drop, health }), upload(HEAD));
    expect(answer).toMatchObject({ status: "dropped", bytes_total: 0 });
    expect(objects().filter((k) => k.startsWith("owners/"))).toEqual([]);
    const { records } = await listRecords(store, "dropped", "upload");
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({
      reason: "review_drop",
      decision_model: "jev-1",
      owner: "alice",
      session_key: "s1",
      source_kind: "upload",
    });
    expect(JSON.stringify(records[0]?.record)).not.toContain("xxxx");
    expect(health.counts.upload).toEqual({ dropped: 1 });
  });

  it("drops a chunk: no trace, but the log moves past it so later chunks continue", async () => {
    let dropNext = false;
    const r = reviewer(() =>
      dropNext
        ? {
            action: "drop",
            reason: "review_failed",
            policy: "p",
            policy_hash: "e".repeat(64),
            decision_model: "m",
          }
        : { action: "allow" },
    );
    const p = pipeline({ reviewer: r });
    const first = await submit(p, upload(HEAD));
    dropNext = true;
    const dropped = await submit(p, upload(user("secret stuff") + reply("ok"), first.bytes_total));
    expect(dropped).toMatchObject({ status: "dropped", records_total: 5 });
    expect((await session())?.traces).toHaveLength(1);
    dropNext = false;
    const next = await submit(p, upload(reply("later"), dropped.bytes_total));
    expect(next).toMatchObject({ status: "stored", records_total: 6 });
    expect((await session())?.traces[1]?.continuation?.from_record).toBe(5);
  });

  it("writes what a redact decision returns, and keeps the decision beside the session", async () => {
    const r = reviewer((input) => ({
      action: "redact",
      records: input.records.map((rec) =>
        rec.role === "user"
          ? ({ ...rec, content: "[redacted:customer-data]" } as NormalizedRecord)
          : rec,
      ),
      note: {
        policy: "default",
        policy_hash: "a".repeat(64),
        decision_model: "jev-1",
        redactor_model: "haiku",
        findings: [{ record: 1, field: "content", category: "customer-data", action: "redact" }],
      },
    }));
    const answer = (await submit(pipeline({ reviewer: r }), upload(HEAD))) as {
      content_hash: string;
    };
    const trace = await getTrace(store, "alice", ARCHIVE, answer.content_hash);
    expect(trace?.records[1]).toMatchObject({ content: "[redacted:customer-data]" });
    const reviews = await listReviews(store, "alice", ARCHIVE);
    expect(reviews).toEqual([
      expect.objectContaining({ n: 0, decision: "redact", content_hash: answer.content_hash }),
    ]);
  });

  it("refuses a redact decision that does not answer record for record, writing nothing", async () => {
    const r = reviewer(() => ({ action: "redact", records: [] }));
    await expect(submit(pipeline({ reviewer: r }), upload(HEAD))).rejects.toThrow(/returned 0/);
    expect(objects()).toEqual(["seshi.json"]);
  });
});

describe("failures (X4.8)", () => {
  const s3 = (envelope: Envelope): Envelope => ({
    ...envelope,
    source: "s3",
    source_id: "logs-bucket",
    caller: { kind: "service", principal: "svc-logs-bucket" },
    owner_basis: "service",
    provenance: { object_key: "sessions/a.jsonl", etag: "abc" },
  });

  it("records a permanent failure with no caller to tell, never its content", async () => {
    const health = new MemoryHealthCounters();
    const p = pipeline({ health });
    const answer = await p.submit(s3({ ...upload("not json at all\n"), format: "trajectory" }));
    expect(answer).toMatchObject({ status: "failed", code: expect.stringMatching(/^normalize_/) });
    const { records } = await listRecords(store, "failed", "logs-bucket");
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({
      source: "logs-bucket",
      source_kind: "s3",
      provenance: { object_key: "sessions/a.jsonl", etag: "abc" },
      session_key: "s1",
    });
    expect(JSON.stringify(records[0]?.record)).not.toContain("not json at all");
    expect(health.counts).toEqual({ "logs-bucket": { failed: 1 } });
    // An unknown format is permanent too.
    expect(await p.submit(s3({ ...upload(HEAD), format: "nope" }))).toMatchObject({
      status: "failed",
      code: "unsupported_agent",
    });
  });

  it("throws a permanent failure to an uploader and counts it as rejected", async () => {
    const health = new MemoryHealthCounters();
    await expect(
      pipeline({ health }).submit({ ...upload(HEAD), format: "nope" }),
    ).rejects.toMatchObject({ code: "unsupported_agent" });
    expect(health.counts).toEqual({ upload: { rejected: 1 } });
    expect(await listRecords(store, "failed", "upload")).toMatchObject({ records: [] });
  });

  it("throws a transient failure whoever sent it, recording nothing", async () => {
    const broken: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key.includes("/trace.")) throw new StoreError("bucket unreachable");
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const p = new Pipeline({ store: broken, formats });
    await expect(p.submit(s3(upload(HEAD)))).rejects.toBeInstanceOf(StoreError);
    expect(objects().filter((k) => k.startsWith("sources/"))).toEqual([]);
  });

  it("refuses a malformed envelope", async () => {
    await expect(pipeline().submit({ ...upload(HEAD), owner: "../etc" })).rejects.toMatchObject({
      code: "bad_envelope",
    });
    await expect(
      pipeline().submit({
        ...upload(HEAD),
        payload: { kind: "log", encoding: "jsonl", text: HEAD, offset: -1 },
      }),
    ).rejects.toMatchObject({ code: "bad_envelope" });
  });

  it("counts into the store's health shards", async () => {
    const health = new StoreHealthCounters(store, { instance: "test", now: () => new Date(ts) });
    const p = pipeline({ health });
    await submit(p, upload(HEAD));
    await submit(p, upload(META + user("hi") + reply("yo"), 0, { session_id: "s2" }));
    await health.flush();
    expect(await readHealth(store, "upload")).toEqual([
      { day: "2026-09-01", counts: { stored: 1, filtered: 1 } },
    ]);
  });
});

describe("span sets (X4.2)", () => {
  const spans = (): Envelope => ({
    ...upload(HEAD),
    source: "otlp",
    source_id: "console",
    format: "trajectory",
    session_key: "sesn_1",
    caller: { kind: "service", principal: "svc-console" },
    owner: "svc-console",
    owner_basis: "service",
    payload: { kind: "spans", spans: [{ traceId: "ab", spanId: "cd" }] },
    idempotency_key: "ab/cd",
  });

  it("refuses span batches without an assembler", async () => {
    expect(await pipeline().submit(spans())).toMatchObject({
      status: "failed",
      code: "unsupported_payload",
    });
  });

  it("hands span batches to the assembler and publishes what it assembles", async () => {
    const accepted: string[] = [];
    const assembler: SpanAssembler = {
      accept: async (batch) => {
        accepted.push(batch.archive_id);
        return {
          status: "accepted",
          archive_id: batch.archive_id,
          spans: batch.envelope.payload.spans.length,
        };
      },
    };
    const p = pipeline({ assembler });
    const archive = archiveId("svc-console", "trajectory", "sesn_1");
    expect(await p.submit(spans())).toEqual({ status: "accepted", archive_id: archive, spans: 1 });
    expect(accepted).toEqual([archive]);

    const records = (text: string) =>
      formats.normalize({ source: "trajectory", transcript: text }).records;
    const first = await p.publishAssembled({ envelope: spans(), records: records(HEAD) });
    expect(first).toMatchObject({ status: "stored", bytes_total: 0 });
    const grown = await p.publishAssembled({
      envelope: spans(),
      records: records(HEAD + reply("late span")),
    });
    expect(grown).toMatchObject({ status: "stored", records: 2 });
    // A rebuilt session that differs from the start replaces it: the assembler is its writer.
    const rebuilt = await p.publishAssembled({
      envelope: spans(),
      records: records(META + user("z".repeat(2000)) + reply("reordered")),
    });
    expect(rebuilt.status).toBe("stored");
    // The same assembly published again is applied once.
    expect(
      await p.publishAssembled({
        envelope: spans(),
        records: records(META + user("z".repeat(2000)) + reply("reordered")),
      }),
    ).toEqual(rebuilt);
    const metadata = await readMetadata(store, "svc-console", archive);
    expect(metadata?.traces).toHaveLength(1);
    // An assembled session the trace format refuses is recorded, not thrown: nobody waits.
    const refused = await p.publishAssembled({
      envelope: spans(),
      records: records(META + user("z".repeat(2000)) + reply("x")).slice(0, 1),
    });
    expect(refused).toMatchObject({ status: "failed", code: "invalid" });
    expect((await listRecords(store, "failed", "console")).records).toHaveLength(1);
    expect(metadata?.owner_basis).toBe("service");
    expect(keys.metadata("svc-console", archive)).toContain(archive);
  });
});

describe("writers racing on one session", () => {
  it("stores one of two different chunks at the same offset; the other learns where the log ends", async () => {
    const p = pipeline();
    const first = await submit(p, upload(HEAD));
    const results = await Promise.allSettled([
      submit(p, upload(user("one") + reply("1"), first.bytes_total)),
      submit(p, upload(user("two, longer") + reply("2"), first.bytes_total)),
    ]);
    const stored = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(stored).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const winner = (stored[0] as PromiseFulfilledResult<StoreSessionResult>).value;
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "offset_mismatch",
      expected: winner.bytes_total,
    });
    const metadata = await session();
    expect(metadata?.traces).toHaveLength(2);
    expect(metadata?.normalized?.bytes).toBe(winner.bytes_total);
    // The loser's trace object was removed again.
    expect(objects().filter((k) => k.includes("/trace."))).toHaveLength(2);
  });

  it("plans a whole upload again when another write landed first", async () => {
    const p = pipeline();
    await submit(p, upload(HEAD));
    const grown = HEAD + user("a") + reply("b");
    const [x, y] = await Promise.all([
      submit(p, upload(grown)),
      submit(p, upload(grown, 0, { idempotency_key: "other-key" })),
    ]);
    // Whichever lands second finds the tail already stored.
    expect([x.status, y.status].sort()).toEqual(["stored", "unchanged"]);
    expect((await session())?.traces).toHaveLength(2);
  });
});
