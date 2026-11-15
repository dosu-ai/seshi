import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry, otlpGenAiFormat } from "@seshi/formats";
import {
  ENVELOPE_SCHEMA,
  type Envelope,
  type LlmCall,
  type NormalizedRecord,
  type SpanPart,
  type StoreSessionResult,
} from "@seshi/model";
import { type Redactor, redactLlmCalls, ruleRedactor } from "@seshi/redact";
import {
  archiveId,
  FsStore,
  keys,
  listRecords,
  listSpans,
  putSpan,
  readMetadata,
  readPending,
  touchPending,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTrace, listSessions, tombstone } from "./ingest";
import { Pipeline } from "./pipeline";
import { assemblePending, FINAL_GRACE_MS, redactSpanPart, SpanStore } from "./spans";
import { MemoryHealthCounters } from "./stages";

let dir: string;
let store: FsStore;
let clock: Date;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-spans-"));
  store = new FsStore(dir);
  clock = new Date("2026-11-01T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = () => clock;
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const formats = new FormatRegistry([...BUILTIN_FORMATS, otlpGenAiFormat()]);
const redactor = ruleRedactor();
const TOKEN = "ghp_abcdefghijklmnopqrstuvwx0123456789";
const OWNER = "svc:console";
const SESSION = "sesn_1";
const ARCHIVE = archiveId(OWNER, "otlp-genai", SESSION);
const QUIET = 10 * 60_000;

const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
const ns = (sec: number) =>
  (BigInt(Date.parse("2026-11-01T10:00:00Z") + sec * 1000) * 1_000_000n).toString();
const messages = (role: string, text: string) =>
  JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);
let spanCounter = 0;
function chat(input: string, output: string, extra: Record<string, unknown> = {}) {
  spanCounter++;
  return {
    traceId: "ab".repeat(16),
    spanId: spanCounter.toString(16).padStart(16, "0"),
    name: "chat m",
    startTimeUnixNano: ns(spanCounter * 10),
    endTimeUnixNano: ns(spanCounter * 10 + 5),
    attributes: [
      s("gen_ai.operation.name", "chat"),
      s("gen_ai.conversation.id", "conv"),
      s("gen_ai.input.messages", messages("user", input)),
      s("gen_ai.output.messages", messages("assistant", output)),
      { key: "gen_ai.usage.input_tokens", value: { intValue: 10 } },
    ],
    ...extra,
  };
}

function envelope(spans: unknown[], extra: Partial<Envelope> = {}): Envelope {
  return {
    schema: ENVELOPE_SCHEMA,
    source: "otlp",
    source_id: "console",
    format: "otlp-genai",
    session_key: SESSION,
    payload: { kind: "spans", spans: spans as Record<string, unknown>[] },
    caller: { kind: "service", principal: OWNER, credential_id: "tok1" },
    owner: OWNER,
    owner_basis: "service",
    idempotency_key: `batch-${spanCounter}`,
    received_at: clock.toISOString(),
    ...extra,
  };
}

function setup(options: { minChars?: number } = {}) {
  const assembler = new SpanStore({ store, now });
  const health = new MemoryHealthCounters();
  const pipeline = new Pipeline({
    store,
    formats,
    now,
    assembler,
    health,
    filter: {
      enabled: true,
      min_chars: options.minChars ?? 10,
      require_user: true,
      require_reply: true,
    },
  });
  const assemble = (extra: Partial<Parameters<typeof assemblePending>[0]> = {}) =>
    assemblePending({
      store,
      formats,
      publish: (session) => pipeline.publishAssembled(session),
      quietMs: () => QUIET,
      now,
      ...extra,
    });
  return { pipeline, assembler, health, assemble };
}

