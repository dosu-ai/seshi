import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { SessionConflict, type StoreSessionResult, type Writer } from "@seshi/model";
import { compileRuleSet, type RuleSet, ruleRedactor, validatePack } from "@seshi/redact";
import {
  archiveId,
  FsStore,
  keys,
  listSpans,
  putSpan,
  readChanges,
  readMetadata,
  type Store,
  updateMetadata,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BackfillOptions, backfillRedaction } from "./backfill";
import { uploadEnvelope } from "./envelope";
import { getTrace, ingest, tombstone } from "./ingest";
import { Pipeline } from "./pipeline";
import { StoreSessionDB } from "./session-db";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-backfill-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const formats = new FormatRegistry(BUILTIN_FORMATS);
const ts = "2026-09-01T00:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const meta = (extra: Record<string, unknown> = {}) =>
  line({ role: "meta", source: "trajectory", ...extra });
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
const LONG = "x".repeat(2000);

const OPERATOR: Writer = { kind: "admin", principal: "admin", source_id: "redaction" };
const acme = validatePack(
  {
    id: "acme",
    rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }],
    sensitive_files: [{ id: "acme-vault", globs: ["acme-vault.conf"] }],
  },
  { source: "acme.toml" },
);
const NEW_RULES = compileRuleSet({ packs: [acme] });

/** Store a session through a pipeline with the built-in pack only (the old rules). */
async function store1(
  sessionId: string,
  transcript: string,
  offset = 0,
  owner = "alice",
  rules: RuleSet = compileRuleSet(),
  replace = false,
): Promise<StoreSessionResult> {
  const pipeline = new Pipeline({ store, formats, redaction: rules });
  return (await pipeline.submit(
    uploadEnvelope(
      {
        owner,
        agent: "trajectory",
        session_id: sessionId,
        transcript,
        format: "jsonl",
        offset,
        ...(replace ? { replace: true } : {}),
      },
      { caller: { kind: "static", principal: owner }, owner_basis: "verified" },
    ),
  )) as StoreSessionResult;
}

const run = (options: Partial<BackfillOptions> = {}) =>
  backfillRedaction({
    store,
    redactor: ruleRedactor(NEW_RULES),
    writer: OPERATOR,
    now: () => new Date("2030-01-01T12:00:00Z"),
    ...options,
  });

const metadata = (sessionId: string, owner = "alice") =>
  readMetadata(store, owner, archiveId(owner, "trajectory", sessionId));

