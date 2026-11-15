/** The indexer (F10.2): it tails every owner's change feed (`owners/<owner>/changes/`) and keeps
 * the index in step. A change entry says which session changed; the session's own metadata
 * says what it is now, and that is what gets indexed:
 *
 * - `published`: the session's new traces are read and their events added. When the index
 *   already holds the earlier traces of the session (a continuation), only the new ones are
 *   read; when it does not, or the publish replaced the session (X4.6), it is read again from
 *   its last whole trace.
 * - `tombstone`: the session is dropped.
 * - `visibility_changed`: the session's visibility is updated (F10.4).
 *
 * Indexing from the metadata rather than from the entry alone makes every step idempotent and
 * order-free: an entry read twice, entries out of order, or a session whose later entry is lost
 * (a crash between the pointer update and the change entry) still end with the index matching
 * the session as it is. Sessions dropped by model review never reach the feed, so they are
 * never indexed.
 *
 * Every update carries when its metadata was read (`SessionUpdate.read_at`), and the index
 * refuses one read before what it holds, so processes sharing one index file never undo each
 * other. The metadata's own `updated_at` is not used to order updates: several writers stamp it
 * with clocks that disagree, and a continuation written by a machine whose clock is behind
 * would look older than what it extends.
 *
 * An object that cannot be decoded (a corrupt or foreign metadata or trace object) is skipped
 * with a warning rather than failing the run: one bad object must not stop an owner's feed, or
 * keep a new index from ever becoming ready. Store errors still fail the run, which is retried.
 *
 * Change keys are stamped by the writer's clock (a laptop in local mode), so the indexer re-reads
 * a lag window behind its cursor and skips the keys it already processed (`spec/layout.md`).
 * Owners have no list of their own (X5.8): the indexer lists `owners/` and refreshes that list
 * every so often. */

import {
  type ChangeEntry,
  canonicalText,
  type EventRole,
  type SessionMetadata,
  type Trace,
} from "@seshi/model";
import {
  changeStamp,
  decodeJson,
  getBytes,
  gunzipJson,
  keys,
  listOwners,
  type Store,
  stampTime,
} from "@seshi/store";
import type { IndexedEvent, IndexedSession, IndexStore, SessionUpdate } from "./backend";

/** How far behind its cursor the indexer re-reads each feed, for entries stamped by a clock
 * that runs behind. */
export const FEED_LAG_MS = 5 * 60 * 1000;
/** Change keys listed per request. */
export const FEED_PAGE = 500;
/** Change entries one run reads before it yields (and says more is waiting). */
export const RUN_BUDGET = 5000;
/** How often the list of owners is read again (a new owner's sessions are found within it). */
export const OWNER_REFRESH_MS = 60 * 1000;
/** Bucket reads in flight at once. */
const CONCURRENCY = 8;

const HEX64 = /^[0-9a-f]{64}$/;

export interface IndexerLogger {
  warn(line: string): void;
}

export interface IndexerOptions {
  store: Store;
  index: IndexStore;
  /** Which event roles are indexed (`search.events`). */
  events: readonly EventRole[];
  now?: () => Date;
  log?: IndexerLogger;
  lagMs?: number;
  pageSize?: number;
  budget?: number;
  ownerRefreshMs?: number;
}

