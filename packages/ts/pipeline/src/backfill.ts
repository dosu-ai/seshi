/** Redaction backfill (F2.5): apply the current rule set to sessions already stored, so a rule
 * added today also covers what was stored before it.
 *
 * For each session with a trace not written under the current rule set (`traces[].rule_set`;
 * for a trace without one, the session's `redaction.rule_set`), its traces (the head and its
 * continuations, in order) are read and joined into one record list, which is redacted with the
 * current rules. Then:
 *
 * - nothing changed: only the rule set is recorded on the session, so the next run skips it;
 * - something changed: one new trace object holds the whole redacted session; a `published`
 *   change entry with `replace: true` and `reason: "redacted"` tells readers to drop what they
 *   held of the session and take the new trace (written before the pointer moves, decision 7 of
 *   18); the pointer is moved to it (If-Match, X6.5; a session another write changed meanwhile
 *   is left for the next run); and every earlier trace object is deleted (they hold what the
 *   new rules take out, F2.5's "deleted, not kept").
 *
 * Redaction cannot be undone: unredacted data is never stored, so there is nothing to restore
 * from. The counts the new rules found are added to the session's (F2.3). Idempotent: a session
 * redacted with the current rules is skipped, and redacted records redact to themselves, so a
 * run can be stopped and started again.
 *
 * Span records (09): a session's records under `spans/` that an earlier rule set redacted are
 * redacted again with the current rules and rewritten in place, whatever became of its traces
 * (a session the assembler published after the rules changed is `current`, but its span records
 * are not). Their counts stay on the records, which the assembler adds to the session when it
 * next publishes it; they are not added to the session's or the report's counts here, since the
 * span records repeat what the traces hold. A stub (F3.4: a session whose first envelopes review
 * dropped) has no trace, but its span records are redacted again all the same. Spans of sessions
 * never published (pending, or refused by the filter) have no metadata: after an owner's
 * sessions, the owner's session folders are walked for span records with no metadata beside
 * them, which are redacted again the same way.
 *
 * A span record keeps its input as messages stored once per session (`spans/messages/`, by
 * content hash, F4.4). A record is redacted with its input rebuilt from them; a message the new
 * rules change is stored again under its new hash and the record rewritten to name it. Once a
 * session's records are done, every message a rewritten record stopped naming and no record
 * names any more is deleted: it holds what the new rules take out.
 *
 * The sweep (F2.5, revised 15 Nov 2026): each session looked at (every one with a trace, whatever
 * its outcome) is then swept: its trace objects no metadata names that are over an hour old are
 * deleted (`sweepTraces`). That finishes what an earlier run stopped partway left behind (the
 * old objects of a session it rewrote before it could delete them, which the next run finds
 * `current`), and anything a stopped replace or publish left in the session. It runs session by
 * session rather than once at the end, so a run over a large bucket keeps no list of what it
 * touched; a run stopped by the signal skips it for the session it stopped in. A dry run reports
 * what the sweep would delete. The report's `sweep` sums them.
 *
 * Not touched: `normalized` (the uploader's log state). A later whole upload of such a session,
 * redacted from the transcript with the same new rules, may not hash to the stored prefix; it
 * is then a 409 `conflict`, which the uploader answers with `replace` (as after any rules
 * change, 04). Chunks continue as before. `applied` is cleared of the answers that name trace
 * objects, which are gone (as a replace does, X4.6); its drops stay, since they name none and
 * explain the records review left out between or after the traces. */

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
  gzipJson,
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
import { getTrace, listSessions, type WithheldCallIds } from "./ingest";
import { redactSpanPart } from "./spans";

/** What became of one session. */
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
  /** The current rules (`ruleRedactor(instance.redaction)`). */
  redactor: Redactor;
  /** Who the change entries name (X5.5). */
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
  /** Told of each session as it is done (progress). */
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
  /** The first error. */
  error?: string;
}

/** Sweep one session the backfill looked at, adding to the report. */
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

/** The sessions under one owner, every page. */
async function* sessionsOf(store: Store, owner: string): AsyncGenerator<SessionMetadata> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await listSessions(store, owner, { startAfter, limit: 1000 });
    for (const session of page.sessions) yield session;
    if (!page.truncated || page.cursor === undefined) return;
    startAfter = page.cursor;
  }
}

/** The archives of `owner` that hold span records but no metadata: sessions never published
 * (pending, or refused by the filter or review). Keys sort `metadata.json` before `spans/`, so
 * an archive's metadata, if it has any, is seen before its spans; listing steps over each
 * archive's spans once it reaches them. */
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
        // `0` sorts right after `/`: past every span record of this archive.
        after = `${prefix}${archive}/spans0`;
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

