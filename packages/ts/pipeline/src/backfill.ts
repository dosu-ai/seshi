/** Redaction backfill (F2.5): apply the current rule set to sessions already stored, so a rule
 * added today also covers what was stored before it.
 *
 * For each session whose `metadata.redaction.rule_set` is not the current one, its traces (the
 * head and its continuations, in order) are read and joined into one record list, which is
 * redacted with the current rules. Then:
 *
 * - nothing changed: only the rule set is recorded on the session, so the next run skips it;
 * - something changed: one new trace object holds the whole redacted session, the pointer is
 *   moved to it (If-Match, X6.5; a session another write changed meanwhile is left for the next
 *   run), every earlier trace object is deleted (they hold what the new rules take out, F2.5's
 *   "deleted, not kept"), and a `published` change entry with `replace: true` and `reason:
 *   "redacted"` tells readers to drop what they held of the session and take the new trace.
 *
 * Redaction cannot be undone: unredacted data is never stored, so there is nothing to restore
 * from. The counts the new rules found are added to the session's (F2.3). Idempotent: a session
 * redacted with the current rules is skipped, and redacted records redact to themselves, so a
 * run can be stopped and started again.
 *
 * Not touched: `normalized` (the uploader's log state). A later whole upload of such a session,
 * redacted from the transcript with the same new rules, may not hash to the stored prefix; it
 * is then a 409 `conflict`, which the uploader answers with `replace` (as after any rules
 * change, 04). Chunks continue as before. `applied` is cleared, since its answers name trace
 * objects that are gone (as a replace does, X4.6). */

import {
  canonicalJson,
  type LlmCall,
  type NormalizedRecord,
  parseTrace,
  type RedactionSummary,
  type SessionMetadata,
  type Trace,
  type TraceMetadata,
  TrajectoryError,
  type Writer,
} from "@seshi/model";
import { type Redactor, redactLlmCalls } from "@seshi/redact";
import {
  appendChange,
  gzipJson,
  isOwner,
  keys,
  listOwners,
  publishObject,
  type Store,
  updateMetadata,
} from "@seshi/store";
import { getTrace, listSessions, type WithheldCallIds } from "./ingest";

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
  /** Stopped at `limit` or by the signal before every session was looked at. */
  more: boolean;
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
  if (session.redaction?.rule_set === redactor.rule_set) return { ...base, outcome: "current" };

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
          const next = { ...existing, redaction: redaction(existing) };
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
  let basis: SessionMetadata["owner_basis"] = session.owner_basis;
  try {
    await updateMetadata(
      store,
      owner,
      archive,
      step((existing) => {
        basis = existing.owner_basis;
        const { applied: _applied, withheld_calls: _withheld, ...rest } = existing;
        const next: SessionMetadata = {
          ...rest,
          head: trace.content_hash,
          traces: [
            {
              content_hash: trace.content_hash,
              created_at: at,
              records: trace.records.length,
              ...(continuation ? { continuation } : {}),
            },
          ],
          redaction: redaction(existing),
          updated_at: at,
        };
        const ids = withheld(existing);
        if (ids) next.withheld_calls = ids;
        return next;
      }),
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
  // The change entry first: a run stopped between the two leaves old objects behind (harmless,
  // the pointer no longer names them), never a rewritten session no reader is told of (the next
  // run finds it current and would not tell them either).
  await appendChange(store, {
    kind: "published",
    at,
    owner,
    archive_id: archive,
    session_id: session.session_id,
    content_hash: trace.content_hash,
    writer: options.writer,
    owner_basis: basis,
    ...(continuation ? { continuation } : {}),
    replace: true,
    reason: "redacted",
  });
  for (const hash of old) {
    if (hash !== trace.content_hash) await store.delete(keys.trace(owner, archive, hash));
  }
  return { ...base, outcome: "rewritten", counts, content_hash: trace.content_hash };
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
    more: false,
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
  }
  return report;
}
