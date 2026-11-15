/** The span store (F4.4, X6.3): one object per span under the session's folder,
 * `owners/<owner>/sessions/<archive_id>/spans/<trace_id>-<span_id>.json`. Each holds the span's
 * part of the session, normalized and regex-redacted on arrival, never the span as received.
 * A span sent twice lands on the same key, so repeats are removed by trace and span id. The
 * records stay after the session is published, so a late span can rebuild it; they are never
 * readable through the API, and deleting the session deletes them. Code-first: only the binary
 * reads them (X3.10).
 *
 * History stored once (F4.4, revised 15 Nov 2026). A chat span's input repeats the conversation
 * so far, so copying it into every record made a session's records grow with the square of its
 * calls. Each input record is instead stored once per session as a message,
 * `spans/messages/<sha256>.json`, keyed by the SHA-256 of its bytes: the record as redaction left
 * it, with its `timestamp` emptied (`""`), since every span gives its input its own time. A span
 * record keeps `input`: the time (`at`) and the hashes of its messages in order, an entry
 * `[hash, time]` for a message whose time is not `at`. Reading puts the times back, so a part
 * reads exactly as it was written. Messages are written before the record that names them.
 *
 * Reading streams: `listSpans` reads records a page at a time, keeps each part without its
 * input, reads every message the records name once, and gives each part an `input` that is
 * rebuilt from them when read. Memory is the records' hashes plus each message once, not each
 * record's copy of the history. */

import { createHash } from "node:crypto";
import type { NormalizedRecord, RedactionSummary, SpanPart } from "@seshi/model";
import { keys } from "./layout";
import type { Store } from "./store";
import { getBytes, StoreError } from "./store";

export const SPAN_SCHEMA = "seshi/span/1" as const;

/** One entry of a stored input: a message's hash, or the hash and the record's own time when
 * it is not the input's `at`. */
export type StoredMessageRef = string | [hash: string, timestamp: string];

/** A part's input as a span record stores it: the messages it is made of, in order. */
export interface StoredInput {
  /** The time of the input's records (their `timestamp`), unless an entry gives its own. */
  at?: string;
  messages: StoredMessageRef[];
}

export interface SpanRecord {
  schema: typeof SPAN_SCHEMA;
  /** When the batch that carried it arrived. */
  received_at: string;
  /** The source it came from (an OTLP destination, a poller). */
  source_id: string;
  /** The span format that normalized it (`otlp-genai`). */
  format: string;
  /** The span's part. Stored without `input` (see `input`); `listSpans` gives it back. */
  part: SpanPart;
  /** The part's input as references to the session's stored messages. Only at rest:
   * `listSpans` resolves it into `part.input` and leaves this out. */
  input?: StoredInput;
  /** What regex redaction did to this span on arrival (rule set and counts, F2.3). */
  redaction?: RedactionSummary;
}

/** A span record named a message the store does not hold (deleted underneath it). A
 * `StoreError`, so the assembler keeps the session's marker and tries again later. */
