/** Span sets (X4.2, F4.4): the span store and the span assembler.
 *
 * Arrival (`Pipeline.submit` with a span batch, `SpanStore.accept`). Each span is normalized by
 * its format's span adapter and regex-redacted (its records, its tool call, its LLM call), then
 * kept as one record under the session's `spans/`; a repeat lands on the same key. The session's
 * pending marker (`assembly/pending/<archive_id>`) is touched last, with the batch's envelope
 * (never its payload), so the assembler knows who sent the spans and whose session it is.
 *
 * Assembly (`assemblePending`, the worker's `assembler` job). It lists the markers; for each
 * session quiet for its source's quiet period (or shortly after a final span) it reads the
 * span records, assembles them with the format's adapter, and hands the whole session to
 * `Pipeline.publishAssembled`, which runs the session filter, model review and the write. The
 * marker is then deleted with If-Match, so a batch that arrived meanwhile keeps it for the next
 * pass (X7.4). A permanent failure is recorded by the pipeline (X4.8) and the marker cleared; a
 * transient one keeps the marker, so the session is assembled again.
 *
 * Connectors that read spans (Datadog, F5) submit envelopes whose payload is `{ kind: "spans",
 * spans, resource? }` in OTLP's JSON mapping, with `format` naming a format that has a span
 * adapter and `session_key` the session the spans belong to. They come out here. */

import type { FormatRegistry } from "@seshi/formats";
import type {
  Envelope,
  LlmCall,
  NormalizedRecord,
  RedactionSummary,
  SpanPart,
  StoreSessionResult,
} from "@seshi/model";
import { SessionRejected } from "@seshi/model";
import type { Redactor } from "@seshi/redact";
import {
  clearPending,
  deleteSpans,
  isPreconditionFailed,
  listPending,
  listSpans,
  type PendingEnvelope,
  putSpans,
  readMetadata,
  readPending,
  type SpanRecord,
  type Store,
  touchPending,
} from "@seshi/store";
import type { AssembledSession, SpanAssembler, SpanBatch, SpanBatchResult } from "./stages";

type Counts = Record<string, number>;

function addCounts(into: Counts, from: Readonly<Counts> | undefined): Counts {
  for (const [rule, n] of Object.entries(from ?? {})) into[rule] = (into[rule] ?? 0) + n;
  return into;
}

/** The free text of LLM calls (`error`, string `parameters`) through the records redactor: each
 * string goes through as a `system` record, so any `Redactor` (07's packs included) applies
 * without its contract growing. Ids, models, times and stop reasons are structural and kept. */
export function redactLlmCalls(
  redactor: Redactor,
  calls: readonly LlmCall[] | undefined,
): { calls: LlmCall[] | undefined; summary: RedactionSummary } {
  const counts: Counts = {};
  if (!calls || calls.length === 0) {
    return {
      calls: calls ? [...calls] : undefined,
      summary: { rule_set: redactor.rule_set, counts },
    };
  }
  const texts: string[] = [];
  const at: { call: number; field: "error" | string }[] = [];
  calls.forEach((call, i) => {
    if (typeof call.error === "string" && call.error !== "") {
      texts.push(call.error);
      at.push({ call: i, field: "error" });
    }
    for (const [key, value] of Object.entries(call.parameters ?? {})) {
      if (typeof value === "string" && value !== "") {
        texts.push(value);
        at.push({ call: i, field: `parameters.${key}` });
      }
    }
  });
  if (texts.length === 0)
    return { calls: [...calls], summary: { rule_set: redactor.rule_set, counts } };
  const out = calls.map((call) => ({
    ...call,
    ...(call.parameters ? { parameters: { ...call.parameters } } : {}),
  }));
  const redacted = redactor.redact(
    texts.map((content) => ({ role: "system", content, timestamp: "" }) as NormalizedRecord),
  );
  addCounts(counts, redacted.summary.counts);
  redacted.records.forEach((record, i) => {
    const place = at[i] as { call: number; field: string };
    const text = (record as { content: string }).content;
    const call = out[place.call] as LlmCall;
    if (place.field === "error") call.error = text;
    else if (call.parameters) call.parameters[place.field.slice("parameters.".length)] = text;
  });
  return { calls: out, summary: { rule_set: redactor.rule_set, counts } };
}

/** One span part through regex redaction: its input and output records, its tool call (as a
 * call and its result, so the sensitive-file and secret-command rules apply), and its LLM
 * call's free text. */
