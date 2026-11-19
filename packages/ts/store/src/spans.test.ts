import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord, SpanPart } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStore } from "./check";
import { FsStore } from "./fs";
import { archiveId, keys } from "./layout";
import { ensureLayout } from "./marker";
import {
  deleteSpans,
  listSpanKeys,
  listSpanMessages,
  listSpans,
  MissingSpanMessage,
  putSpan,
  putSpans,
  type SpanRecord,
  storedInputOf,
} from "./spans";
import { getBytes, type Store } from "./store";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-span-store-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "svc:console";
const ARCHIVE = archiveId(OWNER, "otlp-genai", "sesn_1");
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, n)).toISOString();
const user = (n: number, time = at(n)): NormalizedRecord => ({
  role: "user",
  content: `question ${n} ${"x".repeat(200)}`,
  timestamp: time,
});
const reply = (n: number, time = at(n)): NormalizedRecord => ({
  role: "assistant",
  content: `answer ${n} ${"y".repeat(200)}`,
  timestamp: time,
});

/** A conversation of `calls` chat calls, each span's input repeating the whole history (as
 * exporters send it), its output the new answer. */
function conversation(calls: number): Omit<SpanRecord, "schema">[] {
  const out: Omit<SpanRecord, "schema">[] = [];
  const history: NormalizedRecord[] = [];
  for (let i = 0; i < calls; i++) {
    history.push(user(i));
    const started = at(i);
    const part: SpanPart = {
      trace_id: "ab".repeat(16),
      span_id: (i + 1).toString(16).padStart(16, "0"),
      name: "chat m",
      started_at: started,
      content: true,
      // Every record of a span's input carries the span's start, as the GenAI reader does.
      input: history.map((r) => ({ ...r, timestamp: started })),
      output: [reply(i)],
    };
    history.push(reply(i));
    out.push({
      received_at: at(i),
      source_id: "console",
      format: "otlp-genai",
      part,
      redaction: { rule_set: "r1", counts: {} },
    });
  }
  return out;
}

/** Every object under `prefix`, with its bytes. */
async function objects(prefix: string, from: Store = store) {
  const page = await from.list(prefix, { limit: 100_000 });
  return Promise.all(
    page.keys.map(async (key) => ({
      key,
      text: new TextDecoder().decode((await getBytes(from, key)) as Uint8Array),
    })),
  );
}

