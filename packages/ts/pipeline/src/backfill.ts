import {
  canonicalJson,
  isStub,
  type LlmCall,
  type NormalizedRecord,
  parseTrace,
  type RedactionSummary,
  type SessionMetadata,
  type SessionTraceRef,
  type Trace,
  type TraceMetadata,
  TrajectoryError,
  type Writer,
} from "@seshi/model";
import { type Redactor, redactLlmCalls } from "@seshi/redact";
import {
  gzipJsonDeterministic,
  isOwner,
  keys,
  listOwners,
  listSpanMessages,
  publishObject,
  putSpan,
  SpanMessages,
  type Store,
  type SweepReport,
  spanRecords,
  storedHashes,
  storedInputOf,
  sweepTraces,
  updateMetadata,
  updateMetadataWithChange,
  withInput,
} from "@seshi/store";
import { getTrace, keyPastSpansOf, listSessions, type WithheldCallIds } from "./ingest";
import { redactSpanPart } from "./spans";

export type BackfillOutcome =
  /** Redacted with the current rules already. */
  | "current"
  /** Re-redacted, nothing new to take out: the rule set is recorded. */
  | "unchanged"
  /** A new trace replaced the session's traces. */
  | "rewritten"
  /** Another write changed the session meanwhile, or a trace was missing; run again. */
  | "conflict"
  /** Its traces do not make one valid trace (reported, never written). */
  | "failed"
  /** Not stored (tombstoned), no trace yet, or not written since `since`. */
  | "skipped";

export interface BackfillSession {
  owner: string;
  archive_id: string;
  agent: string;
  session_id: string;
  outcome: BackfillOutcome;
  /** What the current rules took out that the old ones had not, by rule id. */
  counts?: Record<string, number>;
  /** The new trace, for `rewritten` (and what it would be, in a dry run). */
  content_hash?: string;
  /** Why, for `conflict` and `failed`. */
  message?: string;
  /** Span records redacted again with the current rules (or that would be, in a dry run). */
  spans?: number;
  /** Trace objects of the session no metadata names that the sweep deleted (or would). */
  swept?: number;
}

export interface BackfillOptions {
  store: Store;
  redactor: Redactor;
  writer: Writer;
  /** Only sessions written (`updated_at`) at or after this; every session when absent. */
  since?: Date;
  /** Only these owners' folders; every owner when absent. */
  owners?: readonly string[];
  /** Work out what would change, and write nothing. */
  dryRun?: boolean;
  /** Stop after this many sessions rewritten (`more` says there may be others). */
  limit?: number;
  signal?: AbortSignal;
  now?: () => Date;
  onSession?: (session: BackfillSession) => void;
}

export interface BackfillReport {
  rule_set: string;
  dry_run: boolean;
  /** Sessions looked at, by outcome. */
  outcomes: Record<BackfillOutcome, number>;
  /** What the current rules took out across the sessions rewritten, by rule id. */
  counts: Record<string, number>;
  /** The sessions rewritten, in conflict or failed (the others are only counted). */
  sessions: BackfillSession[];
  /** Span records redacted again with the current rules, across every session looked at and
   * the sessions never published. */
  spans: number;
  /** Stopped at `limit` or by the signal before every session was looked at. */
  more: boolean;
  /** The sweep of the sessions looked at (F2.5): trace objects no metadata names, over an hour
   * old, deleted (or that would be, in a dry run), and the sessions it could not finish. */
  sweep: BackfillSweep;
}

export interface BackfillSweep {
  deleted: number;
  /** Unnamed objects kept because they are under an hour old. */
  young: number;
  errors: number;
  error?: string;
}