describe("backfillRedaction (F2.5)", () => {
  it("rewrites a session the new rules find something in, as one trace, and removes the old", async () => {
    const head = meta() + user(`key ACME-1234 ${LONG}`) + reply("ok");
    const first = await store1("s1", head);
    const chunk = await store1("s1", user("and ACME-5678") + reply("done"), first.bytes_total);
    const before = await metadata("s1");
    expect(before?.traces).toHaveLength(2);
    expect(before?.applied?.length).toBeGreaterThan(0);

    const report = await run();
    expect(report.outcomes).toMatchObject({ rewritten: 1 });
    expect(report.counts).toEqual({ "acme-key": 2 });
    expect(report.rule_set).toBe(NEW_RULES.hash);

    const after = await metadata("s1");
    const hash = report.sessions[0]?.content_hash as string;
    expect(after?.head).toBe(hash);
    expect(after?.traces).toEqual([
      {
        content_hash: hash,
        created_at: "2030-01-01T12:00:00.000Z",
        records: 5,
        rule_set: NEW_RULES.hash,
      },
    ]);
    expect(after?.redaction).toEqual({ rule_set: NEW_RULES.hash, counts: { "acme-key": 2 } });
    expect(after?.applied).toBeUndefined();
    expect(after?.normalized).toEqual(before?.normalized);
    // The old traces are gone; the new one holds the whole session, redacted.
    for (const ref of before?.traces ?? []) {
      expect(await getTrace(store, "alice", before?.archive_id as string, ref.content_hash)).toBe(
        null,
      );
    }
    const trace = await getTrace(store, "alice", after?.archive_id as string, hash);
    expect(JSON.stringify(trace)).not.toContain("ACME-");
    expect(trace?.records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(trace?.metadata.continuation).toBeUndefined();
    // Readers learn of it from one change entry that replaces what they held.
    const { entries } = await readChanges(store, "alice", { since: "2030-01-01T00:00:00Z" });
    expect(
      entries.map(({ entry: e }) => [e.kind, e.content_hash, e.replace, e.reason, e.writer]),
    ).toEqual([["published", hash, true, "redacted", OPERATOR]]);
    expect(chunk.status).toBe("stored");
  });

  it("is idempotent: a second run finds every session current", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    await run();
    const again = await run();
    expect(again.outcomes).toMatchObject({ current: 1, rewritten: 0 });
    expect(again.sessions).toEqual([]);
  });

  it("redoes a session whose head was stored under the old rules when a chunk came under the new", async () => {
    // Review finding: a chunk written after the rules changed gave the whole session the new
    // rule set, so the backfill took it as current and left the old head's secret stored.
    const first = await store1("s1", meta() + user(`key ACME-1234 ${LONG}`) + reply("ok"));
    const chunk = await store1(
      "s1",
      user("more") + reply("done"),
      first.bytes_total,
      "alice",
      NEW_RULES,
    );
    expect(chunk.status).toBe("stored");
    const before = await metadata("s1");
    expect(before?.redaction?.rule_set).toBe(NEW_RULES.hash);
    expect(before?.traces.map((t) => t.rule_set)).toEqual([compileRuleSet().hash, NEW_RULES.hash]);

    const report = await run();
    expect(report.outcomes).toMatchObject({ rewritten: 1, current: 0 });
    const after = await metadata("s1");
    expect(after?.traces).toHaveLength(1);
    expect(after?.traces[0]?.rule_set).toBe(NEW_RULES.hash);
    const trace = await getTrace(
      store,
      "alice",
      after?.archive_id as string,
      after?.head as string,
    );
    expect(JSON.stringify(trace)).not.toContain("ACME-1234");
    expect(JSON.stringify(trace)).toContain("more");
    expect((await run()).outcomes).toMatchObject({ current: 1 });
  });

  it("only records the rule set on a session with nothing new to take out", async () => {
    await store1("s1", meta() + user(LONG) + reply("ok"));
    const before = await metadata("s1");
    const report = await run();
    expect(report.outcomes).toMatchObject({ unchanged: 1 });
    const after = await metadata("s1");
    expect(after?.head).toBe(before?.head);
    expect(after?.traces).toEqual(before?.traces.map((t) => ({ ...t, rule_set: NEW_RULES.hash })));
    expect(after?.redaction).toEqual({ rule_set: NEW_RULES.hash, counts: {} });
    expect(after?.updated_at).toBe(before?.updated_at);
    expect((await readChanges(store, "alice", { since: "2030-01-01T00:00:00Z" })).entries).toEqual(
      [],
    );
  });

  it("keeps a newly withheld call's id, so its result is withheld when a later chunk brings it", async () => {
    const first = await store1(
      "s1",
      meta() + user(LONG) + call("m1", { file_path: "deploy/acme-vault.conf" }),
    );
    expect((await metadata("s1"))?.withheld_calls).toBeUndefined();
    await run();
    expect((await metadata("s1"))?.withheld_calls).toEqual({ m1: "sensitive-file" });
    // The server now runs the new rules too; the result arrives in a chunk.
    const next = await store1(
      "s1",
      result("m1", "the-master-key"),
      first.bytes_total,
      "alice",
      NEW_RULES,
    );
    const trace = await getTrace(
      store,
      "alice",
      archiveId("alice", "trajectory", "s1"),
      (next as { content_hash: string }).content_hash,
    );
    expect(JSON.stringify(trace)).not.toContain("the-master-key");
  });

  it("replaces the object in place when only what the hash leaves out changed", async () => {
    await store1("s1", meta({ cwd: "/work/ACME-1234" }) + user(LONG) + reply("ok"));
    const before = await metadata("s1");
    const report = await run();
    expect(report.outcomes.rewritten).toBe(1);
    expect(report.sessions[0]?.content_hash).toBe(before?.head);
    const trace = await getTrace(
      store,
      "alice",
      before?.archive_id as string,
      before?.head as string,
    );
    expect(JSON.stringify(trace)).not.toContain("ACME-1234");
    expect((await metadata("s1"))?.traces.map((t) => t.content_hash)).toEqual([before?.head]);
  });

  it("lets a replace under new rules rewrite an object that keeps its hash", async () => {
    // Review finding: the hash leaves out an assistant record's text beside its tool calls, so a
    // replace under the new rules hashed the same, kept the old object (secret included), and
    // recorded the new rule set, so backfill then took the session as current.
    const withCall = line({
      role: "assistant",
      content: "here is ACME-1234",
      tool_calls: [{ id: "c1", name: "Read", args: JSON.stringify({ file_path: "a.txt" }) }],
      timestamp: ts,
    });
    const transcript = meta() + user(LONG) + withCall + result("c1", "fine");
    const first = (await store1("s1", transcript)) as { status: string; content_hash: string };
    expect(first.status).toBe("stored");
    // The uploader pre-redacts with the org's new rules (F2.4); the server's prefix no longer
    // matches, and it resends with replace after the 409.
    const preRedacted = transcript.replace("ACME-1234", "[redacted:acme-key]");
    await expect(store1("s1", preRedacted, 0, "alice", NEW_RULES)).rejects.toBeInstanceOf(
      SessionConflict,
    );
    const again = await store1("s1", preRedacted, 0, "alice", NEW_RULES, true);
    expect(again.status).toBe("stored");
    expect((again as { content_hash: string }).content_hash).toBe(first.content_hash);
    const after = await metadata("s1");
    expect(after?.traces).toHaveLength(1);
    expect(after?.traces[0]?.rule_set).toBe(NEW_RULES.hash);
    const trace = await getTrace(
      store,
      "alice",
      after?.archive_id as string,
      after?.head as string,
    );
    expect(JSON.stringify(trace)).not.toContain("ACME-1234");
    // Readers are told to read it again.
    const { entries } = await readChanges(store, "alice");
    expect(entries.at(-1)?.entry).toMatchObject({
      kind: "published",
      content_hash: first.content_hash,
      replace: true,
    });
    expect((await run()).outcomes).toMatchObject({ current: 1 });
  });

  it("writes nothing in a dry run, and says what it would do", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    await store1("s2", meta() + user(LONG) + reply("ok"));
    const before = [await metadata("s1"), await metadata("s2")];
    const report = await run({ dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.outcomes).toMatchObject({ rewritten: 1, unchanged: 1 });
    expect(report.sessions[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect([await metadata("s1"), await metadata("s2")]).toEqual(before);
  });

  it("takes only sessions written since a time, and only the owners named", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    await store1("s9", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"), 0, "bob");
    const later = await run({ since: new Date("2100-01-01T00:00:00Z") });
    expect(later.outcomes).toMatchObject({ skipped: 2, rewritten: 0 });
    const bob = await run({ owners: ["bob"] });
    expect(bob.outcomes).toMatchObject({ rewritten: 1 });
    expect(bob.sessions.map((s) => s.owner)).toEqual(["bob"]);
    expect((await metadata("s1"))?.redaction?.rule_set).not.toBe(NEW_RULES.hash);
    await expect(run({ owners: ["not an owner"] })).rejects.toThrow(/not an owner id/);
  });

  it("stops at the limit and says there is more", async () => {
    for (const id of ["s1", "s2", "s3"]) {
      await store1(id, meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    }
    const first = await run({ limit: 2 });
    expect(first.outcomes.rewritten).toBe(2);
    expect(first.more).toBe(true);
    const rest = await run({ limit: 2 });
    expect(rest.outcomes).toMatchObject({ rewritten: 1, current: 2 });
    expect(rest.more).toBe(false);
  });

  it("stops when signalled", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    const controller = new AbortController();
    controller.abort();
    const report = await run({ signal: controller.signal });
    expect(report.more).toBe(true);
    expect(report.outcomes.rewritten).toBe(0);
  });

  it("skips a tombstoned session", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    await tombstone({ store, owner: "alice", agent: "trajectory", session_id: "s1" });
    expect((await run()).outcomes).toMatchObject({ skipped: 1, rewritten: 0 });
  });

  it("leaves a session another write changed meanwhile for the next run, and its new object goes", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    // A store where a write lands on the session just before the backfill moves its pointer:
    // the listing reads the pointer once, the pointer update reads it again.
    let reads = 0;
    const racing: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            if (key === keys.metadata("alice", archive) && ++reads === 2) {
              await updateMetadata(target, "alice", archive, (m) =>
                m ? { ...m, head: "f".repeat(64) } : null,
              );
            }
            return target.get(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    const report = await run({ store: racing });
    expect(report.outcomes).toMatchObject({ conflict: 1, rewritten: 0 });
    expect(report.sessions[0]?.message).toMatch(/changed meanwhile/);
    const files = (await store.list(`${keys.session("alice", archive)}/`)).keys;
    expect(files.filter((k) => k.includes("trace."))).toHaveLength(1);
  });

  it("never serves an old trace a run stopped before deleting", async () => {
    await store1("s1", meta() + user(`key ACME-1234 ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const old = (await metadata("s1"))?.head as string;
    // The old object's delete fails once, after the pointer moved and the entry was appended.
    const failing: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return async (key: string) => {
            if (key === keys.trace("alice", archive, old)) throw new Error("transient");
            return target.delete(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    await expect(run({ store: failing })).rejects.toThrow("transient");
    expect((await metadata("s1"))?.head).not.toBe(old);
    // The object is left behind with what the new rules take out, but no reader is given it.
    expect(JSON.stringify(await getTrace(store, "alice", archive, old))).toContain("ACME-1234");
    const db = new StoreSessionDB({ store, owner: "alice", formats });
    expect(await db.getTrace("trajectory", "s1", old)).toBeNull();
    expect(JSON.stringify(await db.getTrace("trajectory", "s1"))).not.toContain("ACME-1234");
  });

  it("reports a session whose trace is missing as a conflict", async () => {
    const stored = await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    await store.delete(
      keys.trace("alice", archive, (stored as { content_hash: string }).content_hash),
    );
    const report = await run();
    expect(report.outcomes.conflict).toBe(1);
    expect(report.sessions[0]?.message).toMatch(/is missing/);
  });

  it("keeps a fork's continuation of its parent, so it still starts where the parent's copy ends", async () => {
    const parent = meta() + user(`plan ${LONG}`) + reply("ok");
    await store1("s0", parent);
    const pipeline = new Pipeline({ store, formats, redaction: compileRuleSet() });
    const fork = (await pipeline.submit(
      uploadEnvelope(
        {
          owner: "alice",
          agent: "trajectory",
          session_id: "s1",
          transcript: parent + user(`fork with ACME-1234 ${LONG}`) + reply("forked"),
          format: "jsonl",
          offset: 0,
          fork_of: "s0",
        },
        { caller: { kind: "static", principal: "alice" }, owner_basis: "verified" },
      ),
    )) as StoreSessionResult;
    expect(fork.status).toBe("stored");
    const before = await metadata("s1");
    const continuation = before?.traces[0]?.continuation;
    expect(continuation?.from_record).toBe(3);

    const report = await run({ owners: ["alice"] });
    expect(report.outcomes).toMatchObject({ rewritten: 1, unchanged: 1, failed: 0 });
    const after = await metadata("s1");
    expect(after?.traces[0]?.continuation).toEqual(continuation);
    const trace = await getTrace(
      store,
      "alice",
      after?.archive_id as string,
      after?.head as string,
    );
    expect(trace?.metadata.continuation).toEqual(continuation);
    expect(trace?.records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
    expect(JSON.stringify(trace)).not.toContain("ACME-");
    const { entries } = await readChanges(store, "alice", { since: "2030-01-01T00:00:00Z" });
    expect(entries.map(({ entry: e }) => e.continuation)).toEqual([continuation]);
  });

  it("lets a chunk continue a backfilled session", async () => {
    const first = await store1("s1", meta() + user(`key ACME-1234 ${LONG}`) + reply("ok"));
    const second = await store1("s1", user("more") + reply("yes"), first.bytes_total);
    await run();
    const third = await store1(
      "s1",
      user("and ACME-9999") + reply("fine"),
      second.bytes_total,
      "alice",
      NEW_RULES,
    );
    expect(third.status).toBe("stored");
    const after = await metadata("s1");
    expect(after?.traces).toHaveLength(2);
    const tail = await getTrace(store, "alice", after?.archive_id as string, after?.head as string);
    expect(JSON.stringify(tail)).not.toContain("ACME-");
    expect(tail?.metadata.continuation?.from_record).toBe(5);
  });

  it("makes a chunk that raced it plan again, so the old head's meta record is not written", async () => {
    const first = await store1("s1", meta({ cwd: "/work/ACME-1234" }) + user(LONG) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const oldHead = keys.trace("alice", archive, (first as { content_hash: string }).content_hash);
    let raced = false;
    // The backfill lands just after the chunk read the old head for its meta record.
    const racing: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            const value = await target.get(key);
            if (key === oldHead && !raced) {
              raced = true;
              await run({ store: target });
            }
            return value;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    const pipeline = new Pipeline({ store: racing, formats, redaction: NEW_RULES });
    const chunk = (await pipeline.submit(
      uploadEnvelope(
        {
          owner: "alice",
          agent: "trajectory",
          session_id: "s1",
          transcript: user("more") + reply("yes"),
          format: "jsonl",
          offset: first.bytes_total,
        },
        { caller: { kind: "static", principal: "alice" }, owner_basis: "verified" },
      ),
    )) as StoreSessionResult;
    expect(raced).toBe(true);
    expect(chunk.status).toBe("stored");
    const after = await metadata("s1");
    expect(after?.traces).toHaveLength(2);
    for (const ref of after?.traces ?? []) {
      const trace = await getTrace(store, "alice", archive, ref.content_hash);
      expect(JSON.stringify(trace)).not.toContain("ACME-");
    }
  });

  it("redacts what an LLM call's error and parameters say", async () => {
    const archive = archiveId("alice", "trajectory", "s1");
    await ingest({
      store,
      owner: "alice",
      records: [
        { role: "meta", source: "trajectory" },
        { role: "user", content: LONG, timestamp: ts },
        { role: "assistant", content: "ok", timestamp: ts, llm_call: "c1" },
      ] as never,
      metadata: { session_id: "s1", agent: "trajectory" },
      llm_calls: [
        {
          id: "c1",
          model: "m",
          error: "bad key ACME-1234",
          parameters: { user: "ACME-5678", n: 1 },
        },
      ],
      redaction: { rule_set: compileRuleSet().hash, counts: {} },
    });
    const report = await run();
    expect(report.outcomes).toMatchObject({ rewritten: 1 });
    expect(report.counts).toEqual({ "acme-key": 2 });
    const after = await readMetadata(store, "alice", archive);
    const trace = await getTrace(store, "alice", archive, after?.head as string);
    expect(JSON.stringify(trace)).not.toContain("ACME-");
    expect(trace?.llm_calls?.[0]).toMatchObject({ id: "c1", model: "m", parameters: { n: 1 } });
  });

  it("redacts a session's span records again, even when its traces are current (09)", async () => {
    const oldRules = compileRuleSet();
    const span = (id: string, text: string) => ({
      received_at: ts,
      source_id: "console",
      format: "otlp-genai",
      part: {
        trace_id: "ab".repeat(16),
        span_id: id,
        name: "chat m",
        started_at: ts,
        content: true,
        output: [{ role: "assistant", content: text, timestamp: ts }],
        llm_call: { id: `c-${id}`, error: `bad key ${text}` },
      } as never,
      redaction: { rule_set: oldRules.hash, counts: { "github-token": 1 } },
    });
    // s1 was stored with the old rules; s2 with the new ones (the assembler published it after
    // the rules changed), but its span records are still the old rules' work.
    await store1("s1", meta() + user(LONG) + reply("ok"));
    await store1("s2", meta() + user(LONG) + reply("ok"), 0, "alice", NEW_RULES);
    const s1 = archiveId("alice", "trajectory", "s1");
    const s2 = archiveId("alice", "trajectory", "s2");
    await putSpan(store, "alice", s1, span("0000000000000001", "ACME-1234"));
    await putSpan(store, "alice", s2, span("0000000000000002", "ACME-5678"));
    await putSpan(store, "alice", s2, {
      ...span("0000000000000003", "nothing here"),
      redaction: { rule_set: NEW_RULES.hash, counts: {} },
    });

    const dry = await run({ dryRun: true });
    expect(dry.spans).toBe(2);
    expect(JSON.stringify(await listSpans(store, "alice", s2))).toContain("ACME-5678");

    const report = await run();
    expect(report.outcomes).toMatchObject({ unchanged: 1, current: 1 });
    expect(report.spans).toBe(2);
    // Span records repeat what the traces hold: their counts stay on the records.
    expect(report.counts).toEqual({});
    for (const archive of [s1, s2]) {
      const records = await listSpans(store, "alice", archive);
      expect(JSON.stringify(records)).not.toContain("ACME-");
      for (const record of records) expect(record.redaction?.rule_set).toBe(NEW_RULES.hash);
    }
    const [redone] = await listSpans(store, "alice", s1);
    expect(redone?.part.llm_call?.error).toBe("bad key [redacted:acme-key]");
    expect(redone?.redaction?.counts).toEqual({ "github-token": 1, "acme-key": 2 });
    expect((await run()).spans).toBe(0);
  });

  it("redacts the span records of sessions never published (pending, filtered, dropped)", async () => {
    const oldRules = compileRuleSet();
    const span = (id: string, text: string) => ({
      received_at: ts,
      source_id: "console",
      format: "otlp-genai",
      part: {
        trace_id: "cd".repeat(16),
        span_id: id,
        name: "chat m",
        started_at: ts,
        content: true,
        output: [{ role: "assistant", content: text, timestamp: ts }],
      } as never,
      redaction: { rule_set: oldRules.hash, counts: {} },
    });
    // alice has a stored session beside one that never published; bob has only spans.
    await store1("s1", meta() + user(LONG) + reply("ok"));
    const pending = archiveId("alice", "otlp-genai", "sesn_pending");
    const refused = archiveId("bob", "otlp-genai", "sesn_refused");
    await putSpan(store, "alice", pending, span("0000000000000001", "ACME-1111"));
    await putSpan(store, "alice", pending, span("0000000000000002", "ACME-2222"));
    await putSpan(store, "bob", refused, span("0000000000000003", "ACME-3333"));
    expect(await readMetadata(store, "alice", pending)).toBeNull();

    expect((await run({ dryRun: true })).spans).toBe(3);
    expect(JSON.stringify(await listSpans(store, "bob", refused))).toContain("ACME-3333");
    const report = await run();
    expect(report.spans).toBe(3);
    for (const [owner, archive] of [
      ["alice", pending],
      ["bob", refused],
    ] as const) {
      const records = await listSpans(store, owner, archive);
      expect(JSON.stringify(records)).not.toContain("ACME-");
      for (const record of records) expect(record.redaction?.rule_set).toBe(NEW_RULES.hash);
    }
    // Still unpublished: no session was made of them.
    expect(await readMetadata(store, "alice", pending)).toBeNull();
    expect((await run()).spans).toBe(0);
    // An owner named on the command line is walked the same way.
    await putSpan(store, "bob", refused, span("0000000000000004", "ACME-4444"));
    expect((await run({ owners: ["bob"] })).spans).toBe(1);
  });

  it("deletes a stopped run's leftovers in the next run's sweep, and says so", async () => {
    await store1("s1", meta() + user(`key ACME-1234 ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const old = (await metadata("s1"))?.head as string;
    // The run stops after the pointer moved and the entry was appended: the old delete fails.
    const failing: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return async (key: string) => {
            if (key === keys.trace("alice", archive, old)) throw new Error("transient");
            return target.delete(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    await expect(run({ store: failing })).rejects.toThrow("transient");
    expect(await getTrace(store, "alice", archive, old)).not.toBeNull();

    // The next run finds the session current, and its sweep deletes the old object (written
    // long before the run's clock, so past the hour).
    const seen: (number | undefined)[] = [];
    const next = await run({ onSession: (s) => seen.push(s.swept) });
    expect(next.outcomes).toMatchObject({ current: 1 });
    expect(next.sweep).toEqual({ deleted: 1, young: 0, errors: 0 });
    expect(seen).toEqual([1]);
    expect(await getTrace(store, "alice", archive, old)).toBeNull();
    const head = (await metadata("s1"))?.head as string;
    expect(await getTrace(store, "alice", archive, head)).not.toBeNull();
    expect((await run()).sweep.deleted).toBe(0);
  });

  it("sweeps what it looked at by the age guard, and deletes nothing in a dry run", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const left = keys.trace("alice", archive, "a".repeat(64));
    await store.put(left, new TextEncoder().encode("left behind"));
    // On the real clock the object was written just now: under the hour, so it stays.
    const fresh = await run({ now: () => new Date(), dryRun: true });
    expect(fresh.sweep).toEqual({ deleted: 0, young: 1, errors: 0 });
    // Two hours on, a dry run says it would go and leaves it.
    const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect((await run({ now: later, dryRun: true })).sweep.deleted).toBe(1);
    expect(await store.stat(left)).not.toBeNull();
    // A session the run does not look at (not written since `since`) is not swept by it.
    const since = new Date("2100-01-01T00:00:00Z");
    expect((await run({ now: later, since })).sweep.deleted).toBe(0);
    expect((await run({ now: later })).sweep.deleted).toBe(1);
    expect(await store.stat(left)).toBeNull();
  });

  it("deletes what an earlier stopped write left once it is an hour old, and keeps what is younger", async () => {
    const first = await store1("s1", meta() + user(`hello ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const old = await leftover(archive, "a".repeat(64), 2 * 60 * 60 * 1000);
    const young = await leftover(archive, "b".repeat(64), 60 * 1000);

    const replaced = await store1(
      "s1",
      meta() + user(`rewritten ${LONG}`) + reply("ok"),
      0,
      "alice",
      compileRuleSet(),
      true,
    );
    expect(replaced.status).toBe("stored");
    expect(await store.stat(old)).toBeNull();
    expect(await store.stat(young)).not.toBeNull();
    // What the replace replaced is gone, as before; its own trace stays.
    const hashOf = (r: StoreSessionResult) => (r as { content_hash: string }).content_hash;
    expect(await store.stat(keys.trace("alice", archive, hashOf(first)))).toBeNull();
    expect(await store.stat(keys.trace("alice", archive, hashOf(replaced)))).not.toBeNull();
  });

  it("does not sweep after a write that is not a replace", async () => {
    const first = await store1("s1", meta() + user(`hello ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const old = await leftover(archive, "a".repeat(64), 2 * 60 * 60 * 1000);
    await store1("s1", user(`more ${LONG}`) + reply("done"), first.bytes_total);
    expect(await store.stat(old)).not.toBeNull();
  });

  it("writes its change entry before the pointer: a run stopped between leaves the session as it was (decision 7 of 18)", async () => {
    await store1("s1", meta() + user(`key ACME-1234 ${LONG}`) + reply("ok"));
    const archive = archiveId("alice", "trajectory", "s1");
    const before = await metadata("s1");
    // The pointer update fails once, after the change entry landed.
    let armed = true;
    const failing: Store = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, body: Uint8Array, options?: Parameters<Store["put"]>[2]) => {
            if (armed && key === keys.metadata("alice", archive)) {
              armed = false;
              throw new Error("stopped");
            }
            return target.put(key, body, options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
    await expect(run({ store: failing })).rejects.toThrow("stopped");
    const since = { since: "2030-01-01T00:00:00Z" };
    const { entries } = await readChanges(store, "alice", since);
    expect(entries.map(({ entry: e }) => [e.kind, e.replace, e.reason])).toEqual([
      ["published", true, "redacted"],
    ]);
    // The session is as it was: its pointer, and its old trace, which the entry's does not
    // replace (the new object went again).
    expect(await metadata("s1")).toEqual(before);
    const old = await getTrace(store, "alice", archive, before?.head as string);
    expect(JSON.stringify(old)).toContain("ACME-1234");
    const named = entries[0]?.entry.content_hash as string;
    expect(await getTrace(store, "alice", archive, named)).toBeNull();
    // The next run rewrites it, with an entry of its own.
    expect((await run()).outcomes).toMatchObject({ rewritten: 1 });
    expect((await readChanges(store, "alice", since)).entries).toHaveLength(2);
    expect((await metadata("s1"))?.head).toBe(named);
  });

  it("redacts the span records beside a stub (F3.4), which has no trace to redact", async () => {
    const oldRules = compileRuleSet();
    // A session whose first envelope review dropped: a stub, no trace.
    const dropping = new Pipeline({
      store,
      formats,
      reviewer: {
        review: async () => ({
          action: "drop",
          reason: "review_drop",
          policy: "p",
          policy_hash: "e".repeat(64),
          decision_model: "m",
        }),
      },
    });
    await dropping.submit(
      uploadEnvelope(
        {
          owner: "alice",
          agent: "trajectory",
          session_id: "s9",
          transcript: meta() + user(LONG) + reply("ok"),
          format: "jsonl",
          offset: 0,
        },
        { caller: { kind: "static", principal: "alice" }, owner_basis: "verified" },
      ),
    );
    const stub = archiveId("alice", "trajectory", "s9");
    expect(await readMetadata(store, "alice", stub)).toMatchObject({ traces: [] });
    await putSpan(store, "alice", stub, {
      received_at: ts,
      source_id: "console",
      format: "otlp-genai",
      part: {
        trace_id: "ef".repeat(16),
        span_id: "0000000000000001",
        name: "chat m",
        started_at: ts,
        content: true,
        output: [{ role: "assistant", content: "ACME-9999", timestamp: ts }],
      } as never,
      redaction: { rule_set: oldRules.hash, counts: {} },
    });

    const report = await run();
    expect(report.outcomes.skipped).toBe(1);
    expect(report.spans).toBe(1);
    expect(JSON.stringify(await listSpans(store, "alice", stub))).not.toContain("ACME-9999");
  });

  it("redacts the input messages span records share, and deletes the ones it replaced (22)", async () => {
    const oldRules = compileRuleSet();
    const archive = archiveId("alice", "otlp-genai", "sesn_history");
    const said = (role: "user" | "assistant", content: string) => ({
      role,
      content,
      timestamp: ts,
    });
    const history = [
      said("user", "hello there"),
      said("assistant", "the key is ACME-1234"),
      said("user", "thanks, and ACME-5678?"),
      said("assistant", "no"),
    ];
    const span = (n: number, input: unknown[], rules = oldRules) => ({
      received_at: ts,
      source_id: "console",
      format: "otlp-genai",
      part: {
        trace_id: "ef".repeat(16),
        span_id: n.toString(16).padStart(16, "0"),
        name: "chat m",
        started_at: ts,
        content: true,
        input,
        output: [said("assistant", `answer ${n}`)],
      } as never,
      redaction: { rule_set: rules.hash, counts: {} },
    });
    // Each call repeats the history so far: the messages are stored once each.
    await putSpan(store, "alice", archive, span(1, history.slice(0, 1)));
    await putSpan(store, "alice", archive, span(2, history.slice(0, 3)));
    // A record the new rules already wrote, sharing the first message.
    await putSpan(store, "alice", archive, span(3, [history[0], history[3]], NEW_RULES));
    const messages = async () => {
      const page = await store.list(keys.spanMessages("alice", archive));
      return Promise.all(
        page.keys.map(async (key) => new TextDecoder().decode((await store.get(key))?.body)),
      );
    };
    expect(await messages()).toHaveLength(4);
    expect((await messages()).filter((m) => m.includes("ACME-"))).toHaveLength(2);

    expect((await run({ dryRun: true })).spans).toBe(2);
    expect((await messages()).filter((m) => m.includes("ACME-"))).toHaveLength(2);

    expect((await run()).spans).toBe(2);
    // No message holds what the new rules take out: the two that did were replaced by their
    // redacted forms and deleted; the ones the rules leave alone are kept, once.
    const after = await messages();
    expect(after.join("\n")).not.toContain("ACME-");
    expect(after).toHaveLength(4);
    const records = await listSpans(store, "alice", archive);
    expect(
      records.map((r) => r.part.input?.map((m) => (m as { content?: unknown }).content)),
    ).toEqual([
      ["hello there"],
      ["hello there", "the key is [redacted:acme-key]", "thanks, and [redacted:acme-key]?"],
      ["hello there", "no"],
    ]);
    expect(records[1]?.redaction).toEqual({ rule_set: NEW_RULES.hash, counts: { "acme-key": 2 } });
    expect((await run()).spans).toBe(0);
  });

  it("keeps a replaced message that a span arriving during the pass still names (22)", async () => {
    const oldRules = compileRuleSet();
    const archive = archiveId("alice", "otlp-genai", "sesn_race");
    const secret = { role: "user", content: "the key is ACME-1234", timestamp: ts };
    const span = (n: number) => ({
      received_at: ts,
      source_id: "console",
      format: "otlp-genai",
      part: {
        trace_id: "ef".repeat(16),
        span_id: n.toString(16).padStart(16, "0"),
        name: "chat m",
        started_at: ts,
        content: true,
        input: [secret],
      } as never,
      redaction: { rule_set: oldRules.hash, counts: {} },
    });
    await putSpan(store, "alice", archive, span(1));
    // While backfill rewrites the first record, a server still on the old rules stores another
    // span naming the same (old) message.
    let raced = false;
    const racing: Store = {
      url: store.url,
      get: (k) => store.get(k),
      stat: (k) => store.stat(k),
      delete: (k, o) => store.delete(k, o),
      list: (p, o) => store.list(p, o),
      put: async (k, b, o) => {
        const done = await store.put(k, b, o);
        if (!raced && k.endsWith("0000000000000001.json")) {
          raced = true;
          await putSpan(store, "alice", archive, span(2));
        }
        return done;
      },
    };
    expect((await run({ store: racing })).spans).toBe(1);
    expect(raced).toBe(true);
    // The late record still reads: its message was not deleted under it.
    const records = await listSpans(store, "alice", archive);
    expect(
      records.map((r) => (r.part.input ?? [])[0]).map((m) => (m as { content?: string }).content),
    ).toEqual(["the key is [redacted:acme-key]", "the key is ACME-1234"]);
    // The next run redacts it, and then nothing names the old message.
    expect((await run()).spans).toBe(1);
    const page = await store.list(keys.spanMessages("alice", archive));
    expect(page.keys).toHaveLength(1);
    expect(JSON.stringify(await listSpans(store, "alice", archive))).not.toContain("ACME-");
  });

  it("tells each session as it is done", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    await store1("s2", meta() + user(LONG) + reply("ok"));
    const seen: string[] = [];
    await run({ onSession: (s) => seen.push(`${s.session_id}:${s.outcome}`) });
    expect(seen.sort()).toEqual(["s1:rewritten", "s2:unchanged"]);
  });
});