/** What one run did. */
export interface IndexerRun {
  /** The run stopped at its budget with entries still to read. */
  more: boolean;
  /** Every owner's feed was read to its end: the index is caught up (and ready). */
  caught_up: boolean;
  owners: number;
  /** Change entries read. */
  entries: number;
  /** Sessions whose index rows changed. */
  indexed: number;
  /** Sessions dropped from the index. */
  removed: number;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function epoch(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The traces that make up the session now: from its last whole trace (one with no
 * `continuation`) to the head. A replace leaves one trace; a session extended by chunks keeps
 * its first trace and every continuation. */
export function currentTraces(metadata: SessionMetadata): string[] {
  let start = 0;
  metadata.traces.forEach((t, i) => {
    if (t.continuation === undefined) start = i;
  });
  return metadata.traces.slice(start).map((t) => t.content_hash);
}

/** A trace's events whose role is indexed, as index documents. One addition: the trace's
 * events leave out what the assistant said alongside tool calls (the record fans out into its
 * `tool_call` events), and that text is assistant text F10.1 asks to search, so it is indexed
 * as an `assistant` document pointing at the record's first event. */
export function searchableEvents(
  hash: string,
  trace: Trace,
  roles: ReadonlySet<EventRole>,
): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const event of trace.events) {
    if (!roles.has(event.role) || event.text === "") continue;
    const timestamp = epoch(event.timestamp);
    out.push({
      content_hash: hash,
      event_index: event.index,
      role: event.role,
      ...(event.tool_name !== undefined ? { tool_name: event.tool_name } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      text: event.text,
    });
  }
  if (!roles.has("assistant")) return out;
  // Walk the records as the events were derived (model's parse.ts) to find each record's
  // first event.
  let next = 0;
  for (const record of trace.records.slice(1)) {
    if (record.role === "meta") continue;
    if (record.role !== "assistant") {
      next++;
      continue;
    }
    const calls = record.tool_calls?.length ?? 0;
    if (calls > 0 && record.content) {
      const text = canonicalText(record.content);
      const timestamp = epoch(record.timestamp);
      if (text !== "") {
        out.push({
          content_hash: hash,
          event_index: next,
          role: "assistant",
          ...(timestamp !== undefined ? { timestamp } : {}),
          text,
        });
      }
    }
    next += calls > 0 ? calls : record.content ? 1 : 0;
  }
  return out;
}

function startsWith(list: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= list.length && prefix.every((h, i) => list[i] === h);
}

/** A trace read for indexing, with its index documents. */
interface ReadTrace {
  trace: Trace;
  events: IndexedEvent[];
}

/** What to do to one session, decided from its metadata before anything is written. */
type Plan =
  | { kind: "remove"; owner: string; archive: string; read_at: number }
  | { kind: "apply"; update: SessionUpdate }
  | { kind: "none" };

export class Indexer {
  private readonly store: Store;
  private readonly index: IndexStore;
  private readonly roles: ReadonlySet<EventRole>;
  private readonly now: () => Date;
  private readonly log: IndexerLogger | undefined;
  private readonly lagMs: number;
  private readonly pageSize: number;
  private readonly budget: number;
  private readonly ownerRefreshMs: number;
  private owners: { list: string[]; at: number } | undefined;
  private running: Promise<IndexerRun> | undefined;

  constructor(options: IndexerOptions) {
    this.store = options.store;
    this.index = options.index;
    this.roles = new Set(options.events);
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.lagMs = options.lagMs ?? FEED_LAG_MS;
    this.pageSize = options.pageSize ?? FEED_PAGE;
    this.budget = options.budget ?? RUN_BUDGET;
    this.ownerRefreshMs = options.ownerRefreshMs ?? OWNER_REFRESH_MS;
  }