describe("span history stored once (F4.4)", () => {
  it("stores each input message once: N calls make O(N) messages, not O(N²) copies", async () => {
    const calls = 30;
    for (const record of conversation(calls)) await putSpan(store, OWNER, ARCHIVE, record);
    // One message per user turn and per answer the history repeats: 2N - 1, however many
    // spans repeat them.
    const messages = await listSpanMessages(store, OWNER, ARCHIVE);
    expect(messages.size).toBe(2 * calls - 1);
    expect(await listSpanKeys(store, OWNER, ARCHIVE)).toHaveLength(calls);
    // A span record names its history by hash and holds none of its text.
    const records = await objects(keys.spans(OWNER, ARCHIVE));
    const last = records.find((o) =>
      o.key.endsWith(`${calls.toString(16).padStart(16, "0")}.json`),
    );
    expect(last?.text).not.toContain("question 0 ");
    const stored = JSON.parse(last?.text as string) as SpanRecord;
    expect(stored.part.input).toBeUndefined();
    expect(stored.input?.messages).toHaveLength(2 * calls - 1);
    // Bytes: the history once, plus 64 hex characters per record per message it names.
    const total = records.reduce((n, o) => n + o.text.length, 0);
    expect(total).toBeLessThan(calls * 2 * 300 + calls * calls * 2 * 70 + calls * 1000);
    // Each message is the record with its time emptied, under the hash of those bytes.
    const message = (await objects(keys.spanMessages(OWNER, ARCHIVE)))[0];
    expect(JSON.parse(message?.text as string)).toMatchObject({ timestamp: "" });
  });

  it("reads every part back as written, each input record exactly: values, times, key order", async () => {
    const written = conversation(6);
    // A record whose time differs from the rest of its input, one with no time, a reasoning
    // record, a withheld tool result, and a record whose fields come in another order.
    const mixed = written[5]?.part as SpanPart;
    mixed.input = [
      ...(mixed.input ?? []),
      { role: "reasoning", content: "thinking", timestamp: at(99) },
      { role: "user", content: "no time" } as unknown as NormalizedRecord,
      {
        role: "tool",
        tool_call_id: "c1",
        content: "[redacted:sensitive-file]",
        timestamp: at(5),
        withheld: "sensitive-file",
      } as unknown as NormalizedRecord,
      { timestamp: at(5), content: "order", role: "user" } as unknown as NormalizedRecord,
    ];
    await putSpans(store, OWNER, ARCHIVE, written);
    const read = await listSpans(store, OWNER, ARCHIVE);
    expect(read).toHaveLength(6);
    for (const [i, record] of read.entries()) {
      const expected = JSON.parse(JSON.stringify({ schema: "seshi/span/1", ...written[i] }));
      expect(record).toEqual(expected);
      expect(JSON.stringify(record.part.input)).toBe(JSON.stringify(written[i]?.part.input));
      expect(record.input).toBeUndefined();
    }
  });

  it("gives each read of a part's input its own records", async () => {
    await putSpans(store, OWNER, ARCHIVE, conversation(2));
    const [, second] = await listSpans(store, OWNER, ARCHIVE);
    const first = second?.part.input as NormalizedRecord[];
    (first[0] as { llm_call?: string }).llm_call = "changed";
    expect(second?.part.input?.[0]).not.toHaveProperty("llm_call");
    // And a part can still be given a new input.
    (second as SpanRecord).part.input = [];
    expect(second?.part.input).toEqual([]);
  });

  it("writes only the messages the session does not hold yet", async () => {
    const calls = conversation(4);
    await putSpans(store, OWNER, ARCHIVE, calls.slice(0, 3));
    const puts: string[] = [];
    const counting: Store = {
      url: store.url,
      get: (k) => store.get(k),
      stat: (k) => store.stat(k),
      delete: (k, o) => store.delete(k, o),
      list: (p, o) => store.list(p, o),
      put: (k, b, o) => {
        puts.push(k);
        return store.put(k, b, o);
      },
    };
    await putSpans(counting, OWNER, ARCHIVE, calls.slice(3));
    // The fourth call's input repeats five stored messages and adds two (the third answer,
    // which only outputs held so far, and the new question): two messages and the record.
    expect(puts.filter((k) => k.includes("/spans/messages/"))).toHaveLength(2);
    expect(puts.filter((k) => !k.includes("/spans/messages/"))).toHaveLength(1);
  });

  it("reads each message once however many records name it", async () => {
    await putSpans(store, OWNER, ARCHIVE, conversation(20));
    const gets: string[] = [];
    const counting: Store = {
      url: store.url,
      get: (k) => {
        gets.push(k);
        return store.get(k);
      },
      stat: (k) => store.stat(k),
      delete: (k, o) => store.delete(k, o),
      list: (p, o) => store.list(p, o),
      put: (k, b, o) => store.put(k, b, o),
    };
    const records = await listSpans(counting, OWNER, ARCHIVE);
    for (const record of records) expect(record.part.input?.length).toBeGreaterThan(0);
    expect(gets.filter((k) => k.includes("/spans/messages/"))).toHaveLength(39);
    expect(gets.filter((k) => !k.includes("/spans/messages/"))).toHaveLength(20);
  });

  it("deletes the messages with the span records, counting the records", async () => {
    await putSpans(store, OWNER, ARCHIVE, conversation(5));
    expect(await deleteSpans(store, OWNER, ARCHIVE)).toBe(5);
    expect(await objects(keys.spans(OWNER, ARCHIVE))).toEqual([]);
  });

  it("refuses to rebuild an input whose message is gone", async () => {
    await putSpans(store, OWNER, ARCHIVE, conversation(2));
    const [first] = await listSpanMessages(store, OWNER, ARCHIVE);
    await store.delete(keys.spanMessage(OWNER, ARCHIVE, first as string));
    await expect(listSpans(store, OWNER, ARCHIVE)).rejects.toBeInstanceOf(MissingSpanMessage);
  });

  it("keeps a span without input as it was", async () => {
    const [record] = conversation(1);
    const { input: _input, ...part } = (record as SpanRecord).part;
    await putSpan(store, OWNER, ARCHIVE, { ...(record as SpanRecord), part });
    expect(await listSpanMessages(store, OWNER, ARCHIVE)).toEqual(new Set());
    const [read] = await listSpans(store, OWNER, ARCHIVE);
    expect(read?.part).toEqual(part);
    expect(Object.hasOwn(read?.part ?? {}, "input")).toBe(false);
  });
});