/** A session's traces as one: the head's records, then each continuation's past its meta
 * record (a continuation repeats the head's), and every LLM call once. */
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

/** Thrown inside the pointer update when the session is no longer what was read. */
class Moved extends Error {}

const sameTraces = (a: SessionMetadata, b: SessionMetadata) =>
  a.status === b.status &&
  a.head === b.head &&
  a.traces.map((t) => t.content_hash).join() === b.traces.map((t) => t.content_hash).join();

/** One session through the current rules. */
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
  // Current only when every trace was written under the current rules: a chunk written after
  // the rules changed gives the session the new rule set, but not the traces stored before it.
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
  // What an LLM call says in free text (its error, string parameters) is content too.
  const calls = redactLlmCalls(redactor, joinedTraces.llm_calls);
  const llm_calls = calls.calls ?? [];
  const counts = { ...redacted.summary.counts };
  addCounts(counts, calls.counts);
  const changed =
    canonicalJson(redacted.records) !== canonicalJson(records) ||
    canonicalJson(llm_calls) !== canonicalJson(joinedTraces.llm_calls);

  /** The pointer as it should be, or a throw when the session moved. */
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
        // A call a new rule withholds whose result has not arrived yet changes no record, but
        // its id must be kept, so the result is withheld when a later chunk brings it.
        // `updated_at` stays: nothing anyone reads changed, so the session should not look
        // recently written (lists sort by it, and `--since` selects by it).
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

  // What the meta record gives (cwd, branch, model) comes from the redacted meta record; the
  // rest of the first trace's metadata is kept. Its `continuation` is kept too: only a fork's
  // first trace has one (it continues the copy of its parent's history, which is the parent's
  // to store), and the new trace still starts where that copy ends. Later traces' continuations
  // are folded into the new one.
  const {
    cwd: _cwd,
    git_branch: _branch,
    model: _model,
    ...metadata
  } = head.metadata as TraceMetadata;
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
  // A change only outside what the hash covers (a meta record's cwd) keeps the hash: the object
  // under it is replaced, not kept.
  const reused = old.includes(trace.content_hash);
  const written = await publishObject(
    store,
    keys.trace(owner, archive, trace.content_hash),
    gzipJson(trace),
    "application/gzip",
    reused ? "replace" : "immutable",
  );
  // The change entry goes before the pointer (decision 7 of 18): a run stopped between the two
  // leaves an entry for a rewrite that did not happen, which readers take as "read the session
  // again" and find it as it was; the next run rewrites it and writes another.
  const rewrite = step((existing) => {
    const { applied, withheld_calls: _withheld, ...rest } = existing;
    // A drop names no trace object, and it is what explains records review left out between
    // or after the traces (checkStore's chain_gap): it stays (33).
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
  // The old objects go last: a run stopped before this leaves them behind, which the sweep
  // deletes (the next run's, or the worker's daily one), and no read serves them meanwhile: the
  // trace routes and `getTrace` serve only a hash the pointer names.
  for (const hash of old) {
    if (hash !== trace.content_hash) await store.delete(keys.trace(owner, archive, hash));
  }
  return { ...base, outcome: "rewritten", counts, content_hash: trace.content_hash };
}

/** A session's span records through the current rules (see the top of this file): how many
 * an earlier rule set redacted, each rewritten in place unless `dryRun`, and then the messages
 * only the old records named deleted. */
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
  /** Messages some record names after this pass. */
  const named = new Set<string>();
  /** Messages a rewritten record named before and no longer does. */
  const replaced = new Set<string>();
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
    for (const hash of before) if (!after.has(hash)) replaced.add(hash);
  }
  for (const hash of named) replaced.delete(hash);
  if (replaced.size > 0) {
    // Read the records again just before deleting: a span that arrived during the pass from a
    // server still on the old rules may name an old message, which then stays.
    for await (const record of spanRecords(store, owner, archive)) {
      for (const hash of storedHashes(record.input)) replaced.delete(hash);
    }
    for (const hash of replaced) await store.delete(keys.spanMessage(owner, archive, hash));
  }
  return done;
}

/** Run the backfill over the store (see the top of this file). */
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
      // A stub (F3.4) has no trace to redact, but an assembled session's span records are kept
      // beside it, as for a session never published.
      if (done.outcome !== "skipped" || isStub(session)) {
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