export class MissingSpanMessage extends StoreError {
  constructor(readonly hash: string) {
    super(`span message ${hash} is missing`);
    this.name = "MissingSpanMessage";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A record's message: its bytes (with a string `timestamp` emptied), their hash, and the time
 * taken out. */
function messageOf(record: NormalizedRecord): { hash: string; bytes: Uint8Array; time?: string } {
  const value = record as unknown as Record<string, unknown>;
  const time = typeof value.timestamp === "string" ? value.timestamp : undefined;
  // Spread keeps the key order, and assigning an existing key keeps its place, so the record
  // reads back with its fields in the order they were written.
  const body = time === undefined ? value : { ...value, timestamp: "" };
  const bytes = encoder.encode(JSON.stringify(body));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return time === undefined ? { hash, bytes } : { hash, bytes, time };
}

/** `input` as messages: the stored form, and each message's bytes by hash. */
export function storedInputOf(input: readonly NormalizedRecord[]): {
  input: StoredInput;
  messages: Map<string, Uint8Array>;
} {
  const messages = new Map<string, Uint8Array>();
  const refs: StoredMessageRef[] = [];
  let at: string | undefined;
  for (const record of input) {
    const { hash, bytes, time } = messageOf(record);
    messages.set(hash, bytes);
    if (time !== undefined && at === undefined) at = time;
    refs.push(time === undefined || time === at ? hash : [hash, time]);
  }
  return { input: { ...(at !== undefined ? { at } : {}), messages: refs }, messages };
}

/** The hashes a stored input names. */
export function storedHashes(input: StoredInput | undefined): string[] {
  return (input?.messages ?? []).map((ref) => (typeof ref === "string" ? ref : ref[0]));
}

/** Every message hash stored for a session. */
export async function listSpanMessages(
  store: Store,
  owner: string,
  archive: string,
): Promise<Set<string>> {
  const prefix = keys.spanMessages(owner, archive);
  const out = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    for (const key of page.keys) {
      const name = key.slice(prefix.length);
      if (name.endsWith(".json")) out.add(name.slice(0, -".json".length));
    }
    if (!page.truncated || page.keys.length === 0) return out;
    after = page.keys.at(-1);
  }
}

export interface PutSpansOptions {
  /** How many objects are written at once; 8 by default. */
  concurrency?: number;
  /** Hashes of messages known to be stored for the session (a backfill's, say): those are not
   * listed or written again, and what this call writes is added. Listed when absent. */
  stored?: Set<string>;
}

/** Write (or overwrite, for a repeat) one span's record, and the messages its input needs. */
export async function putSpan(
  store: Store,
  owner: string,
  archive: string,
  record: Omit<SpanRecord, "schema">,
  options: PutSpansOptions = {},
): Promise<void> {
  await putSpans(store, owner, archive, [record], options);
}

/** Every span record key of a session, in key order (its messages, after them, are not). */
export async function listSpanKeys(
  store: Store,
  owner: string,
  archive: string,
): Promise<string[]> {
  const out: string[] = [];
  for await (const page of spanKeyPages(store, owner, archive)) out.push(...page);
  return out;
}

/** A session's span record keys a listing page at a time. Messages sort after every record
 * (`messages/` after hex), so the listing stops at the first. */
async function* spanKeyPages(
  store: Store,
  owner: string,
  archive: string,
): AsyncGenerator<string[]> {
  const prefix = keys.spans(owner, archive);
  const messages = keys.spanMessages(owner, archive);
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    const records = page.keys.filter((k) => !k.startsWith(messages));
    if (records.length > 0) yield records;
    if (records.length < page.keys.length || !page.truncated || page.keys.length === 0) return;
    after = page.keys.at(-1);
  }
}

/** Run `work` over `items`, `limit` at a time. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      results[at] = await work(items[at] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

function parseRecord(bytes: Uint8Array): SpanRecord | null {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as SpanRecord;
    return value?.schema === SPAN_SCHEMA && value.part ? value : null;
  } catch {
    return null;
  }
}

/** A session's span records as stored (inputs by reference), in key order, a listing page at a
 * time with `concurrency` reads in flight. A record that is gone between the listing and the
 * read, or that does not parse as one, is skipped. */
export async function* spanRecords(
  store: Store,
  owner: string,
  archive: string,
  options: { concurrency?: number } = {},
): AsyncGenerator<SpanRecord> {
  const concurrency = options.concurrency ?? 16;
  for await (const page of spanKeyPages(store, owner, archive)) {
    for (let at = 0; at < page.length; at += concurrency) {
      const read = await pool(page.slice(at, at + concurrency), concurrency, async (key) => {
        const bytes = await getBytes(store, key);
        return bytes === null ? null : parseRecord(bytes);
      });
      for (const record of read) if (record) yield record;
    }
  }
}

/** A session's stored messages, each read once and kept: what rebuilds the parts' inputs. */
export class SpanMessages {
  private readonly held = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly store: Store,
    private readonly owner: string,
    private readonly archive: string,
    private readonly concurrency = 16,
  ) {}

  /** Read the messages of `hashes` not held yet. Throws `MissingSpanMessage` for one the store
   * does not have. */
  async load(hashes: Iterable<string>): Promise<void> {
    const wanted = [...new Set(hashes)].filter((h) => !this.held.has(h));
    await pool(wanted, this.concurrency, async (hash) => {
      const bytes = await getBytes(this.store, keys.spanMessage(this.owner, this.archive, hash));
      if (bytes === null) throw new MissingSpanMessage(hash);
      this.held.set(hash, JSON.parse(decoder.decode(bytes)) as Record<string, unknown>);
    });
  }

  /** The records of a stored input, each its own copy with its time put back. */
  records(input: StoredInput): NormalizedRecord[] {
    return input.messages.map((ref) => {
      const [hash, time] = typeof ref === "string" ? [ref, input.at] : ref;
      const message = this.held.get(hash);
      if (!message) throw new MissingSpanMessage(hash);
      const record = { ...message };
      if (record.timestamp === "" && time !== undefined) record.timestamp = time;
      return record as unknown as NormalizedRecord;
    });
  }
}