describe("redactLlmCalls (@seshi/redact) on span LLM calls", () => {
  it("redacts an LLM call's error and string parameters, and counts the matches", () => {
    const calls: LlmCall[] = [
      {
        id: "c1",
        model: "m",
        error: `bad key ${TOKEN}`,
        parameters: { stop: TOKEN, max_tokens: 5 },
      },
      { id: "c2" },
    ];
    const { calls: out, counts } = redactLlmCalls(redactor, calls);
    expect(out?.[0]?.error).toBe("bad key [redacted:github-token]");
    expect(out?.[0]?.parameters).toEqual({ stop: "[redacted:github-token]", max_tokens: 5 });
    expect(out?.[0]?.model).toBe("m");
    expect(out?.[1]).toEqual({ id: "c2" });
    expect(counts).toEqual({ "github-token": 2 });
    expect(calls[0]?.error).toContain(TOKEN);
    expect(redactLlmCalls(redactor, undefined).calls).toBeUndefined();
  });

  it("redacts through a redactor that has no redactText, as system records", () => {
    const recordsOnly: Redactor = {
      rule_set: redactor.rule_set,
      redact: (records, carried) => redactor.redact(records, carried),
    };
    const { calls, counts } = redactLlmCalls(recordsOnly, [
      { id: "c1", error: `bad key ${TOKEN}`, parameters: { stop: TOKEN } },
    ]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(counts).toEqual({ "github-token": 2 });
  });
});

describe("redactSpanPart", () => {
  const base: SpanPart = {
    trace_id: "t",
    span_id: "s",
    name: "x",
    started_at: "2026-11-01T10:00:00.000Z",
    content: true,
  };

  it("withholds the result of a tool call that reads a sensitive file", () => {
    const { part, summary } = redactSpanPart(redactor, {
      ...base,
      tool: {
        name: "Read",
        call_id: "c",
        args: JSON.stringify({ file_path: "/repo/.env" }),
        result: "A=1",
      },
    });
    expect(part.tool?.result).toBe("[redacted:sensitive-file]");
    expect(summary.counts["sensitive-file"]).toBe(1);
  });

  it("redacts secrets in records and the LLM call", () => {
    const record: NormalizedRecord = {
      role: "assistant",
      content: `use ${TOKEN}`,
      timestamp: base.started_at,
    };
    const { part, summary } = redactSpanPart(redactor, {
      ...base,
      output: [record],
      llm_call: { id: "c", error: TOKEN },
      tool: { name: "bash", args: `{"cmd":"echo ${TOKEN}"}` },
    });
    expect(JSON.stringify(part)).not.toContain(TOKEN);
    expect(part.tool?.result).toBeUndefined();
    expect(summary.counts["github-token"]).toBe(3);
  });
});

describe("span batches through the pipeline", () => {
  it("stores each span normalized and redacted, and touches the marker without the payload", async () => {
    const { pipeline } = setup();
    const result = await pipeline.submit(
      envelope([chat("hello", `here: ${TOKEN}`), { traceId: "nope", spanId: "x" }]),
    );
    expect(result).toEqual({ status: "accepted", archive_id: ARCHIVE, spans: 1, rejected: 1 });
    const records = await listSpans(store, OWNER, ARCHIVE);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(records[0]?.redaction?.counts).toEqual({ "github-token": 1 });
    expect(records[0]?.part.output?.[0]).toMatchObject({ role: "assistant" });
    const marker = await readPending(store, ARCHIVE);
    expect(marker?.value).toMatchObject({
      owner: OWNER,
      source_id: "console",
      touched_at: clock.toISOString(),
    });
    expect(marker?.value.envelope).not.toHaveProperty("payload");
    expect(marker?.value.final).toBeUndefined();
  });

  it("refuses a format without a span adapter, an empty batch and an unreadable one", async () => {
    const { pipeline } = setup();
    await expect(
      pipeline.submit(envelope([chat("a", "b")], { format: "trajectory" }), { onFailure: "throw" }),
    ).rejects.toMatchObject({ code: "unsupported_payload" });
    await expect(pipeline.submit(envelope([]), { onFailure: "throw" })).rejects.toMatchObject({
      code: "empty",
    });
    await expect(
      pipeline.submit(envelope([{ spanId: "x" }]), { onFailure: "throw" }),
    ).rejects.toMatchObject({ code: "bad_spans" });
    // With nobody waiting, a refusal is a failure record (X4.8).
    expect(await pipeline.submit(envelope([]))).toMatchObject({ status: "failed", code: "empty" });
    expect((await listRecords(store, "failed", "console")).records).toHaveLength(1);
  });

  it("leaves out a connector's span whose ids are not OTLP hex, rather than failing the batch", async () => {
    const { pipeline } = setup();
    // A poller builds ReceivedSpans itself (no readSpan): a bad id must not become a store
    // error, which the scheduler would retry forever.
    const bad = chat("q", "a", { traceId: "../../escape", spanId: "ZZZZ" });
    const upper = chat("q", "a", { traceId: "AB".repeat(16) });
    const result = await pipeline.submit(envelope([bad, upper, chat("hello", "there")]), {
      onFailure: "throw",
    });
    expect(result).toEqual({ status: "accepted", archive_id: ARCHIVE, spans: 1, rejected: 2 });
    expect(await listSpans(store, OWNER, ARCHIVE)).toHaveLength(1);
    await expect(pipeline.submit(envelope([bad]), { onFailure: "throw" })).rejects.toMatchObject({
      code: "bad_spans",
    });
  });

  it("marks the batch final when it holds the root span of a one-trace session", async () => {
    const { pipeline } = setup();
    const root = chat("q", "a");
    await pipeline.submit(envelope([root], { session_key: root.traceId }));
    const archive = archiveId(OWNER, "otlp-genai", root.traceId);
    expect((await readPending(store, archive))?.value.final).toBe(true);
    // A later batch without the root keeps it.
    await pipeline.submit(
      envelope([chat("q2", "a2", { parentSpanId: root.spanId })], { session_key: root.traceId }),
    );
    expect((await readPending(store, archive))?.value.final).toBe(true);
  });

  it("refuses spans for a deleted session", async () => {
    const { pipeline, assemble } = setup();
    await pipeline.submit(envelope([chat("first question", "first answer")]));
    later(QUIET);
    await assemble();
    await tombstone({ store, owner: OWNER, agent: "otlp-genai", session_id: SESSION, now });
    expect(await listSpans(store, OWNER, ARCHIVE)).toEqual([]);
    expect(await store.get(keys.pending(ARCHIVE))).toBeNull();
    await expect(
      pipeline.submit(envelope([chat("more", "spans")]), { onFailure: "throw" }),
    ).rejects.toMatchObject({ code: "redacted" });
    expect(await listSpans(store, OWNER, ARCHIVE)).toEqual([]);
  });

  it("deletes the span records of a session the filter refused, which has no metadata", async () => {
    // Review finding: tombstone returned before deleting spans when there was no metadata, so
    // a never-published session's span records could not be deleted at all.
    const { pipeline, assemble } = setup({ minChars: 100_000 });
    await pipeline.submit(envelope([chat("first question", "first answer")]));
    later(QUIET);
    expect(await assemble()).toMatchObject({ outcomes: { filtered: 1 } });
    expect(await readMetadata(store, OWNER, ARCHIVE)).toBeNull();
    expect(await listSpans(store, OWNER, ARCHIVE)).toHaveLength(1);
    const removed = await tombstone({
      store,
      owner: OWNER,
      agent: "otlp-genai",
      session_id: SESSION,
      now,
    });
    expect(removed).toEqual({ removed: 1 });
    expect(await listSpans(store, OWNER, ARCHIVE)).toEqual([]);
    expect(await store.get(keys.pending(ARCHIVE))).toBeNull();
    // Nothing left: a second delete finds no session.
    expect(
      await tombstone({ store, owner: OWNER, agent: "otlp-genai", session_id: SESSION, now }),
    ).toBeNull();
  });
});

describe("assemblePending", () => {
  it("waits out the quiet period, then publishes the session as its writer", async () => {
    const { pipeline, assemble, health } = setup();
    await pipeline.submit(envelope([chat("what is auth?", "a session token")]));
    later(QUIET - 1);
    expect(await assemble()).toMatchObject({ waiting: 1, published: 0 });
    later(1);
    const report = await assemble();
    expect(report).toMatchObject({ waiting: 0, published: 1, outcomes: { stored: 1 } });
    expect(await readPending(store, ARCHIVE)).toBeNull();
    const metadata = await readMetadata(store, OWNER, ARCHIVE);
    expect(metadata).toMatchObject({
      owner_basis: "service",
      writer: { kind: "service", principal: OWNER, source_id: "console", credential_id: "tok1" },
      provenance: { source: "otlp", source_id: "console", format: "otlp-genai" },
    });
    expect(health.counts.console).toEqual({ stored: 1 });
    // Nothing pending: a pass does nothing.
    expect(await assemble()).toMatchObject({ published: 0, waiting: 0 });
  });

  it("publishes shortly after a final span instead of the whole quiet period", async () => {
    const { pipeline, assemble } = setup();
    const root = chat("q", "an answer");
    await pipeline.submit(envelope([root], { session_key: root.traceId }));
    later(FINAL_GRACE_MS - 1);
    expect(await assemble()).toMatchObject({ waiting: 1 });
    later(1);
    expect(await assemble()).toMatchObject({ published: 1 });
  });

  it("keeps the marker of a session a batch touched while it was published", async () => {
    const { pipeline, assemble } = setup();
    await pipeline.submit(envelope([chat("what is auth?", "a session token")]));
    later(QUIET);
    const report = await assemble({
      publish: async (session) => {
        const answer = await pipeline.publishAssembled(session);
        await touchPending(store, OWNER, ARCHIVE, now, {
          envelope: session.envelope,
          source_id: "console",
        });
        return answer;
      },
    });
    expect(report).toMatchObject({ published: 1, retouched: 1 });
    expect(await readPending(store, ARCHIVE)).not.toBeNull();
  });

  it("records a permanent failure and clears the marker; keeps it on a transient one", async () => {
    const { pipeline, assemble } = setup();
    await pipeline.submit(envelope([chat("what is auth?", "a session token")]));
    later(QUIET);
    const failing = await assemble({
      publish: async () => {
        throw new Error("store down");
      },
    });
    expect(failing).toMatchObject({ errors: 1, published: 0 });
    expect(await readPending(store, ARCHIVE)).not.toBeNull();
    const errors: string[] = [];
    await assemble({
      publish: async () => {
        throw new Error("again");
      },
      onError: (archive, err) => errors.push(`${archive}: ${(err as Error).message}`),
    });
    expect(errors).toEqual([`${ARCHIVE}: again`]);
    const refused = await assemble({
      publish: async () => ({ status: "failed", code: "invalid", message: "x", record: "k" }),
    });
    expect(refused).toMatchObject({ failed: 1 });
    expect(await readPending(store, ARCHIVE)).toBeNull();
  });

  it("keeps the spans of a format this binary cannot assemble", async () => {
    const { pipeline } = setup();
    await pipeline.submit(envelope([chat("q", "a")]));
    later(QUIET);
    const errors: unknown[] = [];
    const report = await assemblePending({
      store,
      formats: new FormatRegistry(BUILTIN_FORMATS),
      publish: (session) => pipeline.publishAssembled(session),
      quietMs: () => QUIET,
      now,
      onError: (_archive, err) => errors.push(err),
    });
    expect(report.errors).toBe(1);
    expect(String(errors[0])).toContain("no span adapter");
    expect(await readPending(store, ARCHIVE)).not.toBeNull();
  });

  it("drops a marker that says nothing of its writer, and a deleted session's spans", async () => {
    const { pipeline, assemble } = setup();
    await touchPending(store, OWNER, ARCHIVE, now);
    expect(await assemble({ quietMs: () => 0 })).toMatchObject({ dropped: 1 });
    expect(await readPending(store, ARCHIVE)).toBeNull();

    // A batch that raced a deletion: it passed the check, then the session was deleted, then
    // its spans and marker landed.
    await pipeline.submit(envelope([chat("first question", "first answer")]));
    later(QUIET);
    await assemble();
    const kept = await listSpans(store, OWNER, ARCHIVE);
    await tombstone({ store, owner: OWNER, agent: "otlp-genai", session_id: SESSION, now });
    for (const record of kept) await putSpan(store, OWNER, ARCHIVE, record);
    const { payload: _payload, ...about } = envelope([]);
    await touchPending(store, OWNER, ARCHIVE, now, { envelope: about, source_id: "console" });
    later(QUIET);
    expect(await assemble()).toMatchObject({ dropped: 1 });
    expect(await listSpans(store, OWNER, ARCHIVE)).toEqual([]);
  });

  it("publishes at most limit sessions a pass and says there is more", async () => {
    const { pipeline, assemble } = setup();
    for (const key of ["s-a", "s-b", "s-c"]) {
      await pipeline.submit(envelope([chat(`question ${key}`, "answer")], { session_key: key }));
    }
    later(QUIET);
    expect(await assemble({ limit: 2 })).toMatchObject({ published: 2, more: true });
    expect(await assemble({ limit: 2 })).toMatchObject({ published: 1, more: false });
    const controller = new AbortController();
    controller.abort();
    await pipeline.submit(envelope([chat("late", "x")], { session_key: "s-d" }));
    later(QUIET);
    expect(await assemble({ signal: controller.signal })).toMatchObject({ published: 0 });
  });
});

describe("publishing an assembled session", () => {
  it("counts what the spans' arrival redacted, once, and extends the session with late spans", async () => {
    const { pipeline, assemble } = setup();
    await pipeline.submit(envelope([chat("q1", `a1 ${TOKEN}`)]));
    later(QUIET);
    await assemble();
    expect((await readMetadata(store, OWNER, ARCHIVE))?.redaction?.counts).toEqual({
      "github-token": 1,
    });

    await pipeline.submit(envelope([chat(JSON.stringify("x"), `a2 ${TOKEN}`)]));
    later(QUIET);
    await assemble();
    const metadata = await readMetadata(store, OWNER, ARCHIVE);
    expect(metadata?.traces).toHaveLength(2);
    expect(metadata?.redaction?.counts).toEqual({ "github-token": 2 });
  });

  it("stores an agent-only tail past the head even under a filter that refuses it alone", async () => {
    // The known gotcha: only a session's first trace is judged by the session filter.
    const { pipeline, assemble } = setup({ minChars: 30 });
    await pipeline.submit(envelope([chat("a question long enough", "and an answer to it")]));
    later(QUIET);
    expect(await assemble()).toMatchObject({ outcomes: { stored: 1 } });
    const tail = chat("", "ok");
    tail.attributes = tail.attributes.filter((a) => a.key !== "gen_ai.input.messages");
    await pipeline.submit(envelope([tail]));
    later(QUIET);
    expect(await assemble()).toMatchObject({ outcomes: { stored: 1 } });
    const metadata = await readMetadata(store, OWNER, ARCHIVE);
    expect(metadata?.traces).toHaveLength(2);
  });

  it("redacts a span's LLM call error on arrival and counts it once in the session (07)", async () => {
    const { pipeline, assemble } = setup();
    const failed = chat("what is auth?", "a session token", {
      status: { code: 2, message: `401: key ${TOKEN} revoked` },
    });
    await pipeline.submit(envelope([failed]));
    const [record] = await listSpans(store, OWNER, ARCHIVE);
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(record?.part.llm_call?.error).toContain("[redacted:github-token]");
    expect(record?.redaction).toEqual({
      rule_set: redactor.rule_set,
      counts: { "github-token": 1 },
    });
    later(QUIET);
    await assemble();
    const metadata = await readMetadata(store, OWNER, ARCHIVE);
    const trace = await getTrace(store, OWNER, ARCHIVE, metadata?.head as string);
    expect(trace?.llm_calls?.[0]?.error).toBe("401: key [redacted:github-token] revoked");
    expect(JSON.stringify(trace)).not.toContain(TOKEN);
    // Counted when the span arrived; the publish pass finds the marker, not the token.
    expect(metadata?.redaction?.counts).toEqual({ "github-token": 1 });
  });

  it("redacts an LLM call's free text before it is written", async () => {
    const { pipeline } = setup();
    const records: NormalizedRecord[] = [
      { role: "meta", source: "otlp-genai" },
      { role: "user", content: "a question here", timestamp: clock.toISOString() },
      {
        role: "assistant",
        content: "an answer",
        timestamp: clock.toISOString(),
        llm_call: "c1",
      } as NormalizedRecord,
    ];
    const answer = (await pipeline.publishAssembled({
      envelope: envelope([]),
      records,
      llm_calls: [{ id: "c1", error: `failed with ${TOKEN}` }],
    })) as StoreSessionResult & { content_hash: string };
    expect(answer.status).toBe("stored");
    const trace = await getTrace(store, OWNER, ARCHIVE, answer.content_hash);
    expect(trace?.llm_calls?.[0]?.error).toBe("failed with [redacted:github-token]");
    expect((await readMetadata(store, OWNER, ARCHIVE))?.redaction?.counts).toEqual({
      "github-token": 1,
    });
  });
});

describe("listing a service account's sessions", () => {
  it("steps over span records instead of paging through them", async () => {
    const { pipeline, assemble } = setup();
    // Session A has many spans; session B a few. Neither may hide behind A's span records.
    const many = Array.from({ length: 40 }, (_, i) => chat(`question ${i}`, `answer ${i}`));
    await pipeline.submit(envelope(many, { session_key: "s-a" }));
    await pipeline.submit(envelope([chat("question b", "answer b")], { session_key: "s-b" }));
    later(QUIET);
    await assemble();
    const found: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listSessions(store, OWNER, { startAfter: after, limit: 2 });
      pages++;
      found.push(...page.sessions.map((m) => m.session_id));
      if (!page.truncated) break;
      after = page.cursor;
    }
    expect(found.sort()).toEqual(["s-a", "s-b"]);
    // Each session's metadata and trace: a handful of pages, not one per two span records.
    expect(pages).toBeLessThan(8);
    expect(await listSpans(store, OWNER, archiveId(OWNER, "otlp-genai", "s-a"))).toHaveLength(40);
  });
});
