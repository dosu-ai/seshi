import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@seshi/model";
import {
  APPLIED_KEPT,
  getSession,
  getTrace,
  IngestRejected,
  ingest,
  listSessions,
  planShipment,
  prefixSha256,
  recordProgress,
  tombstone,
  withApplied,
} from "@seshi/pipeline";
import {
  archiveId,
  encodeJson,
  FsStore,
  getBytes,
  keys,
  LAYOUT_KEY,
  LayoutError,
  LEGACY_LAYOUT_KEY,
  PreconditionFailed,
  readChanges,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golden } from "../tooling/testdata";

/** The pipeline's write path over a folder store. Its record sets are fixtures from other
 * folders (the cross-language ones in spec/, Claude Code's in its integration), so it lives in
 * tests/ (X3.6). */

/** A golden's records without the LLM calls they name: these tests are not about calls (the
 * canonical trace's tests add their own). */
const records = (name: string): NormalizedRecord[] =>
  golden<Record<string, unknown>[]>(`${name}.records.json`).map(
    ({ llm_call: _, ...record }) => record as unknown as NormalizedRecord,
  );
const expectedHash = (name: string): string =>
  golden<{ content_hash: string }>(`${name}.expected.json`).content_hash;

let dir: string;
let store: FsStore;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++));
const meta = {
  session_id: "sess1",
  format: "claude",
  project: "github.com/acme/widget",
  branch: "main",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessionstorage-ingest-"));
  store = new FsStore(dir);
  tick = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ingest", () => {
  it("stores a trace, a pointer and a change entry", async () => {
    const result = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    expect(result).toMatchObject({
      status: "stored",
      content_hash: expectedHash("claude-basic"),
      archive_id: archiveId("acme", "claude", "sess1"),
      records: 5,
      events: 4,
    });

    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session).toMatchObject({
      schema: "seshi/metadata/1",
      owner: "acme",
      status: "stored",
      head: result.content_hash,
      project: "github.com/acme/widget",
      branch: "main",
      source: "claude-code",
      // Who wrote it and on what basis (X5.5), who may read it (X5.10), where it came from.
      writer: { kind: "local", principal: "acme", source_id: "upload" },
      owner_basis: "verified",
      visibility: "org",
      provenance: { source: "upload", source_id: "upload", format: "claude" },
      origin_agent: "claude-code",
      native_session_id: "sess1",
    });
    expect(session?.traces).toHaveLength(1);

    const trace = await getTrace(store, "acme", result.archive_id, result.content_hash);
    expect(trace).toMatchObject({
      schema: "seshi/trace/1",
      content_hash: result.content_hash,
      format: "claude",
      session_id: "sess1",
      project: "github.com/acme/widget",
    });
    expect(trace?.events).toHaveLength(4);
    expect(trace?.metadata).toMatchObject({ cwd: "/repo/app", git_branch: "main" });

    const changes = await readChanges(store, "acme");
    expect(changes.entries.map((e) => e.entry.kind)).toEqual(["published"]);
    expect(changes.entries[0]?.entry.content_hash).toBe(result.content_hash);
    expect(changes.entries[0]?.entry).toMatchObject({
      schema: "seshi/change/1",
      writer: { kind: "local", principal: "acme", source_id: "upload" },
    });
    expect(await getBytes(store, LAYOUT_KEY)).not.toBeNull();
  });

  it("dedupes the same content and backfills lineage", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const again = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: { ...meta, parent_session_id: "parent-1" },
      now,
    });
    expect(again.status).toBe("duplicate");
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.traces).toHaveLength(1);
    expect(session?.parent_session_id).toBe("parent-1");
    expect((await readChanges(store, "acme")).entries).toHaveLength(1);
  });

  it("keeps owners apart: the same session under two owners is two archives", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const other = await ingest({
      store,
      owner: "beta",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    expect(other.status).toBe("stored");
    expect((await listSessions(store, "acme")).sessions).toHaveLength(1);
    expect((await listSessions(store, "beta")).sessions).toHaveLength(1);
  });

  it("stores a continuation as a second trace of the same session", async () => {
    // The tail must itself be a conversation (a user turn and an answer); one that is not is
    // trivial and never reaches ingest.
    const full = records("claude-queued-input");
    const shipped = { records: 6, prefix_sha256: prefixSha256(full, 6) };
    await ingest({ store, owner: "acme", records: full.slice(0, 6), metadata: meta, now });
    const plan = planShipment(full, shipped);
    expect(plan.continuation).toEqual({ from_record: 6, prefix_sha256: shipped.prefix_sha256 });
    expect(plan.records.map((r) => r.role)).toEqual([
      "meta",
      "observation",
      "user",
      "observation",
      "assistant",
    ]);
    const tail = await ingest({
      store,
      owner: "acme",
      records: plan.records,
      metadata: { ...meta, continuation: plan.continuation },
      now,
    });
    expect(tail.status).toBe("stored");
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.traces.map((t) => t.continuation?.from_record)).toEqual([undefined, 6]);
    expect(session?.head).toBe(tail.content_hash);
    const trace = await getTrace(store, "acme", tail.archive_id, tail.content_hash);
    expect(trace?.metadata.continuation).toEqual(plan.continuation);
  });

  it("rejects what is not a trajectory, without writing", async () => {
    await expect(
      ingest({ store, owner: "acme", records: records("reject-no-user"), metadata: meta, now }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      ingest({ store, owner: "acme", records: [{} as NormalizedRecord], metadata: meta, now }),
    ).rejects.toBeInstanceOf(IngestRejected);
    expect(await getSession(store, "acme", "claude", "sess1")).toBeNull();
  });
});