  /** One pass over every owner's feed, up to the run's budget. A second call while one runs
   * waits for that run. */
  run(signal: AbortSignal = new AbortController().signal): Promise<IndexerRun> {
    if (!this.running) {
      this.running = this.pass(signal).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Runs until the index has caught up with every feed (or `signal` aborts). */
  async catchUp(signal: AbortSignal = new AbortController().signal): Promise<IndexerRun> {
    const total: IndexerRun = {
      more: false,
      caught_up: false,
      owners: 0,
      entries: 0,
      indexed: 0,
      removed: 0,
    };
    for (;;) {
      const run = await this.run(signal);
      total.owners = run.owners;
      total.entries += run.entries;
      total.indexed += run.indexed;
      total.removed += run.removed;
      total.caught_up = run.caught_up;
      if (!run.more || signal.aborted) return total;
    }
  }

  /** Forget the owners list, so the next run reads it again (after a rebuild). */
  forgetOwners(): void {
    this.owners = undefined;
  }

  /** Every owner folder. Listing them costs one request per owner, so the list is kept for
   * `ownerRefreshMs`; an empty list (a new deployment) is read again on every run, so the first
   * sessions are found at once. */
  private async ownerList(): Promise<string[]> {
    const now = this.now().getTime();
    const cached = this.owners;
    if (cached && cached.list.length > 0 && now - cached.at < this.ownerRefreshMs) {
      return cached.list;
    }
    const list: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listOwners(this.store, { after, limit: 1000 });
      list.push(...page.owners);
      if (!page.truncated || page.cursor === undefined) break;
      after = page.cursor;
    }
    this.owners = { list, at: now };
    return list;
  }

  private async pass(signal: AbortSignal): Promise<IndexerRun> {
    const run: IndexerRun = {
      more: false,
      caught_up: false,
      owners: 0,
      entries: 0,
      indexed: 0,
      removed: 0,
    };
    const generation = this.index.generation();
    const owners = await this.ownerList();
    run.owners = owners.length;
    for (const owner of owners) {
      if (signal.aborted) return run;
      const more = await this.drain(owner, run, signal, generation);
      if (more) {
        run.more = true;
        return run;
      }
    }
    if (signal.aborted) return run;
    // Not when the index was reset during the pass: the pass did not read the rebuilt feed.
    const caughtUp = this.index.transaction(() => {
      if (this.index.generation() !== generation) return false;
      this.index.caughtUp(this.now().toISOString());
      return true;
    });
    run.more = !caughtUp;
    run.caught_up = caughtUp;
    return run;
  }

  /** Where re-reading `owner`'s feed starts: the lag window behind its cursor. */
  private windowStart(prefix: string, cursor: string): string {
    const at = stampTime(cursor.slice(prefix.length));
    if (at === null) return cursor;
    return `${prefix}${changeStamp(new Date(Math.max(0, at - this.lagMs)).toISOString())}`;
  }

  /** Read `owner`'s feed from its cursor, a page at a time. True when the run's budget ran
   * out with more to read, or the index was reset under it (`generation`). */
  private async drain(
    owner: string,
    run: IndexerRun,
    signal: AbortSignal,
    generation: string,
  ): Promise<boolean> {
    const prefix = keys.changes(owner);
    const cursor = this.index.cursor(owner);
    let startAfter = cursor === undefined ? undefined : this.windowStart(prefix, cursor);
    for (;;) {
      if (signal.aborted) return false;
      const page = await this.store.list(prefix, { startAfter, limit: this.pageSize });
      const listed = page.keys.filter(
        (k) => k.endsWith(".json") && stampTime(k.slice(prefix.length)) !== null,
      );
      const seen = this.index.seen(owner, listed);
      const fresh = listed.filter((k) => !seen.has(k));
      const entries = await mapLimit(fresh, CONCURRENCY, (key) => this.entry(key));
      const archives = [
        ...new Set(
          entries
            .filter((e): e is ChangeEntry => e !== null && HEX64.test(e.archive_id))
            .map((e) => e.archive_id),
        ),
      ];
      const plans = await mapLimit(archives, CONCURRENCY, (a) => this.plan(owner, a));
      const last = page.keys.at(-1);
      const held = this.index.cursor(owner);
      const next = held === undefined || (last !== undefined && last > held) ? last : held;
      const nextAt = next === undefined ? undefined : stampTime(next.slice(prefix.length));
      const refused: string[] = [];
      const reset = this.index.transaction(() => {
        if (this.index.generation() !== generation) return true;
        for (const plan of plans) {
          if (!this.applyPlan(plan, run) && plan.kind === "apply") {
            refused.push(plan.update.session.archive_id);
          }
        }
        this.index.advance(
          owner,
          next,
          fresh.map((key) => ({ key, at: stampTime(key.slice(prefix.length)) ?? 0 })),
          nextAt === null || nextAt === undefined ? 0 : nextAt - this.lagMs,
        );
        return false;
      });
      // Reset (rebuilt) since this run started: write nothing, and let the next run start over.
      if (reset) return true;
      // An update refused because another process changed the session in between: plan it
      // again from what the index holds now.
      for (const archive of refused) this.applyPlan(await this.plan(owner, archive), run);
      run.entries += fresh.length;
      if (!page.truncated || last === undefined) return false;
      startAfter = last;
      if (run.entries >= this.budget) return true;
    }
  }

  private async entry(key: string): Promise<ChangeEntry | null> {
    const bytes = await getBytes(this.store, key);
    if (bytes === null) return null;
    try {
      return decodeJson<ChangeEntry>(bytes);
    } catch {
      this.log?.warn(`search: skipped an unreadable change entry: ${key}`);
      return null;
    }
  }

  /** Apply a plan to the index; false when the index refused it. */
  private applyPlan(plan: Plan, run: IndexerRun): boolean {
    if (plan.kind === "none") return true;
    if (plan.kind === "remove") {
      const held = this.index.session(plan.owner, plan.archive) !== null;
      // Refused only when another process read the session later; its view stands.
      if (this.index.remove(plan.owner, plan.archive, plan.read_at) && held) run.removed++;
      return true;
    }
    const applied = this.index.apply(plan.update);
    if (applied) run.indexed++;
    return applied;
  }

  /** What the index should do about one session, from its metadata and the traces the index
   * does not hold yet. */
  private async plan(owner: string, archive: string, attempt = 0): Promise<Plan> {
    // Taken before the read: a read that starts later sees this state or a newer one.
    const readAt = this.now().getTime();
    const metadata = await this.metadataOf(owner, archive);
    if (metadata === null || metadata.status === "redacted" || metadata.head === undefined) {
      return { kind: "remove", owner, archive, read_at: readAt };
    }
    const held = this.index.session(owner, archive);
    const wanted = currentTraces(metadata);
    const extends_ = held !== null && startsWith(wanted, held.traces);
    const toRead = extends_ ? wanted.slice((held as IndexedSession).traces.length) : wanted;
    const traces = await mapLimit(toRead, 4, (hash) => this.traceOf(owner, archive, hash));
    if (traces.some((t) => t === null) && attempt === 0) {
      // The session moved on (a replace deleted a trace) between the two reads: start over
      // from its metadata as it is now.
      return this.plan(owner, archive, 1);
    }
    const read = toRead
      .map((hash, i) => ({ hash, read: traces[i] ?? null }))
      .filter((t): t is { hash: string; read: ReadTrace } => t.read !== null)
      .map(({ hash, read }) => ({ hash, ...read }));
    if (read.length < toRead.length) {
      this.log?.warn(
        `search: ${toRead.length - read.length} trace(s) of a session of ${owner} could not be read; it is indexed without them`,
      );
    }
    const base = extends_ ? (held as IndexedSession).traces : [];
    const session = this.sessionFields(owner, metadata, read, extends_ ? held : null);
    session.traces = [...base, ...read.map((t) => t.hash)];
    const events = read.flatMap((t) => t.events);
    return {
      kind: "apply",
      update: {
        session,
        events,
        replace: !extends_,
        ...(extends_ ? { base } : {}),
        read_at: readAt,
      },
    };
  }

  /** A session's metadata; null when it is gone, or cannot be decoded (warned): a session the
   * index cannot read is one it cannot serve, so it is dropped. */
  private async metadataOf(owner: string, archive: string): Promise<SessionMetadata | null> {
    const bytes = await getBytes(this.store, keys.metadata(owner, archive));
    if (bytes === null) return null;
    try {
      const metadata = decodeJson<SessionMetadata>(bytes);
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !Array.isArray(metadata.traces) ||
        typeof metadata.agent !== "string" ||
        typeof metadata.session_id !== "string"
      ) {
        throw new Error("not session metadata");
      }
      return metadata;
    } catch {
      this.log?.warn(`search: skipped a session of ${owner} whose metadata cannot be read`);
      return null;
    }
  }