export function redactSpanPart(
  redactor: Redactor,
  part: SpanPart,
): { part: SpanPart; summary: RedactionSummary } {
  const counts: Counts = {};
  const out: SpanPart = { ...part };
  const pass = (records: readonly NormalizedRecord[]) => {
    const result = redactor.redact(records);
    addCounts(counts, result.summary.counts);
    return result.records;
  };
  if (part.input) out.input = pass(part.input);
  if (part.output) out.output = pass(part.output);
  if (part.tool) {
    const id = part.tool.call_id ?? `span:${part.span_id}`;
    const records: NormalizedRecord[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id, name: part.tool.name, args: part.tool.args ?? "" }],
        timestamp: part.started_at,
      },
      {
        role: "tool",
        tool_call_id: id,
        content: part.tool.result ?? "",
        timestamp: part.ended_at ?? part.started_at,
      },
    ];
    const [call, result] = pass(records) as unknown as [
      { tool_calls: { args: string }[] },
      { content: string; withheld?: string },
    ];
    out.tool = {
      ...part.tool,
      ...(part.tool.args !== undefined ? { args: call.tool_calls[0]?.args ?? "" } : {}),
      ...(part.tool.result !== undefined || result.withheld ? { result: result.content } : {}),
    };
  }
  if (part.llm_call) {
    const { calls, summary } = redactLlmCalls(redactor, [part.llm_call]);
    addCounts(counts, summary.counts);
    out.llm_call = calls?.[0] as LlmCall;
  }
  return { part: out, summary: { rule_set: redactor.rule_set, counts } };
}

export interface SpanStoreOptions {
  store: Store;
  now?: () => Date;
  /** How many span records are written at once; 8 by default. */
  concurrency?: number;
}

/** The span store: the pipeline's `SpanAssembler` (`accept`). See the module comment. */
export class SpanStore implements SpanAssembler {
  readonly store: Store;
  private readonly now: () => Date;
  private readonly concurrency: number;

  constructor(options: SpanStoreOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.concurrency = options.concurrency ?? 8;
  }

  async accept(batch: SpanBatch): Promise<SpanBatchResult> {
    const { envelope, authorization, archive_id } = batch;
    const owner = authorization.owner;
    const session = await readMetadata(this.store, owner, archive_id);
    if (session?.status === "redacted") {
      throw new SessionRejected("redacted", "session was redacted; it will not be stored again");
    }
    const at = this.now().toISOString();
    await putSpans(
      this.store,
      owner,
      archive_id,
      batch.parts.map(({ part, redaction }) => ({
        received_at: at,
        source_id: envelope.source_id,
        format: envelope.format,
        part,
        ...(redaction ? { redaction } : {}),
      })),
      { concurrency: this.concurrency },
    );
    // Last, so the quiet period counts from the last span written. A final span seen by an
    // earlier batch stays seen until the session is published (the marker is then removed); two
    // batches racing can lose it, which only means waiting the whole quiet period.
    const final =
      batch.parts.some(({ part }) => endsSession(part, envelope.session_key)) ||
      (await readPending(this.store, archive_id))?.value.final === true;
    await touchPending(this.store, owner, archive_id, this.now, {
      source_id: envelope.source_id,
      envelope: { ...envelope, owner },
      final,
    });
    return {
      status: "accepted",
      archive_id,
      spans: batch.parts.length,
      ...(batch.rejected ? { rejected: batch.rejected } : {}),
    };
  }
}

/** Waits after a final span before publishing, for its siblings in later export batches. */
export const FINAL_GRACE_MS = 15_000;

/** Sessions one pass publishes before it says there is more. */
export const ASSEMBLE_BATCH = 50;

/** Whether a part ends its session: a final span, or the root span of a session that is one
 * trace (a request with no session or conversation id ends with its root). */
function endsSession(part: SpanPart, sessionKey: string): boolean {
  return (
    part.final === true || (!part.parent_span_id && part.trace_id === sessionKey && !!part.ended_at)
  );
}

export interface AssembleOptions {
  store: Store;
  formats: FormatRegistry;
  /** Where an assembled session goes: `Pipeline.publishAssembled`. */
  publish: (
    session: AssembledSession,
  ) => Promise<
    StoreSessionResult | { status: "failed"; code: string; message: string; record: string }
  >;
  /** The quiet period of a source, in milliseconds (F4.4). */
  quietMs: (sourceId: string) => number;
  finalGraceMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
  /** Sessions to publish in one pass; `ASSEMBLE_BATCH` by default. */
  limit?: number;
  /** Reports a session that could not be assembled this pass (kept for the next). */
  onError?: (archive: string, err: unknown) => void;
}

