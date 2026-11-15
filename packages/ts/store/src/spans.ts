/** The span store (F4.4, X6.3): one object per span under the session's folder,
 * `owners/<owner>/sessions/<archive_id>/spans/<trace_id>-<span_id>.json`. Each holds the span's
 * part of the session, normalized and regex-redacted on arrival, never the span as received.
 * A span sent twice lands on the same key, so repeats are removed by trace and span id. The
 * records stay after the session is published, so a late span can rebuild it; they are never
 * readable through the API, and deleting the session deletes them. Code-first: only the binary
 * reads them (X3.10). */

import type { RedactionSummary, SpanPart } from "@seshi/model";
import { keys } from "./layout";
import type { Store } from "./store";
import { getBytes } from "./store";

export const SPAN_SCHEMA = "seshi/span/1" as const;

export interface SpanRecord {
  schema: typeof SPAN_SCHEMA;
  /** When the batch that carried it arrived. */
  received_at: string;
  /** The source it came from (an OTLP destination, a poller). */
  source_id: string;
  /** The span format that normalized it (`otlp-genai`). */
  format: string;
  part: SpanPart;
  /** What regex redaction did to this span on arrival (rule set and counts, F2.3). */
  redaction?: RedactionSummary;
}

const encoder = new TextEncoder();

/** Write (or overwrite, for a repeat) one span's record. */
export async function putSpan(
  store: Store,
  owner: string,
  archive: string,
  record: Omit<SpanRecord, "schema">,
): Promise<void> {
  const key = keys.span(owner, archive, record.part.trace_id, record.part.span_id);
  const body: SpanRecord = { schema: SPAN_SCHEMA, ...record };
  await store.put(key, encoder.encode(JSON.stringify(body)), { contentType: "application/json" });
}

/** Every span record key of a session, in key order. */
export async function listSpanKeys(
  store: Store,
  owner: string,
  archive: string,
): Promise<string[]> {
  const prefix = keys.spans(owner, archive);
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    out.push(...page.keys);
    if (!page.truncated || page.keys.length === 0) return out;
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

/** Every span record of a session. A record that is gone between the listing and the read, or
 * that does not parse as one, is skipped. */
export async function listSpans(
  store: Store,
  owner: string,
  archive: string,
  options: { concurrency?: number } = {},
): Promise<SpanRecord[]> {
  const found = await listSpanKeys(store, owner, archive);
  const records = await pool(found, options.concurrency ?? 16, async (key) => {
    const bytes = await getBytes(store, key);
    if (bytes === null) return null;
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as SpanRecord;
      return value?.schema === SPAN_SCHEMA && value.part ? value : null;
    } catch {
      return null;
    }
  });
  return records.filter((r): r is SpanRecord => r !== null);
}

/** Write many span records, `concurrency` at a time. */
export async function putSpans(
  store: Store,
  owner: string,
  archive: string,
  records: readonly Omit<SpanRecord, "schema">[],
  options: { concurrency?: number } = {},
): Promise<void> {
  await pool(records, options.concurrency ?? 8, (record) => putSpan(store, owner, archive, record));
}

/** Delete every span record of a session (it was deleted or redacted); how many went. */
export async function deleteSpans(store: Store, owner: string, archive: string): Promise<number> {
  const found = await listSpanKeys(store, owner, archive);
  await pool(found, 16, (key) => store.delete(key));
  return found.length;
}
