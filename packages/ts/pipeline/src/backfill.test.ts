import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { StoreSessionResult, Writer } from "@seshi/model";
import { compileRuleSet, type RuleSet, ruleRedactor, validatePack } from "@seshi/redact";
import {
  archiveId,
  FsStore,
  keys,
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
): Promise<StoreSessionResult> {
  const pipeline = new Pipeline({ store, formats, redaction: rules });
  return (await pipeline.submit(
    uploadEnvelope(
      { owner, agent: "trajectory", session_id: sessionId, transcript, format: "jsonl", offset },
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
      { content_hash: hash, created_at: "2030-01-01T12:00:00.000Z", records: 5 },
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

  it("only records the rule set on a session with nothing new to take out", async () => {
    await store1("s1", meta() + user(LONG) + reply("ok"));
    const before = await metadata("s1");
    const report = await run();
    expect(report.outcomes).toMatchObject({ unchanged: 1 });
    const after = await metadata("s1");
    expect(after?.head).toBe(before?.head);
    expect(after?.traces).toEqual(before?.traces);
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

  it("tells each session as it is done", async () => {
    await store1("s1", meta() + user(`ACME-1234 ${LONG}`) + reply("ok"));
    await store1("s2", meta() + user(LONG) + reply("ok"));
    const seen: string[] = [];
    await run({ onSession: (s) => seen.push(`${s.session_id}:${s.outcome}`) });
    expect(seen.sort()).toEqual(["s1:rewritten", "s2:unchanged"]);
  });
});