describe("ingest's options for the pipeline", () => {
  const state = (n: number) => ({
    bytes: 100 * n,
    records: n,
    prefix_sha256: "a".repeat(64),
    hash_state: `${n}:x`,
  });

  it("remembers the envelope it applied, the log state and the withheld calls", async () => {
    const stored = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
      normalized: state(4),
      withheld_calls: { toolu_1: "sensitive-file" },
      applied: { idempotency_key: "k1" },
    });
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.normalized).toEqual(state(4));
    expect(session?.withheld_calls).toEqual({ toolu_1: "sensitive-file" });
    expect(session?.applied).toEqual([
      {
        idempotency_key: "k1",
        at: expect.any(String),
        status: "stored",
        content_hash: stored.content_hash,
        records: stored.records,
        events: stored.events,
        records_total: 4,
        prefix_sha256: "a".repeat(64),
        bytes_total: 400,
      },
    ]);
    // The same trace again, applied by another envelope: a duplicate, remembered as one; an
    // empty withheld set removes it.
    await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
      normalized: state(4),
      withheld_calls: {},
      applied: { idempotency_key: "k2" },
    });
    const again = await getSession(store, "acme", "claude", "sess1");
    expect(again?.applied?.map((a) => [a.idempotency_key, a.status])).toEqual([
      ["k1", "stored"],
      ["k2", "duplicate"],
    ]);
    expect(again && "withheld_calls" in again).toBe(false);
  });

  it("keeps the last APPLIED_KEPT envelopes", () => {
    let applied: ReturnType<typeof withApplied> = [];
    for (let i = 0; i < APPLIED_KEPT + 5; i++) {
      applied = withApplied(applied, {
        idempotency_key: `k${i}`,
        at: "2026-11-14T09:00:00.000Z",
        status: "unchanged",
        records_total: 0,
        prefix_sha256: "a".repeat(64),
        bytes_total: 0,
      });
    }
    expect(applied).toHaveLength(APPLIED_KEPT);
    expect(applied[0]?.idempotency_key).toBe("k5");
    // A resend's entry moves to the end instead of appearing twice.
    applied = withApplied(applied, { ...(applied[0] as (typeof applied)[number]) });
    expect(applied.map((a) => a.idempotency_key).filter((k) => k === "k5")).toHaveLength(1);
    expect(applied.at(-1)?.idempotency_key).toBe("k5");
  });

  it("leaves nothing behind when the guard refuses the stored session", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const archive = archiveId("acme", "claude", "sess1");
    const before = (await store.list(keys.session("acme", archive))).keys;
    let calls = 0;
    await expect(
      ingest({
        store,
        owner: "acme",
        records: records("claude-queued-input"),
        metadata: meta,
        now,
        // Accept the first look (before the object is written), refuse inside the update.
        guard: () => {
          if (calls++ > 0) throw new Error("changed");
        },
      }),
    ).rejects.toThrow("changed");
    expect((await store.list(keys.session("acme", archive))).keys).toEqual(before);
  });

  it("records progress without a trace: the log moves on and the envelope is remembered", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const archive = archiveId("acme", "claude", "sess1");
    await recordProgress({
      store,
      owner: "acme",
      archive_id: archive,
      normalized: state(7),
      applied: { idempotency_key: "k9", status: "dropped" },
      now,
    });
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.normalized).toEqual(state(7));
    expect(session?.applied).toEqual([
      expect.objectContaining({ idempotency_key: "k9", status: "dropped", bytes_total: 700 }),
    ]);
    expect(session?.traces).toHaveLength(1);
    // Nothing to move for a session that is not stored.
    await recordProgress({
      store,
      owner: "acme",
      archive_id: archiveId("acme", "claude", "none"),
      normalized: state(1),
    });
    expect(await getSession(store, "acme", "claude", "none")).toBeNull();
  });
});

