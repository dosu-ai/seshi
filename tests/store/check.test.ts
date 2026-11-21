/** The store checker (31) on both stores: the folder store (ages are file mtimes) and an S3 store
 * over the in-memory S3 fake served through `fetch` (ages are the listing's `LastModified`). A
 * healthy bucket is built through the real pipeline (a publish and its chunk, a visibility
 * change, a tombstone, a stub and a stub continued, an assembled OTLP session whose spans share
 * stored messages) and checks clean; each other test corrupts exactly one thing and expects
 * the finding that names it. Crosses store, pipeline, formats and the S3 fake, so it lives in
 * tests/ (X3.6). */

import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry, otlpGenAiFormat } from "@seshi/formats";
import {
  ENVELOPE_SCHEMA,
  type Envelope,
  type SessionMetadata,
  type StoreSessionResult,
} from "@seshi/model";
import {
  assemblePending,
  Pipeline,
  type ReviewDecision,
  type Reviewer,
  SpanStore,
  setVisibility,
  tombstone,
  uploadEnvelope,
} from "@seshi/pipeline";
import { FakeS3 } from "@seshi/sources/testing";
import {
  appendChange,
  archiveId,
  type CheckReport,
  checkStore,
  createToken,
  FINDINGS,
  type FindingCode,
  FsStore,
  getBytes,
  gzipJsonDeterministic,
  keys,
  LAYOUT_KEY,
  listSpanMessages,
  readChanges,
  readMetadata,
  S3Store,
  type Store,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOUR = 60 * 60 * 1000;
const ts = "2026-09-01T00:00:00Z";
const encoder = new TextEncoder();
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const meta = () => line({ role: "meta", source: "trajectory" });
/** Long enough that the session filter keeps it. */
const user = (content: string) =>
  line({ role: "user", content: `${content} ${"x".repeat(2000)}`, timestamp: ts });
const reply = (content: string) => line({ role: "assistant", content, timestamp: ts });

const formats = new FormatRegistry([...BUILTIN_FORMATS, otlpGenAiFormat()]);
const DROP: ReviewDecision = {
  action: "drop",
  reason: "review_drop",
  policy: "p",
  policy_hash: "e".repeat(64),
  decision_model: "m",
};
/** Drops whatever mentions the customer table; allows the rest. */
const reviewer: Reviewer = {
  review: async (input) =>
    JSON.stringify(input.records).includes("customer table") ? DROP : { action: "allow" },
};

/** A store, a way to make one of its objects look `ms` old, and what it was asked to write. */
interface Backend {
  store: Store;
  age(key: string, ms: number): void;
  close(): void;
}

function folder(): Backend {
  const dir = mkdtempSync(join(tmpdir(), "seshi-check-"));
  return {
    store: new FsStore(dir),
    age(key, ms) {
      const at = new Date(Date.now() - ms);
      utimesSync(join(dir, ...key.split("/")), at, at);
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function bucket(): Backend {
  const fake = new FakeS3({ bucket: "seshi", accessKeyId: "AKID", writable: true });
  return {
    store: new S3Store({
      bucket: "seshi",
      prefix: "org",
      endpoint: "http://s3.test",
      credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
      fetch: fake.fetch,
    }),
    age(key, ms) {
      const object = fake.objects.get(`org/${key}`);
      if (!object) throw new Error(`no object ${key}`);
      object.modified = new Date(Date.now() - ms);
    },
    close: () => {},
  };
}

/** `store`, recording every write or delete asked of it, which a read-only check never makes. */
function watched(store: Store): { store: Store; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    store: {
      url: store.url,
      get: (key) => store.get(key),
      stat: (key) => store.stat(key),
      list: (prefix, options) => store.list(prefix, options),
      put: async (key, body, options) => {
        writes.push(`put ${key}`);
        return store.put(key, body, options);
      },
      delete: async (key, options) => {
        writes.push(`delete ${key}`);
        return store.delete(key, options);
      },
    },
  };
}

/** Every finding of a report. A healthy bucket below has none. */
const unexpected = (report: CheckReport) => report.findings;
const codes = (report: CheckReport) =>
  unexpected(report)
    .map((f) => f.code)
    .sort();

// The OTLP session: two chat spans, the second repeating the first's input, so a message is
// stored once and named twice.
const SVC = "svc:console";
const OTLP_SESSION = "sesn_1";
const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (sec: number) =>
  (BigInt(Date.parse("2026-11-01T10:00:00Z") + sec * 1000) * 1_000_000n).toString();
const messages = (...turns: Array<[string, string]>) =>
  JSON.stringify(turns.map(([role, text]) => ({ role, parts: [{ type: "text", content: text }] })));
function chat(n: number, input: Array<[string, string]>, output: string) {
  return {
    traceId: "ab".repeat(16),
    spanId: n.toString(16).padStart(16, "0"),
    name: "chat m",
    startTimeUnixNano: nanos(n * 10),
    endTimeUnixNano: nanos(n * 10 + 5),
    attributes: [
      s("gen_ai.operation.name", "chat"),
      s("gen_ai.conversation.id", "conv"),
      s("gen_ai.input.messages", messages(...input)),
      s("gen_ai.output.messages", messages(["assistant", output])),
    ],
  };
}
function spans(n: number, list: unknown[]): Envelope {
  return {
    schema: ENVELOPE_SCHEMA,
    source: "otlp",
    source_id: "console",
    format: "otlp-genai",
    session_key: OTLP_SESSION,
    payload: { kind: "spans", spans: list as Record<string, unknown>[] },
    caller: { kind: "service", principal: SVC, credential_id: "tok1" },
    owner: SVC,
    owner_basis: "service",
    idempotency_key: `batch-${n}`,
    received_at: new Date().toISOString(),
  };
}

describe.each([
  ["the folder store", folder],
  ["an S3 store", bucket],
])("checkStore on %s (31)", (_name, make) => {
  let backend: Backend;
  let store: Store;
  beforeEach(() => {
    backend = make();
    store = backend.store;
  });
  afterEach(() => backend.close());

  const archive = (sessionId: string, owner = "alice", format = "trajectory") =>
    archiveId(owner, format, sessionId);
  const metadataKey = (sessionId: string, owner = "alice") =>
    keys.metadata(owner, archive(sessionId, owner));

  async function upload(sessionId: string, transcript: string, offset = 0, owner = "alice") {
    const pipeline = new Pipeline({ store, formats, reviewer });
    return (await pipeline.submit(
      uploadEnvelope(
        {
          owner,
          format: "trajectory",
          session_id: sessionId,
          transcript,
          encoding: "jsonl",
          offset,
        },
        { caller: { kind: "static", principal: owner }, owner_basis: "verified" },
      ),
    )) as StoreSessionResult;
  }

  async function rewrite(key: string, change: (m: SessionMetadata) => unknown): Promise<void> {
    const metadata = JSON.parse(
      new TextDecoder().decode((await getBytes(store, key)) ?? new Uint8Array()),
    );
    await store.put(key, encoder.encode(JSON.stringify(change(metadata))));
  }

  /** The healthy bucket: what the pipeline writes for each kind of session. */
  async function healthy() {
    // A publish, then a chunk: a continuation.
    const first = await upload("s1", meta() + user("hello") + reply("hi"));
    expect(first.status).toBe("stored");
    expect((await upload("s1", user("more") + reply("done"), first.bytes_total)).status).toBe(
      "stored",
    );
    // A visibility change, and a tombstone.
    await upload("s2", meta() + user("visible") + reply("ok"));
    await setVisibility({
      store,
      owner: "alice",
      format: "trajectory",
      session_id: "s2",
      visibility: "owner",
    });
    await upload("s3", meta() + user("deleted") + reply("ok"));
    await tombstone({ store, owner: "alice", format: "trajectory", session_id: "s3" });
    // A stub, and a stub continued: its first trace starts past the dropped records.
    const dropped = meta() + user("the customer table") + reply("listed");
    expect((await upload("s4", dropped, 0, "bob")).status).toBe("dropped");
    const stub = await upload("s5", dropped, 0, "bob");
    expect(stub.status).toBe("dropped");
    expect((await upload("s5", user("other") + reply("ok"), stub.bytes_total, "bob")).status).toBe(
      "stored",
    );
    // An assembled OTLP session whose two spans share a stored message.
    const pipeline = new Pipeline({
      store,
      formats,
      assembler: new SpanStore({ store }),
      filter: { enabled: true, min_chars: 1, require_user: true, require_reply: true },
    });
    await pipeline.submit(spans(1, [chat(1, [["user", "what is auth?"]], "a token")]));
    await pipeline.submit(
      spans(2, [
        chat(
          2,
          [
            ["user", "what is auth?"],
            ["assistant", "a token"],
            ["user", "and refresh?"],
          ],
          "a new token",
        ),
      ]),
    );
    const assembled = await assemblePending({
      store,
      formats,
      publish: (session) => pipeline.publishAssembled(session),
      quietMs: () => 0,
    });
    expect(assembled).toMatchObject({ published: 1 });
    await createToken(store, {
      schema: "seshi/token/1",
      id: "tok_abcdefgh",
      hash: `sha256:${"9".repeat(64)}`,
      kind: "device",
      owner: "alice",
      scopes: ["sessions:write"],
      created_at: new Date().toISOString(),
      expires_at: null,
      revoked: false,
    });
  }

  /** Check the healthy bucket after `corrupt`, and expect exactly these finding codes. */
  async function expectFindings(corrupt: () => Promise<void>, expected: FindingCode[]) {
    await healthy();
    await corrupt();
    const report = await checkStore(store);
    expect(codes(report), JSON.stringify(report.findings, null, 2)).toEqual([...expected].sort());
    for (const f of report.findings) expect(f.severity).toBe(FINDINGS[f.code].severity);
    return report;
  }

  it("finds nothing wrong with a bucket the pipeline wrote, and writes nothing", async () => {
    await healthy();
    const { store: readOnly, writes } = watched(store);
    const report = await checkStore(readOnly);
    // Nothing at all: no errors and no warnings. A stub continued by a chunk (bob's s5) records
    // the current format version, so it is not stale.
    expect(report.findings).toEqual([]);
    expect(report.counts).toMatchObject({
      owners: 3,
      sessions: 6,
      stubs: 1,
      redacted: 1,
      trace_objects: 5,
      span_records: 2,
      tokens: 1,
      errors: 0,
      warns: 0,
    });
    expect(report.counts.span_messages).toBe(
      (await listSpanMessages(store, SVC, archive(OTLP_SESSION, SVC, "otlp-genai"))).size,
    );
    expect(report.counts.change_entries).toBeGreaterThanOrEqual(7);
    expect(writes).toEqual([]);
  });

  it("finds a chunk review dropped mid-session explained by applied, not a gap", async () => {
    const first = await upload("g1", meta() + user("hello") + reply("hi"));
    const dropped = await upload("g1", user("the customer table") + reply("no"), first.bytes_total);
    expect(dropped.status).toBe("dropped");
    await upload("g1", user("after") + reply("ok"), dropped.bytes_total);
    const metadata = await readMetadata(store, "alice", archive("g1"));
    expect(metadata?.traces[1]?.continuation?.from_record).toBeGreaterThan(first.records_total);
    expect(unexpected(await checkStore(store))).toEqual([]);
  });

  it("names a head whose object is gone", async () => {
    const report = await expectFindings(async () => {
      const metadata = await readMetadata(store, "alice", archive("s1"));
      await store.delete(keys.trace("alice", archive("s1"), metadata?.head as string));
    }, ["head_missing"]);
    expect(report.findings[0]).toMatchObject({ owner: "alice", archive_id: archive("s1") });
  });

  it("names a listed trace whose object is gone, and a head not in traces", async () => {
    await expectFindings(async () => {
      const metadata = await readMetadata(store, "alice", archive("s1"));
      await store.delete(
        keys.trace("alice", archive("s1"), metadata?.traces[0]?.content_hash as string),
      );
      await rewrite(metadataKey("s2"), (m) => ({ ...m, head: "f".repeat(64) }));
    }, ["trace_missing", "head_not_in_traces", "head_missing"]);
  });

  it("names a broken continuation (the trace object then disagrees too)", async () => {
    await expectFindings(
      () =>
        rewrite(metadataKey("s1"), (m) => {
          const [a, b] = m.traces;
          return {
            ...m,
            traces: [a, { ...b, continuation: { ...b?.continuation, from_record: 1 } }],
          };
        }),
      ["chain_break", "trace_mismatch"],
    );
  });

  it("names a chain that does not start at the dropped prefix", async () => {
    await expectFindings(
      () =>
        rewrite(metadataKey("s5", "bob"), (m) => ({
          ...m,
          dropped_prefix: { ...m.dropped_prefix, records: 1 },
        })),
      ["chain_start"],
    );
  });

  it("names records in no trace (warn) and more records than normalized (error)", async () => {
    await expectFindings(async () => {
      await rewrite(metadataKey("s1"), (m) => ({
        ...m,
        normalized: { ...m.normalized, records: (m.normalized?.records ?? 0) + 2 },
      }));
      await rewrite(metadataKey("s2"), (m) => ({
        ...m,
        normalized: { ...m.normalized, records: 1 },
      }));
    }, ["chain_gap", "chain_total"]);
  });

  it("names a stub with traces, with content, and without its log state", async () => {
    await expectFindings(async () => {
      const s1 = await readMetadata(store, "alice", archive("s1"));
      await rewrite(metadataKey("s4", "bob"), (m) => {
        const { dropped_prefix: _d, ...rest } = m;
        return { ...rest, traces: [s1?.traces[0]], project: "github.com/acme/secret" };
      });
    }, ["stub_traces", "stub_content", "stub_log_state"]);
  });

  it("names a stub's or a tombstoned session's old trace object, and a tombstoned head", async () => {
    await expectFindings(async () => {
      for (const [sessionId, owner] of [
        ["s4", "bob"],
        ["s3", "alice"],
      ] as const) {
        const key = keys.trace(owner, archive(sessionId, owner), "c".repeat(64));
        await store.put(key, encoder.encode("left behind"));
        backend.age(key, 2 * HOUR);
      }
      await rewrite(metadataKey("s3"), (m) => ({ ...m, head: "c".repeat(64) }));
    }, ["stub_trace_object", "redacted_readable"]);
  });

  it("warns of an unnamed trace object over the sweep age, not of a young one", async () => {
    await healthy();
    const key = keys.trace("alice", archive("s1"), "a".repeat(64));
    await store.put(key, encoder.encode("left behind"));
    expect(unexpected(await checkStore(store))).toEqual([]);
    backend.age(key, 2 * HOUR);
    const report = await checkStore(store);
    expect(unexpected(report)).toEqual([
      expect.objectContaining({ severity: "warn", code: "orphan_trace", key }),
    ]);
    expect(report.counts).toMatchObject({ errors: 0, warns: 1 });
    // The age guard is the caller's to set.
    expect(unexpected(await checkStore(store, { minAgeMs: 3 * HOUR }))).toEqual([]);
    // And an old unnamed object where there is no metadata at all.
    const lost = keys.trace("alice", archive("never"), "b".repeat(64));
    await store.put(lost, encoder.encode("left behind"));
    backend.age(lost, 2 * HOUR);
    expect(codes(await checkStore(store))).toEqual(["orphan_trace", "orphan_trace"]);
  });

  it("names change entries for a session that does not exist", async () => {
    const report = await expectFindings(async () => {
      const writer = { kind: "static" as const, principal: "alice", source_id: "upload" };
      const at = new Date().toISOString();
      const base = {
        at,
        owner: "alice",
        session_id: "ghost",
        format: "trajectory",
        writer,
        owner_basis: "verified" as const,
      };
      await appendChange(store, {
        ...base,
        kind: "tombstone",
        archive_id: archive("ghost"),
        content_hash: null,
        reason: "deleted",
      });
      await appendChange(store, {
        ...base,
        kind: "published",
        archive_id: archive("ghost"),
        content_hash: "d".repeat(64),
      });
    }, ["change_no_session", "change_orphan"]);
    expect(report.findings.find((f) => f.code === "change_orphan")?.severity).toBe("warn");
  });

  it("names entries that are not change keys, not entries, or disagree with their key", async () => {
    await expectFindings(async () => {
      const [first, second] = (await readChanges(store, "alice")).entries;
      await store.put(
        `${keys.changes("alice")}20261101T000000.000Z-old.json`,
        encoder.encode("{}"),
      );
      await store.put(first?.key as string, encoder.encode("{not json"));
      await store.put(
        second?.key as string,
        encoder.encode(JSON.stringify({ ...second?.entry, owner: "mallory" })),
      );
    }, ["change_key", "change_unreadable", "change_mismatch"]);
  });

  it("names changes without entries: a listed trace and a tombstone", async () => {
    await expectFindings(async () => {
      for (const { key, entry } of (await readChanges(store, "alice")).entries) {
        if (entry.session_id === "s3" && entry.kind === "tombstone") await store.delete(key);
        if (entry.session_id === "s2" && entry.kind === "published") await store.delete(key);
      }
    }, ["tombstone_no_entry", "publish_no_entry"]);
  });

  it("warns of entries for changes the session does not show (a write that failed)", async () => {
    await expectFindings(async () => {
      const writer = { kind: "static" as const, principal: "alice", source_id: "upload" };
      await appendChange(store, {
        kind: "tombstone",
        at: new Date().toISOString(),
        owner: "alice",
        archive_id: archive("s1"),
        session_id: "s1",
        format: "trajectory",
        content_hash: null,
        writer,
        owner_basis: "verified",
        reason: "deleted",
      });
    }, ["change_not_applied"]);
  });

  it("names a span record whose message is gone, and warns of an old unnamed message", async () => {
    const owner = SVC;
    const a = archive(OTLP_SESSION, owner, "otlp-genai");
    await expectFindings(async () => {
      const [gone] = [...(await listSpanMessages(store, owner, a))];
      await store.delete(keys.spanMessage(owner, a, gone as string));
      const extra = keys.spanMessage(owner, a, "e".repeat(64));
      await store.put(extra, encoder.encode("{}"));
      backend.age(extra, 2 * HOUR);
      await store.put(keys.span(owner, a, "cd".repeat(16), "1".repeat(16)), encoder.encode("[]"));
    }, ["span_message_missing", "span_message_unnamed", "span_unreadable"]);
  });

  it("names a tombstoned session's old span objects", async () => {
    await expectFindings(async () => {
      const key = keys.span("alice", archive("s3"), "cd".repeat(16), "1".repeat(16));
      await store.put(key, encoder.encode("{}"));
      backend.age(key, 2 * HOUR);
    }, ["redacted_spans"]);
  });

  it("names metadata that is not JSON, does not match its schema, or names another session", async () => {
    await expectFindings(async () => {
      await store.put(metadataKey("s1"), encoder.encode("{ not json"));
      await rewrite(metadataKey("s2"), (m) => ({ ...m, visibility: "public" }));
      await rewrite(metadataKey("s5", "bob"), (m) => ({ ...m, owner: "carol" }));
    }, ["metadata_unreadable", "metadata_invalid", "metadata_identity"]);
  });

  it("names a trace object that is not a trace, or not the one its key names", async () => {
    await expectFindings(async () => {
      const s1 = await readMetadata(store, "alice", archive("s1"));
      await store.put(
        keys.trace("alice", archive("s1"), s1?.traces[0]?.content_hash as string),
        encoder.encode("not gzip"),
      );
      const s2 = await readMetadata(store, "alice", archive("s2"));
      const key = keys.trace("alice", archive("s2"), s2?.head as string);
      const trace = JSON.parse(
        new TextDecoder().decode(
          (await import("node:zlib")).gunzipSync((await getBytes(store, key)) as Uint8Array),
        ),
      );
      trace.records[1].content = "changed after the fact";
      await store.put(key, gzipJsonDeterministic(trace));
    }, ["trace_unreadable", "trace_mismatch"]);
    // Without reading traces, only their presence is checked.
    expect(unexpected(await checkStore(store, { readTraces: false }))).toEqual([]);
  });

  it("warns of a stored session with no format version", async () => {
    await expectFindings(
      () =>
        rewrite(metadataKey("s2"), (m) => {
          const { normalizer: _n, ...rest } = m;
          return rest;
        }),
      ["format_version_missing"],
    );
  });

  it("names a missing, unreadable or foreign layout marker", async () => {
    await expectFindings(() => store.delete(LAYOUT_KEY), ["marker_missing"]);
    await store.put(LAYOUT_KEY, encoder.encode(JSON.stringify({ schema: "seshi/layout/2" })));
    expect(codes(await checkStore(store))).toEqual(["marker_version"]);
    await store.put(LAYOUT_KEY, encoder.encode("nope"));
    expect(codes(await checkStore(store))).toContain("marker_invalid");
  });

  it("finds nothing in an empty bucket", async () => {
    expect(await checkStore(store)).toMatchObject({ findings: [], counts: { owners: 0 } });
  });

  it("names a token record that does not parse, never what it holds", async () => {
    const report = await expectFindings(async () => {
      await store.put(
        keys.token("tok_brokenone"),
        encoder.encode(JSON.stringify({ hash: "seshi_secret_value" })),
      );
    }, ["token_unreadable"]);
    expect(JSON.stringify(report)).not.toContain("seshi_secret_value");
  });

  it("checks only the owners or sessions it is given", async () => {
    await healthy();
    await store.delete(
      keys.trace(
        "alice",
        archive("s1"),
        (await readMetadata(store, "alice", archive("s1")))?.head as string,
      ),
    );
    await store.put(keys.token("tok_brokenone"), encoder.encode("{}"));
    expect(codes(await checkStore(store, { owners: ["bob"] }))).toEqual([]);
    expect(codes(await checkStore(store, { owners: ["alice"] }))).toEqual(["head_missing"]);
    const one = await checkStore(store, {
      sessions: [{ owner: "alice", archive_id: archive("s2") }],
    });
    expect(unexpected(one)).toEqual([]);
    expect(one.counts).toMatchObject({ sessions: 1, tokens: 0 });
    expect(
      codes(await checkStore(store, { sessions: [{ owner: "alice", archive_id: archive("s1") }] })),
    ).toEqual(["head_missing"]);
    await expect(checkStore(store, { owners: ["no one"] })).rejects.toThrow(/not an owner id/);
  });

  it("records a read that fails as a finding and checks the rest", async () => {
    await healthy();
    const bad = metadataKey("s1");
    const failing: Store = {
      url: store.url,
      get: async (key) => {
        if (key === bad) throw new Error("connection reset");
        return store.get(key);
      },
      stat: (key) => store.stat(key),
      list: (prefix, options) => store.list(prefix, options),
      put: (key, body, options) => store.put(key, body, options),
      delete: (key, options) => store.delete(key, options),
    };
    const report = await checkStore(failing);
    expect(unexpected(report)).toEqual([
      expect.objectContaining({
        code: "read_failed",
        owner: "alice",
        archive_id: archive("s1"),
        message: expect.stringContaining("connection reset"),
      }),
    ]);
    expect(report.counts.sessions).toBe(5);
  });
});