  /** A trace and its index documents; null when it is gone, or cannot be decoded (warned by
   * the caller). */
  private async traceOf(owner: string, archive: string, hash: string): Promise<ReadTrace | null> {
    const bytes = await getBytes(this.store, keys.trace(owner, archive, hash));
    if (bytes === null) return null;
    try {
      const trace = gunzipJson<Trace>(bytes);
      if (!Array.isArray(trace?.events) || !Array.isArray(trace.records)) {
        throw new Error("not a trace");
      }
      return { trace, events: searchableEvents(hash, trace, this.roles) };
    } catch {
      return null;
    }
  }

  /** The session's index row: from its metadata, the traces read now, and (for a
   * continuation) what the index held. */
  private sessionFields(
    owner: string,
    metadata: SessionMetadata,
    read: readonly { trace: Trace }[],
    held: IndexedSession | null,
  ): IndexedSession {
    const starts = read.map((t) => epoch(t.trace.started_at)).filter((n) => n !== undefined);
    const ends = read.map((t) => epoch(t.trace.ended_at)).filter((n) => n !== undefined);
    if (held?.started_at !== undefined) starts.push(held.started_at);
    if (held?.ended_at !== undefined) ends.push(held.ended_at);
    const first = read[0]?.trace;
    const project = metadata.project ?? first?.project ?? held?.project;
    const branch = metadata.branch ?? first?.branch ?? first?.metadata.git_branch ?? held?.branch;
    const source = metadata.provenance?.source_id ?? metadata.writer.source_id;
    return {
      owner,
      archive_id: metadata.archive_id,
      agent: metadata.agent,
      session_id: metadata.session_id,
      ...(metadata.origin_agent ? { origin_agent: metadata.origin_agent } : {}),
      ...(metadata.native_session_id ? { native_session_id: metadata.native_session_id } : {}),
      ...(project ? { project } : {}),
      ...(branch ? { branch } : {}),
      ...(source ? { source_id: source } : {}),
      visibility: metadata.visibility,
      ...(starts.length > 0 ? { started_at: Math.min(...starts) } : {}),
      ...(ends.length > 0 ? { ended_at: Math.max(...ends) } : {}),
      updated_at: metadata.updated_at,
      traces: [],
    };
  }
}