/** `record` with its stored input given back as `part.input`, rebuilt from `messages` each time
 * it is read (so no part holds a copy of the history), and without `input`. */
export function withInput(record: SpanRecord, messages: SpanMessages): SpanRecord {
  const { input, ...rest } = record;
  if (!input) return rest;
  const part = { ...record.part };
  Object.defineProperty(part, "input", {
    enumerable: true,
    configurable: true,
    get: () => messages.records(input),
    set(value: NormalizedRecord[] | undefined) {
      Object.defineProperty(part, "input", {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    },
  });
  return { ...rest, part };
}

/** Every span record of a session, streamed (see the top of this file): each part's `input` is
 * rebuilt from the session's messages when read. A record that is gone between the listing and
 * the read, or that does not parse as one, is skipped; a message a record names that is gone
 * throws `MissingSpanMessage`. */
export async function listSpans(
  store: Store,
  owner: string,
  archive: string,
  options: { concurrency?: number } = {},
): Promise<SpanRecord[]> {
  const records: SpanRecord[] = [];
  // One string per hash, however many records name it.
  const hashes = new Map<string, string>();
  const intern = (hash: string) => {
    const held = hashes.get(hash);
    if (held !== undefined) return held;
    hashes.set(hash, hash);
    return hash;
  };
  for await (const record of spanRecords(store, owner, archive, options)) {
    if (record.input) {
      record.input.messages = record.input.messages.map((ref) =>
        typeof ref === "string" ? intern(ref) : [intern(ref[0]), ref[1]],
      );
    }
    records.push(record);
  }
  const messages = new SpanMessages(store, owner, archive, options.concurrency);
  await messages.load(hashes.keys());
  return records.map((record) => withInput(record, messages));
}

/** Write many span records, `concurrency` objects at a time: first the messages their inputs
 * need that the session does not have yet, then the records. */
export async function putSpans(
  store: Store,
  owner: string,
  archive: string,
  records: readonly Omit<SpanRecord, "schema">[],
  options: PutSpansOptions = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 8;
  const messages = new Map<string, Uint8Array>();
  const bodies = records.map((record) => {
    const { input: _stored, ...rest } = record;
    const { input, ...part } = record.part;
    const body: SpanRecord = { schema: SPAN_SCHEMA, ...rest, part };
    if (input && input.length > 0) {
      const stored = storedInputOf(input);
      for (const [hash, bytes] of stored.messages) messages.set(hash, bytes);
      // In the record's place for `part.input`: after `part`, before `redaction`.
      const { redaction, ...head } = body;
      return {
        part,
        body: { ...head, input: stored.input, ...(redaction ? { redaction } : {}) } as SpanRecord,
      };
    }
    return { part, body };
  });
  if (messages.size > 0) {
    const stored = options.stored ?? (await listSpanMessages(store, owner, archive));
    const missing = [...messages].filter(([hash]) => !stored.has(hash));
    await pool(missing, concurrency, async ([hash, bytes]) => {
      await store.put(keys.spanMessage(owner, archive, hash), bytes, {
        contentType: "application/json",
      });
      stored.add(hash);
    });
  }
  await pool(bodies, concurrency, async ({ part, body }) => {
    const key = keys.span(owner, archive, part.trace_id, part.span_id);
    await store.put(key, encoder.encode(JSON.stringify(body)), {
      contentType: "application/json",
    });
  });
}

/** Delete every span record of a session and the messages they name (it was deleted or
 * redacted); how many span records went. */
export async function deleteSpans(store: Store, owner: string, archive: string): Promise<number> {
  const prefix = keys.spans(owner, archive);
  const found: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    found.push(...page.keys);
    if (!page.truncated || page.keys.length === 0) break;
    after = page.keys.at(-1);
  }
  // Records first, so no record is left naming a message that is gone.
  const messages = keys.spanMessages(owner, archive);
  const records = found.filter((k) => !k.startsWith(messages));
  await pool(records, 16, (key) => store.delete(key));
  await pool(
    found.filter((k) => k.startsWith(messages)),
    16,
    (key) => store.delete(key),
  );
  return records.length;
}