async function sweepAfter(
  done: BackfillSession,
  options: BackfillOptions,
  report: BackfillReport,
): Promise<void> {
  const swept: SweepReport = await sweepTraces(options.store, {
    sessions: [{ owner: done.owner, archive_id: done.archive_id }],
    dryRun: options.dryRun === true,
    ...(options.now ? { now: options.now } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  report.sweep.deleted += swept.deleted;
  report.sweep.young += swept.young;
  report.sweep.errors += swept.errors;
  if (swept.error !== undefined) report.sweep.error ??= swept.error;
  if (swept.deleted > 0) done.swept = swept.deleted;
}

async function* sessionsOf(store: Store, owner: string): AsyncGenerator<SessionMetadata> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await listSessions(store, owner, { startAfter, limit: 1000 });
    for (const session of page.sessions) yield session;
    if (!page.truncated || page.cursor === undefined) return;
    startAfter = page.cursor;
  }
}

async function* unpublishedSpanArchives(store: Store, owner: string): AsyncGenerator<string> {
  const prefix = keys.sessions(owner);
  let after: string | undefined;
  let published: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    let stepped = false;
    for (const key of page.keys) {
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const archive = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (name === "metadata.json") published = archive;
      else if (name.startsWith("spans/")) {
        if (published !== archive) yield archive;
        after = keyPastSpansOf(`${prefix}${archive}`);
        stepped = true;
        break;
      }
      after = key;
    }
    if (!stepped && (!page.truncated || page.keys.length === 0)) return;
  }
}

async function* ownersOf(store: Store, only?: readonly string[]): AsyncGenerator<string> {
  if (only) {
    for (const owner of only) yield owner;
    return;
  }
  let after: string | undefined;
  for (;;) {
    const page = await listOwners(store, { after, limit: 100 });
    for (const owner of page.owners) yield owner;
    if (!page.truncated || page.cursor === undefined) return;
    after = page.cursor;
  }
}

function addCounts(into: Record<string, number>, counts: Readonly<Record<string, number>>): void {
  for (const [rule, n] of Object.entries(counts)) {
    if (n > 0) into[rule] = (into[rule] ?? 0) + n;
  }
}

function joined(traces: readonly Trace[]): {
  records: NormalizedRecord[];
  llm_calls: LlmCall[];
} {
  const records: NormalizedRecord[] = [];
  const calls = new Map<string, LlmCall>();
  traces.forEach((trace, i) => {
    const own = trace.records as NormalizedRecord[];
    records.push(...(i > 0 && own[0]?.role === "meta" ? own.slice(1) : own));
    for (const call of trace.llm_calls ?? []) if (!calls.has(call.id)) calls.set(call.id, call);
  });
  return { records, llm_calls: [...calls.values()] };
}

function withoutMetaRecordFields(metadata: TraceMetadata) {
  const { cwd: _cwd, git_branch: _branch, model: _model, ...rest } = metadata;
  return rest;
}

function shouldBackfillSpans(done: BackfillSession, session: SessionMetadata): boolean {
  return done.outcome !== "skipped" || isStub(session);
}

class Moved extends Error {}

const sameTraces = (a: SessionMetadata, b: SessionMetadata) =>
  a.status === b.status &&
  a.head === b.head &&
  a.traces.map((t) => t.content_hash).join() === b.traces.map((t) => t.content_hash).join();