describe("tombstone", () => {
  it("leaves no trace behind when it lands while an ingest is publishing", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    // The session is tombstoned right after the racing ingest wrote its trace object and
    // before it updates the pointer: the tombstone cannot know of that object.
    let raced = false;
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== "put") return Reflect.get(target, prop, receiver);
        return async (key: string, body: Uint8Array, options?: object) => {
          const put = await target.put(key, body, options);
          if (!raced && key.includes("/trace.")) {
            raced = true;
            await tombstone({
              store: target,
              owner: "acme",
              format: "claude",
              session_id: "sess1",
            });
          }
          return put;
        };
      },
    });
    await expect(
      ingest({
        store: racing,
        owner: "acme",
        records: records("claude-queued-input"),
        metadata: meta,
        now,
      }),
    ).rejects.toMatchObject({ code: "redacted" });
    expect(raced).toBe(true);
    const archive = archiveId("acme", "claude", "sess1");
    expect((await store.list(keys.session("acme", archive))).keys).toEqual([
      keys.metadata("acme", archive),
    ]);
  });

  it("removes the traces it read when its pointer write landed but answered PreconditionFailed", async () => {
    const stored = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    let answered = false;
    const lost = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== "put") return Reflect.get(target, prop, receiver);
        return async (key: string, body: Uint8Array, options?: object) => {
          const put = await target.put(key, body, options);
          if (!answered && key === keys.metadata("acme", stored.archive_id)) {
            answered = true;
            throw new PreconditionFailed(key, "the answer was lost");
          }
          return put;
        };
      },
    });
    expect(
      await tombstone({ store: lost, owner: "acme", format: "claude", session_id: "sess1", now }),
    ).toEqual({ removed: 1 });
    expect(answered).toBe(true);
    expect(await getTrace(store, "acme", stored.archive_id, stored.content_hash)).toBeNull();
    expect((await getSession(store, "acme", "claude", "sess1"))?.status).toBe("redacted");
  });

  it("removes the trace objects and the log state, marks the session redacted, and refuses re-ingest", async () => {
    const stored = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
      normalized: { bytes: 10, records: 4, prefix_sha256: "a".repeat(64), hash_state: "4:x" },
      withheld_calls: { t1: "secret-output" },
      applied: { idempotency_key: "k1" },
    });
    await ingest({
      store,
      owner: "acme",
      records: records("claude-queued-input"),
      metadata: meta,
      now,
    });
    const result = await tombstone({
      store,
      owner: "acme",
      format: "claude",
      session_id: "sess1",
      now,
    });
    expect(result).toEqual({ removed: 2 });

    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.status).toBe("redacted");
    expect(session?.head).toBeUndefined();
    for (const field of ["normalized", "withheld_calls", "applied"]) {
      expect(session && field in session).toBe(false);
    }
    expect(await getTrace(store, "acme", stored.archive_id, stored.content_hash)).toBeNull();
    expect((await store.list(keys.session("acme", stored.archive_id))).keys).toEqual([
      keys.metadata("acme", stored.archive_id),
    ]);

    const changes = (await readChanges(store, "acme")).entries;
    expect(changes.map((e) => e.entry.kind)).toEqual(["published", "published", "tombstone"]);
    expect(changes[2]?.key.endsWith("-tombstone.json")).toBe(true);

    await expect(
      ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now }),
    ).rejects.toMatchObject({ code: "redacted" });
    expect(
      await tombstone({ store, owner: "acme", format: "claude", session_id: "never", now }),
    ).toBeNull();
  });
});