export interface AssembleReport {
  /** Sessions published (any outcome the pipeline answered: stored, unchanged, filtered…). */
  published: number;
  /** Sessions still inside their quiet period. */
  waiting: number;
  /** Sessions the pipeline recorded a permanent failure for (their marker is cleared). */
  failed: number;
  /** Sessions whose marker stayed because a batch arrived while they were published. */
  retouched: number;
  /** Sessions skipped this pass by an error (marker kept). */
  errors: number;
  /** Markers removed without publishing (session deleted, or nothing to say who wrote it). */
  dropped: number;
  /** The pass stopped at `limit`: run again. */
  more: boolean;
  /** How the pipeline answered, by status. */
  outcomes: Record<string, number>;
}

function sum(records: readonly SpanRecord[]): RedactionSummary | undefined {
  let rule_set: string | undefined;
  const counts: Counts = {};
  for (const record of records) {
    if (!record.redaction) continue;
    rule_set = record.redaction.rule_set;
    addCounts(counts, record.redaction.counts);
  }
  return rule_set ? { rule_set, counts } : undefined;
}

/** One pass of the assembler over the pending markers (see the module comment). */
export async function assemblePending(options: AssembleOptions): Promise<AssembleReport> {
  const { store, formats } = options;
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? ASSEMBLE_BATCH;
  const grace = options.finalGraceMs ?? FINAL_GRACE_MS;
  const report: AssembleReport = {
    published: 0,
    waiting: 0,
    failed: 0,
    retouched: 0,
    errors: 0,
    dropped: 0,
    more: false,
    outcomes: {},
  };
  let after: string | undefined;
  let handled = 0;
  for (;;) {
    const page = await listPending(store, { after, limit: 1000 });
    for (const archive of page.archives) {
      if (options.signal?.aborted) return report;
      if (handled >= limit) {
        report.more = true;
        return report;
      }
      try {
        const outcome = await assembleOne(archive);
        if (outcome !== "waiting") handled++;
      } catch (err) {
        report.errors++;
        handled++;
        options.onError?.(archive, err);
      }
    }
    if (!page.truncated || page.archives.length === 0) return report;
    after = page.cursor;
  }

  async function assembleOne(archive: string): Promise<"waiting" | "done"> {
    const found = await readPending(store, archive);
    if (!found) return "done";
    const { value: marker, etag } = found;
    const clear = async () => {
      try {
        await clearPending(store, archive, etag);
        return true;
      } catch (err) {
        if (isPreconditionFailed(err)) {
          report.retouched++;
          return false;
        }
        throw err;
      }
    };
    const envelope = marker.envelope;
    if (!envelope) {
      // A marker without the batch's envelope cannot be published as anyone.
      await clear();
      report.dropped++;
      return "done";
    }
    // Quiet for the source's quiet period, or for a short grace after a final span (F4.4).
    const age = now().getTime() - Date.parse(marker.touched_at);
    const quiet = options.quietMs(marker.source_id ?? envelope.source_id);
    if (age < quiet && !(marker.final && age >= Math.min(grace, quiet))) {
      report.waiting++;
      return "waiting";
    }
    const session = await readMetadata(store, marker.owner, archive);
    if (session?.status === "redacted") {
      // Deleted while its spans waited: nothing of it is kept.
      await deleteSpans(store, marker.owner, archive);
      await clear();
      report.dropped++;
      return "done";
    }
    const adapter = formats.get(envelope.format)?.spans;
    if (!adapter) {
      throw new Error(`format ${envelope.format} has no span adapter in this binary; spans kept`);
    }
    const records = await listSpans(store, marker.owner, archive);
    if (records.length === 0) {
      await clear();
      report.dropped++;
      return "done";
    }
    const assembled = adapter.assemble(
      records.map((r) => r.part),
      { source: envelope.format },
    );
    const redaction = sum(records);
    const result = await options.publish({
      envelope: {
        ...(envelope as PendingEnvelope),
        payload: { kind: "spans", spans: [] },
      } as Envelope,
      records: assembled.records,
      llm_calls: assembled.llm_calls,
      ...(redaction ? { redaction } : {}),
    });
    report.outcomes[result.status] = (report.outcomes[result.status] ?? 0) + 1;
    if (result.status === "failed") report.failed++;
    else report.published++;
    await clear();
    return "done";
  }
}