async function backfillSession(
  session: SessionMetadata,
  options: BackfillOptions,
  at: string,
): Promise<BackfillSession> {
  const { store, redactor } = options;
  const owner = session.owner;
  const archive = session.archive_id;
  const base = {
    owner,
    archive_id: archive,
    agent: session.agent,
    session_id: session.session_id,
  };
  if (session.status !== "stored" || !session.head || session.traces.length === 0) {
    return { ...base, outcome: "skipped" };
  }
  if (options.since && Date.parse(session.updated_at) < options.since.getTime()) {
    return { ...base, outcome: "skipped" };
  }
  const ruleSetOf = (ref: SessionTraceRef) => ref.rule_set ?? session.redaction?.rule_set;
  if (session.traces.every((ref) => ruleSetOf(ref) === redactor.rule_set)) {
    return { ...base, outcome: "current" };
  }

  const traces: Trace[] = [];
  for (const ref of session.traces) {
    const trace = await getTrace(store, owner, archive, ref.content_hash);
    if (trace === null) {
      return { ...base, outcome: "conflict", message: `trace ${ref.content_hash} is missing` };
    }
    traces.push(trace);
  }
  const head = traces[0] as Trace;
  const latest = traces.at(-1) as Trace;
  const joinedTraces = joined(traces);
  const { records } = joinedTraces;
  const redacted = redactor.redact(records);
  const calls = redactLlmCalls(redactor, joinedTraces.llm_calls);
  const llm_calls = calls.calls ?? [];
  const counts = { ...redacted.summary.counts };
  addCounts(counts, calls.counts);
  const changed =
    canonicalJson(redacted.records) !== canonicalJson(records) ||
    canonicalJson(llm_calls) !== canonicalJson(joinedTraces.llm_calls);

  const step = (next: (existing: SessionMetadata) => SessionMetadata) => {
    return (existing: SessionMetadata | null) => {
      if (existing === null || !sameTraces(existing, session)) throw new Moved();
      return next(existing);
    };
  };
  const redaction = (existing: SessionMetadata): RedactionSummary => {
    const sum = { ...existing.redaction?.counts };
    addCounts(sum, counts);
    return { rule_set: redactor.rule_set, counts: sum };
  };
  const withheld = (existing: SessionMetadata): WithheldCallIds | undefined => {
    const all = { ...existing.withheld_calls, ...redacted.withheld };
    return Object.keys(all).length > 0 ? all : undefined;
  };

  if (!changed) {
    if (options.dryRun) return { ...base, outcome: "unchanged", counts };
    try {
      await updateMetadata(
        store,
        owner,
        archive,
        step((existing) => {
          const next = {
            ...existing,
            traces: existing.traces.map((ref) => ({ ...ref, rule_set: redactor.rule_set })),
            redaction: redaction(existing),
          };
          const ids = withheld(existing);
          if (ids) next.withheld_calls = ids;
          return next;
        }),
      );
    } catch (err) {
      if (err instanceof Moved) {
        return { ...base, outcome: "conflict", message: "the session changed meanwhile" };
      }
      throw err;
    }
    return { ...base, outcome: "unchanged", counts };
  }

  const metadata = withoutMetaRecordFields(head.metadata as TraceMetadata);
  const continuation = metadata.continuation;
  let trace: Trace;
  try {
    trace = parseTrace(redacted.records, {
      agent: session.agent,
      session_id: session.session_id,
      ...(head.project !== undefined ? { project: head.project } : {}),
      ...(head.branch !== undefined ? { branch: head.branch } : {}),
      metadata,
      ...(llm_calls.length > 0 ? { llm_calls } : {}),
      ...(latest.provenance ? { provenance: latest.provenance } : {}),
    });
  } catch (err) {
    if (err instanceof TrajectoryError) {
      return { ...base, outcome: "failed", message: err.message };
    }
    throw err;
  }
  if (options.dryRun) {
    return { ...base, outcome: "rewritten", counts, content_hash: trace.content_hash };
  }

  const old = session.traces.map((t) => t.content_hash);
  const reused = old.includes(trace.content_hash);
  const written = await publishObject(
    store,
    keys.trace(owner, archive, trace.content_hash),
    gzipJsonDeterministic(trace),
    "application/gzip",
    reused ? "replace" : "immutable",
  );
  const rewrite = step((existing) => {
    const { applied, withheld_calls: _withheld, ...rest } = existing;
    const drops = (applied ?? []).filter((a) => a.status === "dropped");
    const next: SessionMetadata = {
      ...rest,
      ...(drops.length > 0 ? { applied: drops } : {}),
      head: trace.content_hash,
      traces: [
        {
          content_hash: trace.content_hash,
          created_at: at,
          records: trace.records.length,
          ...(continuation ? { continuation } : {}),
          rule_set: redactor.rule_set,
        },
      ],
      redaction: redaction(existing),
      updated_at: at,
    };
    const ids = withheld(existing);
    if (ids) next.withheld_calls = ids;
    return next;
  });
  try {
    await updateMetadataWithChange(
      store,
      owner,
      archive,
      (existing) => {
        const next = rewrite(existing);
        return {
          next,
          change: {
            kind: "published",
            at,
            owner,
            archive_id: archive,
            session_id: session.session_id,
            content_hash: trace.content_hash,
            writer: options.writer,
            owner_basis: next.owner_basis,
            ...(continuation ? { continuation } : {}),
            replace: true,
            reason: "redacted",
          },
        };
      },
      { expected: session },
    );
  } catch (err) {
    if (written === "written" && !reused) {
      await store.delete(keys.trace(owner, archive, trace.content_hash));
    }
    if (err instanceof Moved) {
      return { ...base, outcome: "conflict", message: "the session changed meanwhile" };
    }
    throw err;
  }
  for (const hash of old) {
    if (hash !== trace.content_hash) await store.delete(keys.trace(owner, archive, hash));
  }
  return { ...base, outcome: "rewritten", counts, content_hash: trace.content_hash };
}

