import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ATIF_FORMAT,
  BUILTIN_FORMATS,
  FormatRegistry,
  otlpGenAiFormat,
  TRAJECTORY_FORMAT,
} from "@seshi/formats";
import {
  EMPTY_PREFIX_SHA256,
  type Envelope,
  Forbidden,
  type FormatAdapter,
  isStub,
  type NormalizedRecord,
  OffsetMismatch,
  SessionConflict,
  type SessionUpload,
  StoreError,
  type StoreSessionResult,
} from "@seshi/model";
import { compileRuleSet, redactionRules, validatePack } from "@seshi/redact";
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
  updateMetadata,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UploadEnvelopeOptions, uploadEnvelope } from "./envelope";
import { getTrace, setVisibility, tombstone } from "./ingest";
import { Pipeline, type PipelineOptions } from "./pipeline";
import { StoreSessionDB } from "./session-db";
import {
  MemoryHealthCounters,
  type ReviewDecision,
  type Reviewer,
  type ReviewInput,
  type SpanAssembler,
  StoreHealthCounters,
} from "./stages";
import { staleSessions } from "./stale";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-pipeline-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const formats = new FormatRegistry([...BUILTIN_FORMATS, otlpGenAiFormat()]);
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
      format: "trajectory",
      session_id: "s1",
      transcript,
      encoding: "jsonl",
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
      expect.stringMatching(
        new RegExp(
          `^owners/alice/changes/\\d{8}T\\d{6}\\.\\d{3}Z-${ARCHIVE}-[0-9a-f]{8}-[0-9a-f]{64}\\.json$`,
        ),
      ),
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

  it("records the rule set and counts by rule id on every stored session (F2.3)", async () => {
    const acme = validatePack(
      { id: "acme", rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }] },
      { source: "acme.toml" },
    );
    const rules = compileRuleSet({ packs: [acme] });
    const p = pipeline({ redaction: rules });
    // Nothing to redact: the rule set is still recorded, with no counts.
    const first = await submit(p, upload(HEAD));
    expect((await session())?.redaction).toEqual({ rule_set: rules.hash, counts: {} });
    // A chunk's counts are added to the session's.
    await submit(p, upload(user("key ACME-1234 and ACME-5678"), first.bytes_total));
    expect((await session())?.redaction).toEqual({
      rule_set: rules.hash,
      counts: { "acme-key": 2 },
    });
    expect(rules.hash).not.toBe(compileRuleSet().hash);
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

  it("never judges a whole log's tail, however small or agent-only", async () => {
    const strict = { enabled: true, min_chars: 1_000_000, require_user: true, require_reply: true };
    await submit(pipeline(), upload(HEAD));
    const tail = await submit(pipeline({ filter: strict }), upload(HEAD + reply("ok")));
    expect(tail).toMatchObject({ status: "stored", records: 2, records_total: 4 });
    expect((await session())?.traces).toHaveLength(2);
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

  it("starts a replaced session's applied envelopes and redaction counts over", async () => {
    const p = pipeline();
    const secret = reply("token ghp_abcdefghijklmnopqrstuvwxyz012345");
    const firstUpload = upload(HEAD + secret);
    const first = (await submit(p, firstUpload)) as { content_hash: string };
    expect((await session())?.redaction?.counts).toEqual({ "github-token": 1 });
    const other = META + user("y".repeat(2000)) + reply("other");
    const replaced = await submit(p, upload(other, 0, { replace: true }));
    const metadata = await session();
    expect(metadata?.applied?.map((a) => a.content_hash)).toEqual([
      (replaced as { content_hash: string }).content_hash,
    ]);
    expect(metadata?.redaction?.counts).toEqual({});
    // The first upload sent again is no longer answered with a trace that is gone: it does not
    // extend the replaced session.
    await expect(submit(p, firstUpload)).rejects.toBeInstanceOf(SessionConflict);
    expect(await getTrace(store, "alice", ARCHIVE, first.content_hash)).toBeNull();
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
          format: "atif",
          session_id: "doc",
          transcript: text,
          encoding: "json",
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

  it("never hands the reviewer the unredacted payload, only the redacted records", async () => {
    const r = reviewer(() => ({ action: "allow" }));
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    await submit(pipeline({ reviewer: r }), upload(HEAD + user(`token ${secret}`) + reply("ok")));
    expect(r.seen[0]?.envelope).toMatchObject({ session_key: "s1", source_id: "upload" });
    expect("payload" in (r.seen[0]?.envelope ?? {})).toBe(false);
    expect(JSON.stringify(r.seen)).not.toContain(secret);
  });

  it("drops a first trace: a content-free stub, no trace, a drop record says why (F3.4)", async () => {
    const health = new MemoryHealthCounters();
    const drop = reviewer(() => ({
      action: "drop",
      reason: "review_drop",
      policy: "default",
      policy_hash: "f".repeat(64),
      decision_model: "jev-1",
    }));
    const answer = await submit(pipeline({ reviewer: drop, health }), upload(HEAD));
    expect(answer).toMatchObject({ status: "dropped", bytes_total: bytes(HEAD), records_total: 3 });
    // The session's pointer only: no trace, no change entry, no review record.
    expect(objects().filter((k) => k.startsWith("owners/"))).toEqual([
      `owners/alice/sessions/${ARCHIVE}/metadata.json`,
    ]);
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

  it("keeps the stored log state when a replace is dropped, so the dropped history is never spliced on", async () => {
    // Review finding: a dropped replace moved the log state to the dropped history B while the
    // head stayed on A, so B plus a follow-up was written as a continuation of A.
    let dropNext = false;
    const r = reviewer(() =>
      dropNext
        ? {
            action: "drop",
            reason: "review_drop",
            policy: "p",
            policy_hash: "e".repeat(64),
            decision_model: "m",
          }
        : { action: "allow" },
    );
    const p = pipeline({ reviewer: r });
    const first = await submit(p, upload(HEAD));
    const before = await session();
    const other = META + user("A".repeat(2000)) + reply("old answer");
    dropNext = true;
    const dropped = await submit(p, upload(other, 0, { replace: true }));
    expect(dropped).toMatchObject({
      status: "dropped",
      records_total: first.records_total,
      prefix_sha256: first.prefix_sha256,
      bytes_total: first.bytes_total,
    });
    const after = await session();
    expect(after?.normalized).toEqual(before?.normalized);
    expect(after?.traces).toEqual(before?.traces);
    // A resend gets the same answer.
    expect(await submit(p, upload(other, 0, { replace: true }))).toEqual(dropped);
    dropNext = false;
    // The dropped history with a follow-up does not extend what is stored: a conflict, and
    // with replace it is reviewed and written as a rewrite, never spliced onto the stored one.
    const grown = other + user("follow up") + reply("more");
    await expect(submit(p, upload(grown))).rejects.toBeInstanceOf(SessionConflict);
    const rewritten = await submit(p, upload(grown, 0, { replace: true }));
    expect(rewritten.status).toBe("stored");
    const final = await session();
    expect(final?.traces).toHaveLength(1);
    expect(final?.traces[0]?.continuation).toBeUndefined();
    expect(r.seen.at(-1)?.records).toHaveLength(4);
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

describe("a dropped first envelope leaves a stub (F3.4, revised 15 Nov 2026)", () => {
  const DROP: ReviewDecision = {
    action: "drop",
    reason: "review_drop",
    policy: "p",
    policy_hash: "e".repeat(64),
    decision_model: "m",
  };
  // The dropped envelope's meta record names a directory, which is in what review dropped too.
  const FIRST =
    line({ role: "meta", source: "trajectory", cwd: "/home/alice/acme-checkout" }) +
    user(`the customer table: ${"y".repeat(2000)}`) +
    reply("listed");
  /** Drops what mentions the customer table (or everything, with `all`), allows the rest. */
  const judge = (options: { all?: boolean } = {}) =>
    reviewer((input) =>
      options.all || JSON.stringify(input.records).includes("customer table")
        ? DROP
        : { action: "allow" },
    );
  /** Every object in the bucket, as text. */
  const bucketText = () =>
    objects()
      .map((k) => readFileSync(join(dir, k)).toString("latin1"))
      .join("\n");
  const secret = "s3cret-of-this-machine";
  const retract_hash = createHash("sha256").update(secret).digest("hex");

  async function stubbed(r: ReturnType<typeof judge> = judge()) {
    const p = pipeline({ reviewer: r });
    const answer = await submit(p, upload(FIRST, 0, { retract_hash }));
    return { p, answer, r };
  }

  it("stores a stub and nothing else: who, where the log ends, its prefix hash, no head", async () => {
    const { answer } = await stubbed();
    expect(answer).toMatchObject({ status: "dropped", records_total: 3 });
    expect(answer.bytes_total).toBe(bytes(FIRST));
    expect(objects().filter((k) => k.startsWith("owners/"))).toEqual([
      `owners/alice/sessions/${ARCHIVE}/metadata.json`,
    ]);
    const stub = await session();
    expect(stub && isStub(stub)).toBe(true);
    expect(stub).toMatchObject({
      session_id: "s1",
      owner: "alice",
      format: "trajectory",
      status: "stored",
      traces: [],
      normalized: { bytes: bytes(FIRST), records: 3, prefix_sha256: answer.prefix_sha256 },
      writer: { principal: "alice", source_id: "upload" },
      retract_hash,
      applied: [expect.objectContaining({ status: "dropped", bytes_total: bytes(FIRST) })],
    });
    expect(stub?.head).toBeUndefined();
    for (const field of ["source", "project", "branch", "claims", "provenance", "redaction"]) {
      expect(stub).not.toHaveProperty(field);
    }
    expect((await readChanges(store, "alice")).entries).toEqual([]);
    expect(await listRecords(store, "dropped", "upload")).toMatchObject({ records: [{}] });
    expect(bucketText()).not.toContain("customer table");
    expect(bucketText()).not.toContain("acme-checkout");
  });

  it("reviews the next chunk alone and stores it as the session's first trace", async () => {
    const { p, answer, r } = await stubbed();
    const next = await submit(
      p,
      upload(user("now fix the build") + reply("fixed"), answer.bytes_total),
    );
    expect(next).toMatchObject({ status: "stored", records: 3, records_total: 5 });
    // Review saw the new records only, and the stub's meta record, never the dropped one's.
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1]?.records.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(r.seen[1]?.meta).toEqual({ role: "meta", source: "trajectory" });
    expect(JSON.stringify(r.seen[1])).not.toContain("customer table");
    const metadata = await session();
    expect(metadata?.head).toBe((next as { content_hash: string }).content_hash);
    expect(metadata?.traces).toEqual([
      expect.objectContaining({
        records: 3,
        continuation: { from_record: 3, prefix_sha256: answer.prefix_sha256 },
      }),
    ]);
    const trace = await getTrace(store, "alice", ARCHIVE, metadata?.head as string);
    expect(trace?.records).toEqual([
      { role: "meta", source: "trajectory" },
      expect.objectContaining({ role: "user", content: "now fix the build" }),
      expect.objectContaining({ role: "assistant", content: "fixed" }),
    ]);
    expect(trace?.metadata.continuation).toEqual({
      from_record: 3,
      prefix_sha256: answer.prefix_sha256,
    });
    // Its publish is the session's first entry on the change feed.
    const changes = (await readChanges(store, "alice")).entries.map((e) => e.entry);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "published", content_hash: metadata?.head }),
    ]);
    expect(bucketText()).not.toContain("customer table");
    expect(bucketText()).not.toContain("acme-checkout");

    // Later chunks continue the stored trace as for any session, with its meta record.
    const later = await submit(p, upload(user("and again") + reply("done"), next.bytes_total));
    expect(later).toMatchObject({ status: "stored", records_total: 7 });
    expect(r.seen[2]?.records).toHaveLength(2);
    expect((await session())?.traces[1]?.continuation?.from_record).toBe(5);
  });

  it("tells a chunk sent elsewhere than the stub's offset where the log ends", async () => {
    const { p, answer } = await stubbed();
    const err = await submit(p, upload(user("lost") + reply("x"), 7)).catch((e) => e);
    expect(err).toBeInstanceOf(OffsetMismatch);
    expect((err as OffsetMismatch).expected).toBe(answer.bytes_total);
  });

  it("never reviews or stores the dropped part again when the whole log is sent from 0", async () => {
    const { p, answer, r } = await stubbed();
    // The same log under another key (state lost, a moved transcript): nothing past the stub.
    const again = await submit(p, upload(FIRST, 0, { idempotency_key: "again" }));
    expect(again).toEqual({
      status: "unchanged",
      records_total: 3,
      prefix_sha256: answer.prefix_sha256,
      bytes_total: answer.bytes_total,
    });
    // The very same envelope again: the recorded answer.
    expect(await submit(p, upload(FIRST, 0, { retract_hash }))).toEqual(answer);
    expect(r.seen).toHaveLength(1);

    // The whole log grown (a 409, a moved transcript): only its tail is reviewed and stored.
    const grown = FIRST + user("now fix the build") + reply("fixed");
    const stored = await submit(p, upload(grown));
    expect(stored).toMatchObject({ status: "stored", records: 3, records_total: 5 });
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1]?.records).toHaveLength(2);
    expect(JSON.stringify(r.seen[1])).not.toContain("customer table");
    expect(JSON.stringify(r.seen[1])).not.toContain("acme-checkout");
    const trace = await getTrace(store, "alice", ARCHIVE, (await session())?.head as string);
    expect(trace?.records[0]).toEqual({ role: "meta", source: "trajectory" });
    expect(trace?.metadata.continuation?.from_record).toBe(3);
    expect(bucketText()).not.toContain("customer table");
    // The same trace as a chunk would have written.
    const elsewhere = mkdtempSync(join(tmpdir(), "seshi-pipeline-"));
    try {
      const chunked = new Pipeline({ store: new FsStore(elsewhere), formats, reviewer: judge() });
      const first = await submit(chunked, upload(FIRST));
      const tail = user("now fix the build") + reply("fixed");
      const viaChunk = await submit(chunked, upload(tail, first.bytes_total));
      expect((viaChunk as { content_hash: string }).content_hash).toBe(
        (stored as { content_hash: string }).content_hash,
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("moves a stub on past every drop, through the path a drop of a stored session takes", async () => {
    const { p, answer, r } = await stubbed(judge({ all: true }));
    const more = user("more of it") + reply("ok");
    const dropped = await submit(p, upload(more, answer.bytes_total));
    expect(dropped).toMatchObject({ status: "dropped", records_total: 5 });
    expect(dropped.bytes_total).toBe(bytes(FIRST) + bytes(more));
    const stub = await session();
    expect(stub?.head).toBeUndefined();
    expect(stub?.normalized?.bytes).toBe(dropped.bytes_total);
    expect(objects().filter((k) => k.startsWith("owners/"))).toHaveLength(1);
    expect(r.seen[1]?.records).toHaveLength(2);
  });

  it("is replaced by its writer past the dropped bytes, and a log that does not extend it is a conflict", async () => {
    const { p, r } = await stubbed();
    // Another history, exactly as long as the dropped envelope.
    const padded = (n: number) => META + user("A".repeat(n)) + reply("another history");
    const other = padded(2000 + bytes(FIRST) - bytes(padded(2000)));
    expect(bytes(other)).toBe(bytes(FIRST));
    await expect(submit(p, upload(other))).rejects.toBeInstanceOf(SessionConflict);
    const bob: UploadEnvelopeOptions = {
      caller: { kind: "static", principal: "bob" },
      owner_basis: "verified",
    };
    await expect(submit(p, upload(other, 0, { replace: true }, bob))).rejects.toBeInstanceOf(
      Forbidden,
    );
    // What lies in the dropped bytes is never reviewed or stored, whatever they now hold.
    const nothing = await submit(p, upload(other, 0, { replace: true }));
    expect(nothing).toMatchObject({ status: "unchanged", records_total: 3 });
    expect(r.seen).toHaveLength(1);
    expect((await session())?.head).toBeUndefined();
    const grown = other + user("past it") + reply("kept");
    const replaced = await submit(p, upload(grown, 0, { replace: true }));
    expect(replaced).toMatchObject({ status: "stored", records: 3, records_total: 5 });
    expect(r.seen.at(-1)?.records.map((x) => (x as { content?: unknown }).content)).toEqual([
      "past it",
      "kept",
    ]);
    const metadata = await session();
    expect(metadata?.traces).toHaveLength(1);
    expect(metadata?.traces[0]?.continuation?.from_record).toBe(3);
  });

  it("can be tombstoned, after which nothing extends it, and keeps a visibility change", async () => {
    const { p, answer } = await stubbed();
    const changed = await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s1",
      visibility: "owner",
    });
    expect(changed).toMatchObject({ visibility: "owner" });
    expect(changed?.head).toBeUndefined();
    await submit(p, upload(user("now fix the build") + reply("fixed"), answer.bytes_total));
    expect(await session()).toMatchObject({ visibility: "owner", head: expect.any(String) });

    const other = archiveId("alice", "trajectory", "s2");
    await submit(p, upload(FIRST, 0, { session_id: "s2" }));
    expect(
      await tombstone({ store, owner: "alice", format: "trajectory", session_id: "s2" }),
    ).toEqual({ removed: 0 });
    const gone = await readMetadata(store, "alice", other);
    expect(gone).toMatchObject({ status: "redacted", traces: [] });
    expect(gone).not.toHaveProperty("normalized");
    await expect(
      submit(p, upload(user("x") + reply("y"), bytes(FIRST), { session_id: "s2" })),
    ).rejects.toMatchObject({ code: "redacted" });
    await expect(submit(p, upload(FIRST, 0, { session_id: "s2" }))).rejects.toMatchObject({
      code: "redacted",
    });
  });

  it("is neither listed nor served by the session API until it has a trace", async () => {
    const r = judge();
    const db = new StoreSessionDB({
      store,
      owner: "alice",
      formats,
      pipeline: pipeline({ reviewer: r }),
    });
    const answer = await db.ingest({ format: "trajectory", session_id: "s1", transcript: FIRST });
    expect(answer.status).toBe("dropped");
    expect(await db.getSession("trajectory", "s1")).toBeNull();
    expect(await db.getTrace("trajectory", "s1")).toBeNull();
    expect((await db.listSessions()).sessions).toEqual([]);
    await db.ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: user("now fix the build") + reply("fixed"),
      offset: answer.bytes_total,
    });
    expect(await db.getSession("trajectory", "s1")).toMatchObject({ head: expect.any(String) });
    expect((await db.listSessions()).sessions).toHaveLength(1);
  });

  describe("written whole again later: a rebuild, a replace, an assembly (21 meets 20)", () => {
    const tail = user("now fix the build") + reply("fixed");
    const allowAll = () => reviewer(() => ({ action: "allow" }));
    const contents = (input: ReviewInput | undefined) =>
      input?.records.map((x) => (x as { content?: unknown }).content);
    /** The stored head trace, as text. */
    const headText = async (owner = "alice", archive = ARCHIVE) => {
      const metadata = await readMetadata(store, owner, archive);
      return JSON.stringify(await getTrace(store, owner, archive, metadata?.head as string));
    };
    const DROPPED_TEXT = ["customer table", "acme-checkout", '"listed"'];
    const expectNone = (text: string) => {
      for (const dropped of DROPPED_TEXT) expect(text).not.toContain(dropped);
    };

    /** A stub, then its first trace from the next chunk. */
    async function begunAsStub(options: Partial<PipelineOptions> = {}) {
      const p = pipeline({ reviewer: judge(), ...options });
      const answer = await submit(p, upload(FIRST, 0, { retract_hash }));
      const next = await submit(p, upload(tail, answer.bytes_total));
      expect(next.status).toBe("stored");
      return { p, answer, next };
    }

    it("never reviews or stores the dropped part on a rebuild, with a trace or without", async () => {
      const { answer, next } = await begunAsStub();
      expect((await session())?.dropped_prefix).toEqual({
        bytes: bytes(FIRST),
        records: 3,
        prefix_sha256: answer.prefix_sha256,
      });
      // Whatever review would say of it now, the dropped part is not sent to it.
      const allow = allowAll();
      const rebuilt = await submit(
        pipeline({ reviewer: allow }),
        upload(FIRST + tail, 0, { rebuild: true }),
      );
      // Rebuilt and reviewed again: the trace the chunk wrote.
      expect(rebuilt).toMatchObject({ status: "duplicate", records_total: 5 });
      expect((rebuilt as { content_hash: string }).content_hash).toBe(
        (next as { content_hash: string }).content_hash,
      );
      expect(allow.seen).toHaveLength(1);
      expect(contents(allow.seen[0])).toEqual(["now fix the build", "fixed"]);
      expect(allow.seen[0]?.meta).toEqual({ role: "meta", source: "trajectory" });
      expectNone(JSON.stringify(allow.seen));
      expectNone(await headText());
      expect((await session())?.traces).toEqual([
        expect.objectContaining({
          continuation: { from_record: 3, prefix_sha256: answer.prefix_sha256 },
        }),
      ]);

      // A stub with no trace yet: a rebuild of only what was dropped stores and reviews nothing;
      // one that grew is the session's first trace, reviewed and stored past the dropped part.
      const s2 = archiveId("alice", "trajectory", "s2");
      await submit(pipeline({ reviewer: judge() }), upload(FIRST, 0, { session_id: "s2" }));
      const later = allowAll();
      const q = pipeline({ reviewer: later });
      expect(await submit(q, upload(FIRST, 0, { session_id: "s2", rebuild: true }))).toMatchObject({
        status: "unchanged",
        records_total: 3,
      });
      expect(later.seen).toHaveLength(0);
      expect((await readMetadata(store, "alice", s2))?.head).toBeUndefined();
      const first = await submit(q, upload(FIRST + tail, 0, { session_id: "s2", rebuild: true }));
      expect(first).toMatchObject({ status: "stored", records: 3, records_total: 5 });
      expect(contents(later.seen[0])).toEqual(["now fix the build", "fixed"]);
      expectNone(JSON.stringify(later.seen));
      expectNone(await headText("alice", s2));
      expect((await readMetadata(store, "alice", s2))?.traces[0]?.continuation?.from_record).toBe(
        3,
      );
      // A stub has no trace to replace: its first trace is published as any first trace is.
      const entries = (await readChanges(store, "alice")).entries.map((e) => e.entry);
      expect(entries.at(-1)).toMatchObject({ kind: "published", archive_id: s2 });
      expect(entries.at(-1)).not.toHaveProperty("replace");
    });

    it("leaves a stub with a trace as it is when a replace holds nothing past the dropped part", async () => {
      // Found by the scenario explorer (33): the transcript was compacted shorter than what
      // review dropped; the replace recorded that log's position while the chunk's trace stayed,
      // so `normalized` fell behind the traces.
      const { next } = await begunAsStub();
      const before = await session();
      const shorter = FIRST.split("\n").slice(0, 2).join("\n").concat("\n");
      const answer = await submit(
        pipeline({ reviewer: allowAll() }),
        upload(shorter, 0, { replace: true }),
      );
      // Answered as a dropped replace, with what is stored: the uploader replaces it again once
      // the log grows past the dropped part.
      expect(answer).toMatchObject({
        status: "dropped",
        records_total: next.records_total,
        bytes_total: next.bytes_total,
      });
      expect(await session()).toEqual(before);
    });

    it("finds the dropped part by its bytes once the adapter changed, and rebuilds past it", async () => {
      const v1 = new FormatRegistry([
        ATIF_FORMAT,
        { ...TRAJECTORY_FORMAT, version: "1" },
        otlpGenAiFormat(),
      ]);
      // Version 2 acknowledges every user record with a record of its own, so the dropped part
      // now normalizes to four records: by its old count, its last one would be reviewed again.
      const acknowledging: FormatAdapter = {
        ...TRAJECTORY_FORMAT,
        version: "2",
        normalize: (text, chunk) =>
          (TRAJECTORY_FORMAT.normalize(text, chunk) as NormalizedRecord[]).flatMap((rec) =>
            rec.role === "user"
              ? [rec, { role: "assistant", content: "(read)", timestamp: ts } as NormalizedRecord]
              : [rec],
          ),
      };
      const v2 = new FormatRegistry([ATIF_FORMAT, acknowledging, otlpGenAiFormat()]);
      await begunAsStub({ formats: v1 });
      const allow = allowAll();
      const rebuilt = await submit(
        pipeline({ reviewer: allow, formats: v2 }),
        upload(FIRST + tail, 0, { rebuild: true }),
      );
      expect(rebuilt).toMatchObject({ status: "stored", records: 4, records_total: 7 });
      expect(allow.seen).toHaveLength(1);
      expect(contents(allow.seen[0])).toEqual(["now fix the build", "(read)", "fixed"]);
      expectNone(JSON.stringify(allow.seen));
      expectNone(await headText());
      const metadata = await session();
      expect(metadata?.traces).toEqual([
        expect.objectContaining({ continuation: expect.objectContaining({ from_record: 4 }) }),
      ]);
      expect(metadata?.dropped_prefix).toMatchObject({ bytes: bytes(FIRST), records: 4 });
      expect(metadata?.normalizer?.format_version).toBe("2");
    });

    it("takes the dropped records while they still hash as dropped, before the dropped bytes", async () => {
      const v1 = new FormatRegistry([
        ATIF_FORMAT,
        { ...TRAJECTORY_FORMAT, version: "1" },
        otlpGenAiFormat(),
      ]);
      // Version 2 acknowledges every answer with a record of its own: the dropped part's first
      // three records are as they were, and its bytes now make four.
      const acknowledging: FormatAdapter = {
        ...TRAJECTORY_FORMAT,
        version: "2",
        normalize: (text, chunk) =>
          (TRAJECTORY_FORMAT.normalize(text, chunk) as NormalizedRecord[]).flatMap((rec) =>
            rec.role === "assistant"
              ? [rec, { role: "user", content: "(ack)", timestamp: ts } as NormalizedRecord]
              : [rec],
          ),
      };
      const v2 = new FormatRegistry([ATIF_FORMAT, acknowledging, otlpGenAiFormat()]);
      const { answer } = await begunAsStub({ formats: v1 });
      const allow = allowAll();
      const rebuilt = await submit(
        pipeline({ reviewer: allow, formats: v2 }),
        upload(FIRST + tail, 0, { rebuild: true }),
      );
      expect(rebuilt).toMatchObject({ status: "stored", records: 5, records_total: 7 });
      expect(contents(allow.seen[0])).toEqual(["(ack)", "now fix the build", "fixed", "(ack)"]);
      expectNone(JSON.stringify(allow.seen));
      const metadata = await session();
      expect(metadata?.traces[0]?.continuation).toEqual({
        from_record: 3,
        prefix_sha256: answer.prefix_sha256,
      });
      expect(metadata?.dropped_prefix).toEqual({
        bytes: bytes(FIRST),
        records: 3,
        prefix_sha256: answer.prefix_sha256,
      });
    });

    it("leaves the dropped part out of a replace after the rules changed", async () => {
      const { answer } = await begunAsStub();
      // A rule that matches the dropped text: its records no longer hash to what was dropped.
      const allow = allowAll();
      const strict = pipeline({
        reviewer: allow,
        redaction: redactionRules({ patterns: ["customer"] }),
      });
      await expect(submit(strict, upload(FIRST + tail))).rejects.toBeInstanceOf(SessionConflict);
      const replaced = await submit(strict, upload(FIRST + tail, 0, { replace: true }));
      expect(replaced).toMatchObject({ status: "stored", records: 3, records_total: 5 });
      expect(allow.seen).toHaveLength(1);
      expect(contents(allow.seen[0])).toEqual(["now fix the build", "fixed"]);
      expectNone(JSON.stringify(allow.seen));
      expectNone(await headText());
      const metadata = await session();
      expect(metadata?.traces).toHaveLength(1);
      const from = metadata?.traces[0]?.continuation;
      expect(from?.from_record).toBe(3);
      expect(from?.prefix_sha256).not.toBe(answer.prefix_sha256);
      expect(metadata?.dropped_prefix).toEqual({
        bytes: bytes(FIRST),
        records: 3,
        prefix_sha256: from?.prefix_sha256,
      });
    });

    it("leaves the dropped part out when a late span makes the assembler replace the session", async () => {
      const envelope: Envelope = {
        ...upload(HEAD),
        source: "otlp",
        source_id: "console",
        format: "otlp-genai",
        session_key: "sesn_1",
        caller: { kind: "service", principal: "svc-console" },
        owner: "svc-console",
        owner_basis: "service",
        payload: {
          kind: "spans",
          spans: [
            {
              traceId: "ab".repeat(16),
              spanId: "cd".repeat(8),
              name: "chat",
              startTimeUnixNano: "1790000000000000000",
            },
          ],
        },
        idempotency_key: "ab/cd",
      };
      const records = (text: string) =>
        formats.normalize({ source: "trajectory", transcript: text }).records;
      const archive = archiveId("svc-console", "otlp-genai", "sesn_1");
      const p = pipeline({ reviewer: judge() });
      expect(await p.publishAssembled({ envelope, records: records(FIRST) })).toMatchObject({
        status: "dropped",
      });
      expect((await readMetadata(store, "svc-console", archive))?.dropped_prefix).toMatchObject({
        bytes: 0,
        records: 3,
      });
      expect(await p.publishAssembled({ envelope, records: records(FIRST + tail) })).toMatchObject({
        status: "stored",
        records: 3,
      });

      // A span that arrived late lands inside what was stored: the assembly no longer extends
      // the trace, so the assembler replaces the session.
      const late = FIRST + user("now fix the build") + reply("a late span") + reply("fixed");
      const allow = allowAll();
      const replaced = await pipeline({ reviewer: allow }).publishAssembled({
        envelope,
        records: records(late),
      });
      expect(replaced).toMatchObject({ status: "stored", records: 4, records_total: 6 });
      expect(contents(allow.seen[0])).toEqual(["now fix the build", "a late span", "fixed"]);
      expectNone(JSON.stringify(allow.seen));
      expectNone(await headText("svc-console", archive));
      const metadata = await readMetadata(store, "svc-console", archive);
      expect(metadata?.traces).toEqual([
        expect.objectContaining({ continuation: expect.objectContaining({ from_record: 3 }) }),
      ]);
      const entries = (await readChanges(store, "svc-console")).entries.map((e) => e.entry);
      expect(entries.at(-1)).toMatchObject({ kind: "published", replace: true });
    });

    it("leaves the dropped count out of an assembled session that no longer hashes as dropped", async () => {
      const envelope: Envelope = {
        ...upload(HEAD),
        source: "otlp",
        source_id: "console",
        format: "otlp-genai",
        session_key: "sesn_2",
        caller: { kind: "service", principal: "svc-console" },
        owner: "svc-console",
        owner_basis: "service",
        payload: { kind: "spans", spans: [] },
        idempotency_key: "ab/cd",
      };
      const records = (text: string) =>
        formats.normalize({ source: "trajectory", transcript: text }).records;
      const archive = archiveId("svc-console", "otlp-genai", "sesn_2");
      const p = pipeline({ reviewer: judge() });
      await p.publishAssembled({ envelope, records: records(FIRST) });
      expect((await readMetadata(store, "svc-console", archive))?.dropped_prefix).toMatchObject({
        bytes: 0,
        records: 3,
      });
      await p.publishAssembled({ envelope, records: records(FIRST + tail) });
      // A rule that matches the dropped text, and a late span: the assembly is written again,
      // its first three records no longer hash as dropped, and there are no bytes to cut at.
      const allow = allowAll();
      const strict = pipeline({
        reviewer: allow,
        redaction: redactionRules({ patterns: ["customer"] }),
      });
      const late = FIRST + user("now fix the build") + reply("a late span") + reply("fixed");
      const replaced = await strict.publishAssembled({ envelope, records: records(late) });
      expect(replaced).toMatchObject({ status: "stored", records: 4, records_total: 6 });
      expect(contents(allow.seen[0])).toEqual(["now fix the build", "a late span", "fixed"]);
      expectNone(JSON.stringify(allow.seen));
      expectNone(await headText("svc-console", archive));
      const metadata = await readMetadata(store, "svc-console", archive);
      expect(metadata?.traces[0]?.continuation?.from_record).toBe(3);
      expect(metadata?.dropped_prefix).toMatchObject({ bytes: 0, records: 3 });
    });

    it("finds the dropped part of a stub stored before dropped_prefix existed by its log state", async () => {
      await submit(pipeline({ reviewer: judge() }), upload(FIRST, 0, { retract_hash }));
      await updateMetadata(store, "alice", ARCHIVE, (m) => {
        if (!m) return null;
        const { dropped_prefix: _d, ...rest } = m;
        return rest;
      });
      expect(await session()).not.toHaveProperty("dropped_prefix");
      const allow = allowAll();
      const rebuilt = await submit(
        pipeline({ reviewer: allow }),
        upload(FIRST + tail, 0, { rebuild: true }),
      );
      expect(rebuilt).toMatchObject({ status: "stored", records: 3, records_total: 5 });
      expect(contents(allow.seen[0])).toEqual(["now fix the build", "fixed"]);
      expectNone(JSON.stringify(allow.seen));
      expectNone(await headText());
      expect((await session())?.traces[0]?.continuation?.from_record).toBe(3);
    });

    it("keeps where the dropped part ends through later chunks, drops, replaces and rebuilds", async () => {
      const { p, answer, next } = await begunAsStub();
      const kept = { bytes: bytes(FIRST), records: 3, prefix_sha256: answer.prefix_sha256 };
      const more = await submit(p, upload(user("more") + reply("again"), next.bytes_total));
      expect(more.status).toBe("stored");
      expect((await session())?.dropped_prefix).toEqual(kept);
      const dropped = await submit(
        p,
        upload(user("the customer table again") + reply("ok"), more.bytes_total),
      );
      expect(dropped.status).toBe("dropped");
      expect((await session())?.dropped_prefix).toEqual(kept);
      // A replace with another history past the dropped part.
      const other = FIRST + user("another way") + reply("done");
      const replaced = await submit(p, upload(other, 0, { replace: true }));
      expect(replaced).toMatchObject({ status: "stored", records: 3, records_total: 5 });
      expect((await session())?.dropped_prefix).toEqual(kept);
      expect((await session())?.traces).toHaveLength(1);
      // A rebuild of it builds the same trace again.
      expect((await submit(p, upload(other, 0, { rebuild: true }))).status).toBe("duplicate");
      expect((await session())?.dropped_prefix).toEqual(kept);
      // Nothing of the session is left once it is tombstoned.
      await tombstone({ store, owner: "alice", format: "trajectory", session_id: "s1" });
      expect(await session()).not.toHaveProperty("dropped_prefix");
    });

    it("rebuilds a session that never was a stub whole, as before", async () => {
      const allow = allowAll();
      const p = pipeline({ reviewer: allow });
      await submit(p, upload(HEAD));
      expect((await submit(p, upload(HEAD + tail))).status).toBe("stored");
      const rebuilt = await submit(p, upload(HEAD + tail, 0, { rebuild: true }));
      expect(rebuilt).toMatchObject({ status: "stored", records: 5, records_total: 5 });
      expect(allow.seen.at(-1)?.records).toHaveLength(4);
      const metadata = await session();
      expect(metadata).not.toHaveProperty("dropped_prefix");
      expect(metadata?.traces).toHaveLength(1);
      expect(metadata?.traces[0]?.continuation).toBeUndefined();
    });
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
    // An adapter's message that quotes the data is kept without the quote.
    const quoted = await p.submit(
      s3({ ...upload(line({ role: "hunter2-secret", content: "x" })), format: "trajectory" }),
    );
    expect(quoted).toMatchObject({ status: "failed", message: expect.stringContaining('"…"') });
    expect(JSON.stringify(await listRecords(store, "failed", "logs-bucket"))).not.toContain(
      "hunter2",
    );
    expect(health.counts).toEqual({ "logs-bucket": { failed: 2 } });
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
    // An idempotency key is kept in metadata.json, so it is bounded.
    await expect(
      pipeline().submit({ ...upload(HEAD), idempotency_key: "k".repeat(2049) }),
    ).rejects.toMatchObject({ code: "bad_envelope" });
    expect(objects()).toEqual([]);
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
    format: "otlp-genai",
    session_key: "sesn_1",
    caller: { kind: "service", principal: "svc-console" },
    owner: "svc-console",
    owner_basis: "service",
    payload: {
      kind: "spans",
      spans: [
        {
          traceId: "ab".repeat(16),
          spanId: "cd".repeat(8),
          name: "chat",
          startTimeUnixNano: "1790000000000000000",
        },
      ],
    },
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
          spans: batch.parts.length,
        };
      },
    };
    const p = pipeline({ assembler });
    const archive = archiveId("svc-console", "otlp-genai", "sesn_1");
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

  it("redacts what an assembled session's LLM calls say, and counts it (F2)", async () => {
    const acme = validatePack(
      { id: "acme", rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }] },
      { source: "acme.toml" },
    );
    const p = pipeline({ redaction: compileRuleSet({ packs: [acme] }) });
    const records = formats.normalize({ source: "trajectory", transcript: HEAD }).records;
    const last = records.at(-1) as unknown as Record<string, unknown>;
    last.llm_call = "c1";
    const stored = await p.publishAssembled({
      envelope: spans(),
      records,
      llm_calls: [
        {
          id: "c1",
          model: "m",
          error: "401: key ACME-1234 revoked",
          parameters: { user: "ACME-5678", temperature: 0 },
        },
      ],
    });
    expect(stored.status).toBe("stored");
    const archive = archiveId("svc-console", "otlp-genai", "sesn_1");
    const metadata = await readMetadata(store, "svc-console", archive);
    expect(metadata?.redaction?.counts).toEqual({ "acme-key": 2 });
    const trace = await getTrace(store, "svc-console", archive, metadata?.head as string);
    expect(JSON.stringify(trace)).not.toContain("ACME-");
    expect(trace?.llm_calls).toEqual([
      {
        id: "c1",
        model: "m",
        error: "401: key [redacted:acme-key] revoked",
        parameters: { user: "[redacted:acme-key]", temperature: 0 },
      },
    ]);
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

describe("identity and visibility (X5)", () => {
  const other = META + user("y".repeat(2000)) + reply("else");
  const device: UploadEnvelopeOptions = {
    caller: { kind: "device", principal: "alice", credential_id: "t1" },
    owner_basis: "verified",
  };
  const orgKey: UploadEnvelopeOptions = {
    caller: { kind: "person", principal: "alice", credential_id: "org" },
    owner_basis: "claimed",
  };

  it("never lets a claimed caller replace a session whose owner was verified (X5.3, X4.6)", async () => {
    const p = pipeline();
    await submit(p, upload(HEAD, 0, {}, device));
    await expect(submit(p, upload(other, 0, { replace: true }, orgKey))).rejects.toBeInstanceOf(
      Forbidden,
    );
    expect((await session())?.head).toBeDefined();
  });

  it("never lets a claimed caller add to a session whose owner was verified (X5.12)", async () => {
    const p = pipeline();
    await submit(p, upload(HEAD, 0, {}, device));
    const longer = HEAD + user("more") + reply("yes");
    await expect(submit(p, upload(longer, 0, {}, orgKey))).rejects.toBeInstanceOf(Forbidden);
    expect((await session())?.traces).toHaveLength(1);
    // The person's own token goes on adding to it.
    expect((await submit(p, upload(longer, 0, {}, device))).status).toBe("stored");
  });

  it("lets an org-key caller replace a session the org key wrote only with its retraction secret (X5.12)", async () => {
    const p = pipeline();
    const secret = "machine-secret";
    const retract_hash = createHash("sha256").update(secret).digest("hex");
    await submit(p, upload(HEAD, 0, { retract_hash }, orgKey));
    const head = (await session())?.head;
    // Anyone holding the key can state "alice": the name alone is not the original writer.
    await expect(submit(p, upload(other, 0, { replace: true }, orgKey))).rejects.toBeInstanceOf(
      Forbidden,
    );
    await expect(
      p.submit(upload(other, 0, { replace: true }, orgKey), {
        onFailure: "throw",
        retractSecret: "wrong",
      }),
    ).rejects.toBeInstanceOf(Forbidden);
    expect((await session())?.head).toBe(head);
    const replaced = (await p.submit(upload(other, 0, { replace: true }, orgKey), {
      onFailure: "throw",
      retractSecret: secret,
    })) as StoreSessionResult;
    expect(replaced.status).toBe("stored");
    expect((await session())?.owner_basis).toBe("claimed");
    expect((await session())?.retract_hash).toBe(retract_hash);
  });

  it("gives a new session the request's visibility, else the source's setting (X5.10)", async () => {
    const seen: string[] = [];
    const p = pipeline({
      visibility: (sourceId) => {
        seen.push(sourceId);
        return "owner";
      },
    });
    await submit(p, upload(HEAD));
    expect((await session())?.visibility).toBe("owner");
    expect(seen).toEqual(["upload"]);
    await submit(p, upload(HEAD, 0, { session_id: "s2", visibility: "org" }));
    expect(
      (await readMetadata(store, "alice", archiveId("alice", "trajectory", "s2")))?.visibility,
    ).toBe("org");
    // An existing session keeps its own.
    await submit(p, upload(HEAD + user("more") + reply("yes"), 0, { visibility: "org" }));
    expect((await session())?.visibility).toBe("owner");
    expect((await pipeline().submit(upload(HEAD, 0, { session_id: "s3" }))).status).toBe("stored");
    expect(
      (await readMetadata(store, "alice", archiveId("alice", "trajectory", "s3")))?.visibility,
    ).toBe("org");
  });

  it("records the owner basis on change entries (X5.5)", async () => {
    await submit(pipeline(), upload(HEAD, 0, {}, orgKey));
    const { entries } = await readChanges(store, "alice");
    expect(entries.map((e) => e.entry.owner_basis)).toEqual(["claimed"]);
    expect(entries[0]?.entry.writer).toEqual({
      kind: "person",
      principal: "alice",
      credential_id: "org",
      source_id: "upload",
    });
  });
});

describe("stale sessions and rebuilds (X4.9)", () => {
  /** The same formats, with the trajectory adapter at `version`. */
  const at = (version: string) =>
    new FormatRegistry([ATIF_FORMAT, { ...TRAJECTORY_FORMAT, version }, otlpGenAiFormat()]);
  const stale = (registry: FormatRegistry) => staleSessions(store, "alice", registry);

  it("records the format version that built a session, and lists it stale once the adapter is newer", async () => {
    await submit(pipeline({ formats: at("1") }), upload(HEAD));
    expect((await session())?.normalizer).toMatchObject({
      name: "@dosu/sessiondb",
      format_version: "1",
    });
    expect((await stale(at("1"))).sessions).toEqual([]);
    expect((await stale(at("1.0.1"))).sessions).toEqual([
      { format: "trajectory", session_id: "s1", built_with: "1", current: "1.0.1" },
    ]);
    // An older server is not newer: nothing to rebuild there.
    expect((await stale(at("0.9"))).sessions).toEqual([]);
  });

  it("keeps the oldest version through a chunk; a rebuild makes the session current", async () => {
    await submit(pipeline({ formats: at("1") }), upload(HEAD));
    const tail = user("more") + reply("again");
    const newer = pipeline({ formats: at("2") });
    expect((await submit(newer, upload(tail, bytes(HEAD)))).status).toBe("stored");
    // The tail is the new adapter's, the prefix still the old one's.
    expect((await session())?.normalizer?.format_version).toBe("1");
    expect((await stale(at("2"))).sessions).toHaveLength(1);

    const rebuilt = await submit(newer, upload(HEAD + tail, 0, { rebuild: true }));
    expect(rebuilt).toMatchObject({ status: "stored", records_total: 5 });
    expect((await session())?.normalizer?.format_version).toBe("2");
    expect((await stale(at("2"))).sessions).toEqual([]);
  });

  it("counts a session with no recorded version as stale", async () => {
    await submit(pipeline(), upload(HEAD));
    const { normalizer: _gone, ...older } = (await session()) as NonNullable<
      Awaited<ReturnType<typeof session>>
    >;
    await store.put(
      keys.metadata("alice", ARCHIVE),
      new TextEncoder().encode(JSON.stringify(older)),
    );
    expect((await stale(formats)).sessions).toEqual([
      { format: "trajectory", session_id: "s1", current: "1" },
    ]);
  });

  it("rebuilds and reviews again a log that only repeats what is stored, instead of `unchanged`", async () => {
    // Review failed and the policy skipped it: written with regex redaction only (F3.4).
    let decide: (input: ReviewInput) => ReviewDecision = () => ({ action: "skipped" });
    const r = reviewer((input) => decide(input));
    const p = pipeline({ reviewer: r });
    const first = await submit(p, upload(HEAD));
    expect(first.status).toBe("stored");
    expect(r.seen).toHaveLength(1);
    // The same log again, as it would come without a rebuild.
    expect((await submit(p, upload(HEAD, 0, { idempotency_key: "again" }))).status).toBe(
      "unchanged",
    );
    expect(r.seen).toHaveLength(1);

    // The provider is back: a rebuild reviews every record again, not only a tail.
    decide = (input) => ({
      action: "redact",
      records: input.records.map((rec) =>
        rec.role === "user" ? { ...rec, content: "[redacted:review]" } : rec,
      ),
    });
    const rebuilt = await submit(p, upload(HEAD, 0, { rebuild: true }));
    expect(rebuilt).toMatchObject({ status: "stored", records_total: 3 });
    expect(rebuilt.status === "stored" && rebuilt.content_hash).not.toBe(
      first.status === "stored" && first.content_hash,
    );
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1]?.records).toHaveLength(2);
    const { entries } = await readChanges(store, "alice");
    expect(entries.at(-1)?.entry).toMatchObject({ kind: "published", replace: true });
    expect((await session())?.traces).toHaveLength(1);
    const head = await getTrace(store, "alice", ARCHIVE, (await session())?.head as string);
    expect(JSON.stringify(head?.records)).not.toContain("x".repeat(2000));

    // Each rebuild without a key of its own gets a fresh one: never answered from the last. The
    // same review again builds the same trace, which is already there.
    expect((await submit(p, upload(HEAD, 0, { rebuild: true }))).status).toBe("duplicate");
    expect(r.seen).toHaveLength(3);
    // With a key, a resend of the same rebuild is answered once.
    await submit(p, upload(HEAD, 0, { rebuild: true, idempotency_key: "rebuild-1" }));
    await submit(p, upload(HEAD, 0, { rebuild: true, idempotency_key: "rebuild-1" }));
    expect(r.seen).toHaveLength(4);
  });

  it("reviews a dropped envelope again with a rebuild", async () => {
    let drop = false;
    const r = reviewer(() =>
      drop
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
    await submit(p, upload(HEAD));
    drop = true;
    const tail = user("secret plans") + reply("noted");
    expect((await submit(p, upload(tail, bytes(HEAD)))).status).toBe("dropped");
    // The log moved past the dropped chunk: the whole log only extends what is stored.
    expect((await submit(p, upload(HEAD + tail, 0, { idempotency_key: "k" }))).status).toBe(
      "unchanged",
    );
    drop = false;
    const rebuilt = await submit(p, upload(HEAD + tail, 0, { rebuild: true }));
    expect(rebuilt).toMatchObject({ status: "stored", records: 5 });
    expect(r.seen.at(-1)?.records).toHaveLength(4);
  });

  it("needs the permission a replace needs, and is never a chunk", async () => {
    const p = pipeline();
    await submit(p, upload(HEAD));
    const bob: UploadEnvelopeOptions = {
      caller: { kind: "static", principal: "bob" },
      owner_basis: "verified",
    };
    await expect(submit(p, upload(HEAD, 0, { rebuild: true }, bob))).rejects.toThrow(
      "only the session's original writer or an admin may rebuild it",
    );
    await expect(submit(p, upload(HEAD, 0, { rebuild: true }, bob))).rejects.toBeInstanceOf(
      Forbidden,
    );
    const admin: UploadEnvelopeOptions = {
      caller: { kind: "admin", principal: "root" },
      owner_basis: "verified",
    };
    // The same log builds the same trace: rebuilt, reviewed, and already there.
    expect((await submit(p, upload(HEAD, 0, { rebuild: true }, admin))).status).toBe("duplicate");
    await expect(
      submit(p, upload(user("more"), bytes(HEAD), { rebuild: true })),
    ).rejects.toMatchObject({ code: "bad_chunk" });
  });

  it("is a first upload, filter and all, for a session the server holds nothing of", async () => {
    const tiny = META + user("hi") + reply("hello");
    expect((await submit(pipeline(), upload(tiny, 0, { rebuild: true }))).status).toBe("filtered");
    expect((await submit(pipeline(), upload(HEAD, 0, { rebuild: true }))).status).toBe("stored");
  });
});
