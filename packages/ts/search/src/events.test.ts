import { gzipSync } from "node:zlib";
import type { SessionMetadata, Trace, TraceEvent } from "@seshi/model";
import { keys, type Store } from "@seshi/store";
import { describe, expect, it } from "vitest";
import { readSessionEvents, SessionReadError, TraceCache } from "./events";

const H = (n: number) => n.toString(16).repeat(64);
const ARCHIVE = "a".repeat(64);

/** A store holding these traces of alice's session, counting reads. */
function storeOf(traces: Record<string, Partial<Trace>>): Store & { reads: string[] } {
  const reads: string[] = [];
  const objects = new Map<string, Uint8Array>();
  for (const [hash, trace] of Object.entries(traces)) {
    const whole = {
      schema: "seshi/trace/1",
      content_hash: hash,
      source: "claude-code",
      format: "claude-code",
      session_id: "s1",
      started_at: null,
      ended_at: null,
      records: [],
      events: [],
      metadata: {},
      ...trace,
    };
    objects.set(keys.trace("alice", ARCHIVE, hash), gzipSync(JSON.stringify(whole)));
  }
  return {
    url: "memory://",
    reads,
    async get(key: string) {
      reads.push(key);
      const body = objects.get(key);
      return body === undefined ? null : { body, etag: "e" };
    },
    put: async () => ({ etag: "e" }),
    stat: async () => null,
    delete: async () => {},
    list: async () => ({ keys: [], truncated: false }),
  } as unknown as Store & { reads: string[] };
}

const ev = (
  index: number,
  role: TraceEvent["role"],
  text: string,
  extra: Partial<TraceEvent> = {},
) =>
  ({
    index,
    role,
    text,
    timestamp: `2026-11-25T10:00:${String(index).padStart(2, "0")}Z`,
    ...extra,
  }) as TraceEvent;

function metadata(
  traces: { hash: string; continuation?: boolean }[],
  extra: Partial<SessionMetadata> = {},
) {
  return {
    schema: "seshi/metadata/1",
    owner: "alice",
    archive_id: ARCHIVE,
    session_id: "s1",
    format: "claude-code",
    source: "claude-code",
    repo: "github.com/acme/app",
    branch: "main",
    status: "stored",
    head: traces.at(-1)?.hash,
    traces: traces.map((t) => ({
      content_hash: t.hash,
      created_at: "2026-11-25T10:00:00Z",
      ...(t.continuation ? { continuation: { from_record: 3, prefix_sha256: H(9) } } : {}),
    })),
    writer: { kind: "user", principal: "alice", source_id: "upload" },
    owner_basis: "verified",
    visibility: "org",
    created_at: "2026-11-25T10:00:00Z",
    updated_at: "2026-11-25T10:30:00Z",
    ...extra,
  } as unknown as SessionMetadata;
}

const long = "x".repeat(5_000);

/** An old replaced trace, then the chain: a whole upload of 4 events and a continuation of 3. */
function session() {
  const store = storeOf({
    [H(1)]: { events: [ev(0, "user", "replaced away")] },
    [H(2)]: {
      started_at: "2026-11-25T10:00:00Z",
      ended_at: "2026-11-25T10:00:03Z",
      events: [
        ev(0, "user", "run the tests"),
        ev(1, "tool_call", "Bash bun test", { tool_name: "Bash", tool_call_id: "c1" }),
        ev(2, "tool_result", `FAIL ${long}`, { tool_name: "Bash", tool_call_id: "c1", ok: false }),
        ev(3, "assistant", "one failed"),
      ],
      llm_calls: [
        { id: "l1", model: "opus", usage: { input_tokens: 10, output_tokens: 5 } },
        { id: "l2", model: "haiku", usage: { input_tokens: 1, cache_read_input_tokens: 7 } },
      ],
    },
    [H(3)]: {
      started_at: "2026-11-25T10:05:00Z",
      ended_at: "2026-11-25T10:05:02Z",
      events: [
        ev(0, "user", "fix it"),
        ev(1, "reasoning", "thinking"),
        ev(2, "assistant", "fixed"),
      ],
      llm_calls: [{ id: "l1", model: "opus", usage: { output_tokens: 3 } }],
    },
  });
  const meta = metadata([{ hash: H(1) }, { hash: H(2) }, { hash: H(3), continuation: true }]);
  // H(1) was replaced by H(2): only H(2) and its continuation are the chain.
  return { store, meta };
}