async function backfillSpans(
  store: Store,
  owner: string,
  archive: string,
  redactor: Redactor,
  dryRun: boolean,
): Promise<number> {
  let done = 0;
  const messages = new SpanMessages(store, owner, archive);
  let stored: Set<string> | undefined;
  const named = new Set<string>();
  const orphanCandidates = new Set<string>();
  for await (const record of spanRecords(store, owner, archive)) {
    const before = storedHashes(record.input);
    if (record.redaction?.rule_set === redactor.rule_set) {
      for (const hash of before) named.add(hash);
      continue;
    }
    done++;
    if (dryRun) continue;
    await messages.load(before);
    const { part, summary } = redactSpanPart(redactor, withInput(record, messages).part);
    const counts = { ...record.redaction?.counts };
    addCounts(counts, summary.counts);
    const { schema: _schema, input: _input, ...rest } = record;
    stored ??= await listSpanMessages(store, owner, archive);
    await putSpan(
      store,
      owner,
      archive,
      { ...rest, part, redaction: { rule_set: redactor.rule_set, counts } },
      { stored },
    );
    const after = new Set(part.input ? storedHashes(storedInputOf(part.input).input) : []);
    for (const hash of after) named.add(hash);
    for (const hash of before) if (!after.has(hash)) orphanCandidates.add(hash);
  }
  for (const hash of named) orphanCandidates.delete(hash);
  if (orphanCandidates.size > 0) {
    for await (const record of spanRecords(store, owner, archive)) {
      for (const hash of storedHashes(record.input)) orphanCandidates.delete(hash);
    }
    for (const hash of orphanCandidates) await store.delete(keys.spanMessage(owner, archive, hash));
  }
  return done;
}

export async function backfillRedaction(options: BackfillOptions): Promise<BackfillReport> {
  const now = options.now ?? (() => new Date());
  const report: BackfillReport = {
    rule_set: options.redactor.rule_set,
    dry_run: options.dryRun === true,
    outcomes: { current: 0, unchanged: 0, rewritten: 0, conflict: 0, failed: 0, skipped: 0 },
    counts: {},
    sessions: [],
    spans: 0,
    more: false,
    sweep: { deleted: 0, young: 0, errors: 0 },
  };
  for (const owner of options.owners ?? []) {
    if (!isOwner(owner)) throw new Error(`'${owner}' is not an owner id`);
  }
  for await (const owner of ownersOf(options.store, options.owners)) {
    for await (const session of sessionsOf(options.store, owner)) {
      if (
        options.signal?.aborted ||
        (options.limit !== undefined && report.outcomes.rewritten >= options.limit)
      ) {
        report.more = true;
        return report;
      }
      const done = await backfillSession(session, options, now().toISOString());
      if (shouldBackfillSpans(done, session)) {
        const spans = await backfillSpans(
          options.store,
          session.owner,
          session.archive_id,
          options.redactor,
          options.dryRun === true,
        );
        if (spans > 0) {
          done.spans = spans;
          report.spans += spans;
        }
        if (!options.signal?.aborted) await sweepAfter(done, options, report);
      }
      report.outcomes[done.outcome]++;
      if (done.outcome === "rewritten" && done.counts) addCounts(report.counts, done.counts);
      if (
        done.outcome === "rewritten" ||
        done.outcome === "conflict" ||
        done.outcome === "failed"
      ) {
        report.sessions.push(done);
      }
      options.onSession?.(done);
    }
    for await (const archive of unpublishedSpanArchives(options.store, owner)) {
      if (options.signal?.aborted) {
        report.more = true;
        return report;
      }
      report.spans += await backfillSpans(
        options.store,
        owner,
        archive,
        options.redactor,
        options.dryRun === true,
      );
    }
  }
  return report;
}