describe("who wrote what (X5.5)", () => {
  const device = {
    kind: "device" as const,
    principal: "alice",
    credential_id: "tok_alice-laptop",
    source_id: "upload",
  };

  it("keeps the original writer and owner basis, records each write's writer, and merges claims", async () => {
    const first = await ingest({
      store,
      owner: "alice",
      records: records("claude-basic"),
      metadata: meta,
      now,
      writer: device,
      owner_basis: "claimed",
      visibility: "owner",
      claims: { git_email: "alice@example.com" },
    });
    const admin = { kind: "admin" as const, principal: "root", source_id: "upload" };
    await ingest({
      store,
      owner: "alice",
      records: [
        ...records("claude-basic"),
        { role: "user", content: "more", timestamp: "2026-01-01T00:00:00Z" },
      ],
      metadata: meta,
      now,
      writer: admin,
      owner_basis: "verified",
      visibility: "org",
      claims: { account_ids: { anthropic: "acct-1" } },
    });
    const session = await getSession(store, "alice", "claude", "sess1");
    expect(session?.writer).toEqual(device);
    expect(session?.owner_basis).toBe("claimed");
    expect(session?.visibility).toBe("owner");
    expect(session?.claims).toEqual({
      git_email: "alice@example.com",
      account_ids: { anthropic: "acct-1" },
    });
    expect(session?.traces.map((t) => t.content_hash)[0]).toBe(first.content_hash);
    const writers = (await readChanges(store, "alice")).entries.map((e) => e.entry.writer);
    expect(writers).toEqual([device, admin]);
  });

  it("records a tombstone's reason and writer, never its content", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    await ingest({
      store,
      owner: "acme",
      records: records("codex-subagent-report"),
      metadata: { ...meta, session_id: "sess2" },
      now,
    });
    await tombstone({ store, owner: "acme", format: "claude", session_id: "sess1", now });
    await tombstone({
      store,
      owner: "acme",
      format: "claude",
      session_id: "sess2",
      now,
      reason: "retracted",
      writer: device,
    });
    const tombstones = (await readChanges(store, "acme")).entries
      .map((e) => e.entry)
      .filter((e) => e.kind === "tombstone");
    expect(tombstones.map((e) => [e.reason, e.writer.kind])).toEqual([
      ["deleted", "local"],
      ["retracted", "device"],
    ]);
  });
});