async function read(
  request: Parameters<typeof readSessionEvents>[0]["request"],
  cache?: TraceCache,
) {
  const { store, meta } = session();
  return readSessionEvents({
    store,
    folder: "alice",
    metadata: meta,
    request,
    ...(cache ? { cache } : {}),
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SessionReadError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("not refused");
}

describe("read_session's events", () => {
  it("numbers the chain's events by seq across its traces, with the session's header", async () => {
    const got = await read({});
    expect(got.events.map((e) => [e.seq, e.role, e.content_hash, e.event_index])).toEqual([
      [0, "user", H(2), 0],
      [1, "tool_call", H(2), 1],
      [2, "tool_result", H(2), 2],
      [3, "assistant", H(2), 3],
      [4, "user", H(3), 0],
      [5, "reasoning", H(3), 1],
      [6, "assistant", H(3), 2],
    ]);
    expect(got.session).toMatchObject({
      owner: "alice",
      archive_id: ARCHIVE,
      format: "claude-code",
      repo: "github.com/acme/app",
      branch: "main",
      head: H(3),
      traces: 2,
      events: 7,
      started_at: "2026-11-25T10:00:00.000Z",
      ended_at: "2026-11-25T10:05:02.000Z",
      models: ["opus", "haiku"],
      llm_calls: 3,
      tokens: {
        input_tokens: 11,
        output_tokens: 8,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
      },
    });
    expect(got).toMatchObject({ mode: "condensed", from: 0, to: 7 });
    expect(got.next).toBeUndefined();
  });

  it("cuts tool results in condensed mode and gives them whole in full", async () => {
    const condensed = (await read({ from: 2, to: 3 })).events[0];
    expect(condensed).toMatchObject({ seq: 2, ok: false, tool_name: "Bash", chars: 5_005 });
    expect(condensed?.text).toHaveLength(200);
    expect(condensed?.cut).toBe(4_805);
    const full = (await read({ from: 2, to: 3, mode: "full" })).events[0];
    expect(full?.text).toHaveLength(5_005);
    expect(full?.cut).toBeUndefined();
  });

  it("reads a range, the events around one, and only some roles", async () => {
    const range = await read({ from: 3, to: 5 });
    expect(range.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(range.next).toBe(5);
    const around = await read({ around: 4, context: 1 });
    expect(around).toMatchObject({ from: 3, to: 6, next: 6 });
    expect(around.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    const edge = await read({ around: 0, context: 5 });
    expect(edge).toMatchObject({ from: 0, to: 6 });
    // A client that fills in the schema's defaults sends context with a range: it is ignored.
    expect((await read({ from: 3, to: 5, context: 5 })).events.map((e) => e.seq)).toEqual([3, 4]);
    const users = await read({ roles: ["user"] });
    expect(users.events.map((e) => e.seq)).toEqual([0, 4]);
    expect((await read({ from: 9 })).events).toEqual([]);
  });

  it("stops at max_chars on an event boundary, or cuts the first event, and says where next", async () => {
    const full = await read({ mode: "full", max_chars: 1_000 });
    // The tool result does not fit in what is left, and too little is left to be worth a piece.
    expect(full.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(full.next).toBe(2);
    const first = await read({ mode: "full", from: 2, max_chars: 1_000 });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ seq: 2, cut: 4_005 });
    expect(first.events[0]?.text).toHaveLength(1_000);
    expect(first.next).toBe(3);
    // A piece after small events when much is left.
    const piece = await read({ mode: "full", max_chars: 3_000 });
    expect(piece.events.map((e) => [e.seq, e.cut])).toEqual([
      [0, undefined],
      [1, undefined],
      [2, 5_005 - (3_000 - "run the tests".length - "Bash bun test".length)],
    ]);
    expect(piece.next).toBe(3);
  });

  it("reads one long event in pieces", async () => {
    const one = await read({ event: 2, max_chars: 2_000 });
    expect(one).toMatchObject({ from: 2, to: 3, next_offset: 2_000, next: 3 });
    expect(one.events[0]).toMatchObject({ seq: 2, offset: 0, cut: 3_005 });
    const last = await read({ event: 2, offset: 4_000, max_chars: 2_000 });
    expect(last.events[0]?.text).toHaveLength(1_005);
    expect(last.next_offset).toBeUndefined();
    expect(last.events[0]?.cut).toBeUndefined();
  });

  it("refuses bad requests, a changed head, a redacted session and a missing trace", async () => {
    for (const request of [
      { from: 3, to: 2 },
      { from: 1, around: 2 },
      { event: 1, from: 0 },
      { offset: 3 },
      { around: 7 },
      { event: 7 },
      { max_chars: 999 },
      { mode: "short" as never },
      { roles: ["tool"] as never },
      { from: -1 },
      { head: "abc" },
    ]) {
      expect({ request, refused: await refusal(read(request)) }).toMatchObject({
        request,
        refused: { status: 400, code: "bad_query" },
      });
    }
    expect(await refusal(read({ head: H(2) }))).toEqual({ status: 409, code: "head_changed" });
    expect((await read({ head: H(3) })).session.head).toBe(H(3));
    const { store, meta } = session();
    expect(
      await refusal(
        readSessionEvents({
          store,
          folder: "alice",
          metadata: { ...meta, status: "redacted" },
          request: {},
        }),
      ),
    ).toEqual({ status: 410, code: "redacted" });
    const missing = metadata([{ hash: H(4) }]);
    expect(
      await refusal(readSessionEvents({ store, folder: "alice", metadata: missing, request: {} })),
    ).toEqual({ status: 404, code: "no_trace" });
  });

  it("keeps decoded traces, keyed by session, hash and rule set", async () => {
    const { store, meta } = session();
    const cache = new TraceCache(4);
    await readSessionEvents({ store, folder: "alice", metadata: meta, request: {}, cache });
    await readSessionEvents({
      store,
      folder: "alice",
      metadata: meta,
      request: { from: 4 },
      cache,
    });
    expect(store.reads).toHaveLength(2);
    // A backfill redacted the traces again in place: read afresh.
    const redacted = { ...meta, redaction: { rule_set: "r2", counts: {} } } as SessionMetadata;
    await readSessionEvents({ store, folder: "alice", metadata: redacted, request: {}, cache });
    expect(store.reads).toHaveLength(4);
    expect(cache.size).toBe(4);
  });

  it("keeps no more characters of event text than its budget, least recently used going first", async () => {
    const { store, meta } = session();
    // The two traces hold 5,041 and 19 characters of event text.
    const cache = new TraceCache(32, 6_000);
    await readSessionEvents({ store, folder: "alice", metadata: meta, request: {}, cache });
    expect(cache.size).toBe(2);
    expect(cache.chars).toBe(5_060);
    const small = new TraceCache(32, 100);
    await readSessionEvents({ store, folder: "alice", metadata: meta, request: {}, cache: small });
    // The large trace alone is over the budget: only the small one is kept.
    expect(small.size).toBe(1);
    expect(small.chars).toBe(19);
  });
});