describe("the store's hidden ordering", () => {
  const HEX = "0123456789abcdef";
  /** A span record at `traceId`/`spanId` whose input is one stored message. */
  const at_ = (traceId: string, spanId: string, n: number): Omit<SpanRecord, "schema"> => ({
    received_at: at(n),
    source_id: "console",
    format: "otlp-genai",
    part: {
      trace_id: traceId,
      span_id: spanId,
      name: "chat m",
      started_at: at(n),
      content: true,
      input: [user(n)],
    },
  });
  /** `store`, listing at most `limit` keys a page. */
  const paging = (limit: number): Store => ({
    url: store.url,
    get: (k) => store.get(k),
    stat: (k) => store.stat(k),
    delete: (k, o) => store.delete(k, o),
    put: (k, b, o) => store.put(k, b, o),
    list: (p, o) => store.list(p, { ...o, limit: Math.min(o?.limit ?? limit, limit) }),
  });

  it("keeps messages/ after every span id, lowest to highest, so listing spans/ stops there", async () => {
    const ids: [string, string][] = [
      ["0", "0"],
      ...[...HEX].map((c): [string, string] => [c.repeat(32), c.repeat(16)]),
      ["f".repeat(32), "f".repeat(16)],
    ];
    for (const [traceId, spanId] of ids) {
      expect(keys.span(OWNER, ARCHIVE, traceId, spanId) < keys.spanMessages(OWNER, ARCHIVE)).toBe(
        true,
      );
    }
    await putSpans(
      store,
      OWNER,
      ARCHIVE,
      ids.slice(0, -1).map(([t, s], n) => at_(t, s, n)),
    );
    const wanted = [...new Set(ids.map(([t, s]) => keys.span(OWNER, ARCHIVE, t, s)))].sort();
    expect((await listSpanMessages(store, OWNER, ARCHIVE)).size).toBe(ids.length - 1);
    const small = paging(2);
    expect(await listSpanKeys(small, OWNER, ARCHIVE)).toEqual(wanted);
    expect(await listSpans(small, OWNER, ARCHIVE)).toHaveLength(wanted.length);
    expect(await deleteSpans(small, OWNER, ARCHIVE)).toBe(wanted.length);
    expect(await objects(keys.spans(OWNER, ARCHIVE))).toEqual([]);
  });

  it("names a message by its content, not its time", () => {
    const hashOf = (record: NormalizedRecord) => {
      const { input } = storedInputOf([record]);
      const [ref] = input.messages;
      return typeof ref === "string" ? ref : ref?.[0];
    };
    const early = hashOf(user(1, at(1)));
    expect(hashOf(user(1, at(50)))).toBe(early);
    expect(hashOf(user(2, at(1)))).not.toBe(early);
    expect(hashOf({ role: "user", content: "q", timestamp: at(1) })).toBe(
      hashOf({ role: "user", content: "q", timestamp: at(2) }),
    );
    // The stored bytes keep the time in its place, emptied: the same bytes, and so the same
    // key, as every message already stored.
    const { messages } = storedInputOf([
      { role: "user", timestamp: at(1), content: "q" } as unknown as NormalizedRecord,
    ]);
    const [[hash, bytes]] = [...messages] as [[string, Uint8Array]];
    expect(new TextDecoder().decode(bytes)).toBe('{"role":"user","timestamp":"","content":"q"}');
    expect(hash).toBe("4df24278f06639ba7123255f732445456a52f847beec1c2732a4921418a26f11");
  });

  it("deletes span records before their messages, so a crash between leaves nothing live broken", async () => {
    await ensureLayout(store, { createdBy: "test" });
    await putSpans(store, OWNER, ARCHIVE, conversation(4));
    const messagesPrefix = keys.spanMessages(OWNER, ARCHIVE);
    // The first delete of the second kind (records or messages, whichever goes second) fails.
    let first: boolean | undefined;
    const crashing: Store = {
      url: store.url,
      get: (k) => store.get(k),
      stat: (k) => store.stat(k),
      list: (p, o) => store.list(p, o),
      put: (k, b, o) => store.put(k, b, o),
      delete: async (k, o) => {
        const isMessage = k.startsWith(messagesPrefix);
        first ??= isMessage;
        if (isMessage !== first) throw new Error("crashed between the two kinds");
        return store.delete(k, o);
      },
    };
    await expect(deleteSpans(crashing, OWNER, ARCHIVE)).rejects.toThrow(/crashed/);
    // What is left is messages no record names: a reader sees no spans, and the check calls
    // nothing missing.
    expect(await listSpanKeys(store, OWNER, ARCHIVE)).toEqual([]);
    expect(await listSpans(store, OWNER, ARCHIVE)).toEqual([]);
    const report = await checkStore(store, { sessions: [{ owner: OWNER, archive_id: ARCHIVE }] });
    expect(report.findings.filter((f) => f.code === "span_message_missing")).toEqual([]);
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("would leave records naming messages that are gone, had it deleted the messages first", async () => {
    await putSpans(store, OWNER, ARCHIVE, conversation(4));
    for (const hash of await listSpanMessages(store, OWNER, ARCHIVE)) {
      await store.delete(keys.spanMessage(OWNER, ARCHIVE, hash));
    }
    await expect(listSpans(store, OWNER, ARCHIVE)).rejects.toBeInstanceOf(MissingSpanMessage);
    const report = await checkStore(store, { sessions: [{ owner: OWNER, archive_id: ARCHIVE }] });
    expect(report.findings.map((f) => f.code)).toContain("span_message_missing");
  });
});