describe("the canonical trace (X6.2)", () => {
  it("carries LLM calls, record ids and provenance, and hashes as plain trajectory-v1 does", async () => {
    const plain = records("claude-basic");
    const enriched = plain.map((record, i) =>
      record.role === "assistant"
        ? { ...record, id: `msg-${i}`, llm_call: "call-1" }
        : record.role === "tool"
          ? { ...record, duration_ms: 12 }
          : record,
    );
    const llm_calls = [
      {
        id: "call-1",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        stop_reason: "end_turn",
      },
    ];
    const result = await ingest({
      store,
      owner: "acme",
      records: enriched,
      metadata: meta,
      now,
      llm_calls,
      provenance: { source: "hook", source_id: "upload", format: "claude-code" },
      normalized: undefined,
    });
    expect(result.content_hash).toBe(expectedHash("claude-basic"));
    const trace = await getTrace(store, "acme", result.archive_id, result.content_hash);
    expect(trace?.llm_calls).toEqual(llm_calls);
    expect(trace?.provenance).toEqual({
      source: "hook",
      source_id: "upload",
      format: "claude-code",
    });
    expect(trace?.records.find((r) => r.role === "assistant")).toMatchObject({
      llm_call: "call-1",
    });
    expect(trace?.records.find((r) => r.role === "tool")).toMatchObject({ duration_ms: 12 });
  });

  it("refuses a record that names an LLM call the trace does not have", async () => {
    const bad = records("claude-basic").map((r) =>
      r.role === "assistant" ? { ...r, llm_call: "missing" } : r,
    );
    await expect(
      ingest({ store, owner: "acme", records: bad, metadata: meta, now }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("llm_call missing"),
    });
  });

  it("keeps an LLM call to the contract: unknown fields dropped, wrong types refused", async () => {
    const recs = records("claude-basic").map((r, i) =>
      r.role === "assistant" && i > 0 ? { ...r, llm_call: "c1" } : r,
    );
    const result = await ingest({
      store,
      owner: "acme",
      records: recs,
      metadata: meta,
      now,
      llm_calls: [
        {
          id: "c1",
          model: "claude-opus",
          usage: { input_tokens: 3, output_tokens: 4 },
          parameters: { temperature: 0, stop: null },
          cost_usd: 0.25,
        } as never,
      ],
    });
    const trace = await getTrace(store, "acme", result.archive_id, result.content_hash);
    expect(trace?.llm_calls).toEqual([
      {
        id: "c1",
        model: "claude-opus",
        usage: { input_tokens: 3, output_tokens: 4 },
        parameters: { temperature: 0, stop: null },
      },
    ]);
    for (const [call, message] of [
      [{ id: "c1", model: 42 }, "model must be a string"],
      [{ id: "c1", parameters: { tools: { a: 1 } } }, "parameters.tools"],
      [{ id: "c1", usage: { input_tokens: 1.5 } }, "usage.input_tokens"],
      [{ id: "c1", usage: { cost: 1 } }, "usage.cost"],
      [{ id: "c1", duration_ms: -1 }, "duration_ms"],
      [{ model: "x" }, "needs an id"],
    ] as const) {
      await expect(
        ingest({
          store,
          owner: "acme",
          records: recs,
          metadata: { ...meta, session_id: "llm-bad" },
          now,
          llm_calls: [call as never],
        }),
      ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(message) });
    }
  });
});

describe("conditional pointer writes (X6.5)", () => {
  it("acts on what the attempt that landed found, when another write makes it retry", async () => {
    const first = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    const archive = first.archive_id;
    // Another writer adds a trace between the replace's read of the pointer and its
    // conditional write: the first attempt would take off one trace, the second two.
    let metadataReads = 0;
    let added: string | undefined;
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== "get") return Reflect.get(target, prop, receiver);
        return async (key: string) => {
          const read = await target.get(key);
          if (key === keys.metadata("acme", archive) && ++metadataReads === 2) {
            added = (
              await ingest({
                store: target,
                owner: "acme",
                records: records("claude-queued-input"),
                metadata: meta,
                now,
              })
            ).content_hash;
          }
          return read;
        };
      },
    });
    const replacing = await ingest({
      store: racing,
      owner: "acme",
      records: [
        ...records("claude-basic"),
        { role: "user", content: "and one more", timestamp: "2026-01-01T00:00:00Z" },
      ],
      metadata: meta,
      now,
      replace: true,
    });
    expect(added).toBeDefined();
    expect(metadataReads).toBeGreaterThan(2);
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.traces.map((t) => t.content_hash)).toEqual([replacing.content_hash]);
    expect(await getTrace(store, "acme", archive, first.content_hash)).toBeNull();
    expect(await getTrace(store, "acme", archive, added as string)).toBeNull();
  });

  it("lists every trace when writers race on one session", async () => {
    const variants = Array.from({ length: 5 }, (_, i) => [
      ...records("claude-basic"),
      { role: "user" as const, content: `turn ${i}`, timestamp: "2026-01-01T00:00:00Z" },
    ]);
    const results = await Promise.all(
      variants.map((r) => ingest({ store, owner: "acme", records: r, metadata: meta, now })),
    );
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(new Set(session?.traces.map((t) => t.content_hash))).toEqual(
      new Set(results.map((r) => r.content_hash)),
    );
    expect((await readChanges(store, "acme")).entries).toHaveLength(5);
  });

  it("refuses a prefix that holds a sessiondb store, before writing anything", async () => {
    await store.put(LEGACY_LAYOUT_KEY, encodeJson({ schema: "sessionstorage/layout/1" }));
    await expect(
      ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now }),
    ).rejects.toBeInstanceOf(LayoutError);
    expect((await store.list("owners/")).keys).toEqual([]);
  });
});
