import {
  type ChangeEntry,
  canonicalText,
  DEFAULT_SEARCH_MAX_CHARS,
  type EventRole,
  type LlmCall,
  type SessionMetadata,
  type Trace,
} from "@seshi/model";
import {
  changeStamp,
  decodeJson,
  decodeMetadata,
  decodeTrace,
  entryWithFormat,
  getBytes,
  keys,
  listOwners,
  parseChangeKey,
  type Store,
  stampTime,
} from "@seshi/store";
import type {
  IndexedEvent,
  IndexedLlmCall,
  IndexedSession,
  IndexWriter,
  Removal,
  SessionUpdate,
} from "./backend";

export const FEED_LAG_MS = 5 * 60 * 1000;
export const FEED_PAGE = 500;
export const RUN_BUDGET = 5000;
export const OWNER_REFRESH_MS = 60 * 1000;
const CONCURRENCY = 8;

const HEX64 = /^[0-9a-f]{64}$/;

export interface IndexerLogger {
  warn(line: string): void;
}

export interface IndexerOptions {
  store: Store;
  index: IndexWriter;
  events: readonly EventRole[];
  /** How much of each role's text is indexed (`DEFAULT_SEARCH_MAX_CHARS` when omitted). */
  maxChars?: Readonly<Record<EventRole, number>>;
  now?: () => Date;
  log?: IndexerLogger;
  lagMs?: number;
  pageSize?: number;
  budget?: number;
  ownerRefreshMs?: number;
  /** Only these owners' feeds are read, without listing `owners/` (F11.9, scope `mine`: a key
   * limited to its own folder may not list the others); every owner's when omitted. */
  owners?: readonly string[];
  /** Only sessions this admits are indexed; one it stops admitting is removed (F11.9, scope
   * `visible`: others' owner-only sessions are left out). */
  admit?: (session: { owner: string; visibility?: SessionMetadata["visibility"] }) => boolean;
  /** Keep a copy of every change entry read, and how far every feed has been read, for the
   * cross-owner feed (`PageCommit.feed`, `IndexWriter.readThrough`). Only an index of every owner's
   * whole feed can serve it. */
  feed?: boolean;
}

export interface IndexerRun {
  /** The run stopped at its budget with entries still to read. */
  more: boolean;
  /** Every owner's feed was read to its end: the index is caught up (and ready). */
  caught_up: boolean;
  owners: number;
  entries: number;
  indexed: number;
  removed: number;
}

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

export function currentTraces(metadata: SessionMetadata): string[] {
  let start = 0;
  metadata.traces.forEach((t, i) => {
    if (t.continuation === undefined) start = i;
  });
  return metadata.traces.slice(start).map((t) => t.content_hash);
}

/** A trace's events the index keeps: those of `roles` with text, each cut to its role's cap
 * (`maxChars`) with its full length kept. `seq` counts from the trace's first event; the
 * indexer adds where the trace starts in the session. */
export function searchableEvents(
  hash: string,
  trace: Trace,
  roles: ReadonlySet<EventRole>,
  maxChars: Readonly<Record<EventRole, number>> = DEFAULT_SEARCH_MAX_CHARS,
): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  const cut = (role: EventRole, text: string) => {
    const cap = maxChars[role];
    return text.length > cap ? text.slice(0, cap) : text;
  };
  trace.events.forEach((event, seq) => {
    if (!roles.has(event.role) || event.text === "") return;
    const timestamp = epoch(event.timestamp);
    out.push({
      content_hash: hash,
      event_index: event.index,
      seq,
      role: event.role,
      ...(event.tool_name !== undefined ? { tool_name: event.tool_name } : {}),
      ...(event.tool_call_id !== undefined ? { tool_call_id: event.tool_call_id } : {}),
      ...(typeof event.ok === "boolean" ? { ok: event.ok } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      text: cut(event.role, event.text),
      chars: event.text.length,
    });
  });
  if (!roles.has("assistant")) return out;
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
          seq: next,
          role: "assistant",
          ...(timestamp !== undefined ? { timestamp } : {}),
          text: cut("assistant", text),
          chars: text.length,
        });
      }
    }
    next += calls > 0 ? calls : record.content ? 1 : 0;
  }
  return out;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** A trace's model calls as the index keeps them: `usage` flattened, times in epoch ms. */
export function indexedCalls(
  hash: string,
  calls: readonly LlmCall[] | undefined,
): IndexedLlmCall[] {
  const out: IndexedLlmCall[] = [];
  const seen = new Set<string>();
  for (const call of calls ?? []) {
    if (typeof call?.id !== "string" || call.id === "" || seen.has(call.id)) continue;
    seen.add(call.id);
    const usage = call.usage ?? {};
    const fields: Omit<IndexedLlmCall, "content_hash" | "call_id"> = {
      model: typeof call.model === "string" ? call.model : undefined,
      provider: typeof call.provider === "string" ? call.provider : undefined,
      started_at: epoch(call.started_at),
      ended_at: epoch(call.ended_at),
      duration_ms: count(call.duration_ms),
      input_tokens: count(usage.input_tokens),
      output_tokens: count(usage.output_tokens),
      cache_read_input_tokens: count(usage.cache_read_input_tokens),
      cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
      reasoning_tokens: count(usage.reasoning_tokens),
      total_tokens: count(usage.total_tokens),
      stop_reason: typeof call.stop_reason === "string" ? call.stop_reason : undefined,
      error: typeof call.error === "string" ? call.error : undefined,
    };
    out.push({
      content_hash: hash,
      call_id: call.id,
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    });
  }
  return out;
}

/** The traces from `hash` (a replacing entry's trace) to the head. When a later replace has
 * dropped that trace since, the session as it is now (`currentTraces`). */
export function tracesFrom(metadata: SessionMetadata, hash: string): string[] {
  const at = metadata.traces.findIndex((t) => t.content_hash === hash);
  return at < 0 ? currentTraces(metadata) : metadata.traces.slice(at).map((t) => t.content_hash);
}

export function shows(metadata: SessionMetadata | null, entry: ChangeEntry): boolean {
  if (metadata === null) return entry.kind === "tombstone";
  if (metadata.status === "redacted") return true;
  if (entry.kind === "tombstone") return false;
  if (entry.kind === "visibility_changed") return metadata.visibility === entry.visibility;
  if (entry.content_hash === null) return true;
  if (entry.replace === true) return metadata.traces[0]?.content_hash === entry.content_hash;
  return metadata.traces.some((t) => t.content_hash === entry.content_hash);
}

function startsWith(list: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= list.length && prefix.every((h, i) => list[i] === h);
}

/** What a session's fields take from a trace. The rest of it (its records) is not kept, so a
 * batch can hold the traces it read. */
type TraceFacts = Pick<Trace, "started_at" | "ended_at" | "project" | "branch" | "source"> & {
  metadata: Pick<Trace["metadata"], "git_branch" | "agent_version">;
};

interface ReadTrace {
  trace: TraceFacts;
  /** Its searchable events, `seq` counted from the trace's start. */
  events: IndexedEvent[];
  /** How many events it holds, searchable or not. */
  count: number;
  llm_calls: IndexedLlmCall[];
}

interface Replaced {
  content_hash: string;
  /** The replace removed text that must leave the index's storage (a redaction backfill). */
  scrub: boolean;
}

type Plan =
  | { kind: "remove"; removal: Removal; metadata: SessionMetadata | null }
  | { kind: "apply"; update: SessionUpdate; metadata: SessionMetadata };

/** The records a plan writes: its session's row, and its events. */
function weight(plan: Plan): number {
  return 1 + (plan.kind === "apply" ? plan.update.events.length : 0);
}

/** Feed pages of one owner gathered for one commit. */
interface Batch {
  /** The entries read, in feed order (null: unreadable or gone). */
  entries: { key: string; entry: ChangeEntry | null }[];
  /** One plan per session, from the last page that names it. */
  plans: Map<string, Plan>;
  /** What the index held of the batch's sessions before it. */
  holds: Map<string, IndexedSession>;
  replaced: Map<string, Replaced>;
  /** The traces read for the batch's plans, by archive, then hash: a session planned again on
   * a later page reads only the traces it has not read yet. During a build the index holds
   * nothing of it, so each plan is a whole read, not an extension of the last. */
  traces: Map<string, Map<string, ReadTrace>>;
  records: number;
}

/** The traces `batch` has read of `archive`, by hash. */
function tracesOf(batch: Batch, archive: string): Map<string, ReadTrace> {
  let read = batch.traces.get(archive);
  if (!read) {
    read = new Map();
    batch.traces.set(archive, read);
  }
  return read;
}

function newBatch(): Batch {
  return {
    entries: [],
    plans: new Map(),
    holds: new Map(),
    replaced: new Map(),
    traces: new Map(),
    records: 0,
  };
}

export class Indexer {
  private readonly store: Store;
  private readonly index: IndexWriter;
  private readonly roles: ReadonlySet<EventRole>;
  private readonly maxChars: Readonly<Record<EventRole, number>>;
  private readonly now: () => Date;
  private readonly log: IndexerLogger | undefined;
  private readonly lagMs: number;
  private readonly pageSize: number;
  private readonly budget: number;
  private readonly ownerRefreshMs: number;
  private readonly fixedOwners: readonly string[] | undefined;
  private readonly admit: IndexerOptions["admit"];
  private readonly keepFeed: boolean;
  private owners: { list: string[]; at: number } | undefined;
  private running: Promise<IndexerRun> | undefined;
  /** For the cross-owner feed: how far each owner's feed has been read (epoch ms), under the
   * index generation it was read for. An owner read to its end by a listing at `t` has had
   * every entry written before `t` read; one stopped at its budget, every entry stamped up to
   * its cursor. */
  private readTo: { generation: string; owners: Map<string, number> } | undefined;
  /** The owner a pass stopped at for its budget: the next pass starts after it, so the owners
   * behind a busy one are not left waiting. */
  private resumeAfter: string | undefined;

  constructor(options: IndexerOptions) {
    this.store = options.store;
    this.index = options.index;
    this.roles = new Set(options.events);
    this.maxChars = options.maxChars ?? DEFAULT_SEARCH_MAX_CHARS;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.lagMs = options.lagMs ?? FEED_LAG_MS;
    this.pageSize = options.pageSize ?? FEED_PAGE;
    this.budget = options.budget ?? RUN_BUDGET;
    this.ownerRefreshMs = options.ownerRefreshMs ?? OWNER_REFRESH_MS;
    this.fixedOwners = options.owners;
    this.admit = options.admit;
    this.keepFeed = options.feed ?? false;
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

  forgetOwners(): void {
    this.owners = undefined;
  }

  /** The owners to read, and when that list was taken: an owner not on it had written
   * nothing then, so each of its entries was written after `at`. */
  private async ownerList(): Promise<{ list: string[]; at: number }> {
    const now = this.now().getTime();
    if (this.fixedOwners) return { list: [...this.fixedOwners], at: now };
    const cached = this.owners;
    if (cached && cached.list.length > 0 && now - cached.at < this.ownerRefreshMs) {
      return cached;
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
    return this.owners;
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
    const generation = await this.index.generation();
    const { list, at: listedAt } = await this.ownerList();
    run.owners = list.length;
    if (this.readTo?.generation !== generation) {
      this.readTo = { generation, owners: new Map() };
    }
    const readTo = this.readTo.owners;
    const gather = (await this.index.batchRecords?.(generation)) ?? 0;
    const start = this.resumeAfter === undefined ? 0 : list.indexOf(this.resumeAfter) + 1;
    this.resumeAfter = undefined;
    try {
      for (const owner of [...list.slice(start), ...list.slice(0, start)]) {
        if (signal.aborted) return run;
        const more = await this.drain(owner, run, signal, generation, readTo, gather);
        if (more) {
          this.resumeAfter = owner;
          run.more = true;
          return run;
        }
      }
    } finally {
      await this.feedRead(list, listedAt, readTo, generation);
    }
    if (signal.aborted) return run;
    const caughtUp = await this.index.passDone(generation, this.now().toISOString());
    run.more = !caughtUp;
    run.caught_up = caughtUp;
    await this.index.maintain(signal);
    return run;
  }

  /** Move the cross-owner feed's bound to the least any listed owner's feed has been read to,
   * and no later than when the list was taken (an owner not on it had written nothing then).
   * One owner with more than a pass can read holds it back without stopping it. */
  private async feedRead(
    list: readonly string[],
    listedAt: number,
    readTo: ReadonlyMap<string, number>,
    generation: string,
  ): Promise<void> {
    if (!this.keepFeed) return;
    let through = listedAt;
    for (const owner of list) {
      const at = readTo.get(owner);
      if (at === undefined) return;
      through = Math.min(through, at);
    }
    await this.index.readThrough(generation, new Date(through).toISOString());
  }

  private windowStart(prefix: string, cursor: string): string {
    const at = stampTime(cursor.slice(prefix.length));
    if (at === null) return cursor;
    return `${prefix}${changeStamp(new Date(Math.max(0, at - this.lagMs)).toISOString())}`;
  }

  /** Reads `owner`'s feed from its cursor, one page per commit, or pages gathered until they
   * hold `gather` records or the pass's budget of entries. The entry bound matters when pages
   * keep naming a few long sessions: planning one again replaces its records rather than
   * adding to them, so the records may never reach `gather`. True when the pass should stop
   * here: the budget is spent, or the index was reset. */
  private async drain(
    owner: string,
    run: IndexerRun,
    signal: AbortSignal,
    generation: string,
    readTo: Map<string, number>,
    gather: number,
  ): Promise<boolean> {
    const prefix = keys.changes(owner);
    const reached = (at: number | null | undefined) => {
      if (at === null || at === undefined) return;
      readTo.set(owner, Math.max(readTo.get(owner) ?? at, at));
    };
    let held = (await this.index.cursors(generation, [owner])).get(owner);
    let startAfter = held === undefined ? undefined : this.windowStart(prefix, held);
    let batch = newBatch();
    for (;;) {
      // An abort drops the pages gathered and not committed: the cursor has not passed them.
      if (signal.aborted) return false;
      const listedAt = this.now().getTime();
      const page = await this.store.list(prefix, { startAfter, limit: this.pageSize });
      const listed = page.keys.filter((k) => parseChangeKey(k.slice(prefix.length)) !== null);
      const seen = await this.index.seen(generation, owner, listed);
      const fresh = listed.filter((k) => !seen.has(k));
      const entries = await mapLimit(fresh, CONCURRENCY, (key) => this.entry(key));
      await this.gather(owner, generation, batch, fresh, entries);
      const last = page.keys.at(-1);
      const next = held === undefined || (last !== undefined && last > held) ? last : held;
      const nextAt = next === undefined ? undefined : stampTime(next.slice(prefix.length));
      held = next;
      const end = !page.truncated || last === undefined;
      if (end || batch.records >= gather || batch.entries.length >= this.budget) {
        if (await this.flush(owner, generation, run, batch, prefix, next, nextAt)) return true;
        batch = newBatch();
        if (end) {
          reached(listedAt);
          return false;
        }
        if (run.entries >= this.budget) {
          reached(nextAt);
          return true;
        }
      }
      startAfter = last;
    }
  }

  /** Adds one page to `batch`: its entries, and a plan for each session it names. A session
   * the batch already planned is planned again, from its metadata as it is now, which is
   * newer than the entries on this page; both plans start from what the index held before the
   * batch, as the commit checks them against that. */
  private async gather(
    owner: string,
    generation: string,
    batch: Batch,
    fresh: readonly string[],
    entries: readonly (ChangeEntry | null)[],
  ): Promise<void> {
    const named = entries.filter((e): e is ChangeEntry => e !== null && HEX64.test(e.archive_id));
    const archives = [...new Set(named.map((e) => e.archive_id))];
    for (const e of named) {
      if (e.kind === "published" && e.replace === true && e.content_hash) {
        // A publish names a reason only for a redaction backfill (F2.5).
        const scrub = e.reason !== undefined || batch.replaced.get(e.archive_id)?.scrub === true;
        batch.replaced.set(e.archive_id, { content_hash: e.content_hash, scrub });
        // A redaction backfill rewrites a trace in place, under the same hash (F2.5).
        batch.traces.delete(e.archive_id);
      }
    }
    const unread = archives.filter((a) => !batch.plans.has(a));
    for (const [a, session] of await this.index.sessions(generation, owner, unread)) {
      batch.holds.set(a, session);
    }
    const plans = await mapLimit(archives, CONCURRENCY, (a) =>
      this.plan(owner, a, batch.holds.get(a) ?? null, batch.replaced.get(a), tracesOf(batch, a)),
    );
    archives.forEach((a, i) => {
      const plan = plans[i] as Plan;
      const earlier = batch.plans.get(a);
      if (earlier) batch.records -= weight(earlier);
      batch.plans.set(a, plan);
      batch.records += weight(plan);
    });
    batch.entries.push(...fresh.map((key, i) => ({ key, entry: entries[i] ?? null })));
  }

  /** Commits `batch`, content first and the cursor (`next`) last, then plans again and commits
   * the sessions the index refused. True when the index was reset. */
  private async flush(
    owner: string,
    generation: string,
    run: IndexerRun,
    batch: Batch,
    prefix: string,
    next: string | undefined,
    nextAt: number | null | undefined,
  ): Promise<boolean> {
    const plans = [...batch.plans.values()];
    const metadata = new Map([...batch.plans].map(([a, plan]) => [a, plan.metadata]));
    const nowMs = this.now().getTime();
    const done = batch.entries.filter(({ key, entry }) => {
      if (!entry || !HEX64.test(entry.archive_id)) return true;
      const at = parseChangeKey(key.slice(prefix.length))?.at ?? 0;
      if (nowMs - at >= this.lagMs) return true;
      return shows(metadata.get(entry.archive_id) ?? null, entry);
    });
    const committed = await this.index.commit({
      generation,
      owner,
      ...this.planned(plans),
      feed: this.keepFeed
        ? batch.entries.flatMap(({ key, entry }) => {
            const named = entry && this.named(entry, metadata, batch.holds);
            return named ? [{ name: key.slice(prefix.length), entry: named }] : [];
          })
        : [],
      seen: done.map(({ key }) => ({ key, at: stampTime(key.slice(prefix.length)) ?? 0 })),
      cursor: next,
      forgetBefore: nextAt === null || nextAt === undefined ? 0 : nextAt - this.lagMs,
    });
    if (committed.stale) return true;
    this.counted(run, plans, committed.refused, committed.removed);
    run.entries += batch.entries.length;
    if (committed.refused.length > 0) {
      // Another process got to these sessions first: plan them again from what it wrote.
      const again = await this.index.sessions(generation, owner, committed.refused);
      const retries = await mapLimit(committed.refused, CONCURRENCY, (a) =>
        this.plan(owner, a, again.get(a) ?? null, batch.replaced.get(a), tracesOf(batch, a)),
      );
      const retried = await this.index.commit({
        generation,
        owner,
        ...this.planned(retries),
        feed: [],
        seen: [],
        cursor: undefined,
        forgetBefore: 0,
      });
      if (retried.stale) return true;
      this.counted(run, retries, retried.refused, retried.removed);
    }
    return false;
  }

  private planned(plans: readonly Plan[]): { updates: SessionUpdate[]; removals: Removal[] } {
    const updates: SessionUpdate[] = [];
    const removals: Removal[] = [];
    for (const plan of plans) {
      if (plan.kind === "apply") updates.push(plan.update);
      else removals.push(plan.removal);
    }
    return { updates, removals };
  }

  private counted(
    run: IndexerRun,
    plans: readonly Plan[],
    refused: readonly string[],
    removed: number,
  ): void {
    run.indexed += plans.filter((p) => p.kind === "apply").length - refused.length;
    run.removed += removed;
  }

  /** The entry as the cross-owner feed serves it: one written before seshi 0.16 has no
   * `format`, so it gets its session's, from the metadata just read or else from what the index
   * holds of the session. Without either it names a write that never landed (its entry is
   * written first), as `readChanges` has it, and is left out of the feed. */
  private named(
    entry: ChangeEntry,
    metadata: ReadonlyMap<string, SessionMetadata | null>,
    holds: ReadonlyMap<string, IndexedSession>,
  ): ChangeEntry | null {
    if (entry.format !== undefined) return entry;
    const read = metadata.get(entry.archive_id);
    // A session with no metadata is removed by this page, so the index's copy of it is not
    // used. The removal can be refused (another process sharing the index read the session
    // later), and then the index still holds it, but this page cannot know that: the feed copy
    // is written in the same commit as the removal and the cursor. So such an entry, written
    // before 0.16 and naming a session whose metadata is gone, is left out, as `readChanges`
    // leaves it out of the owner's own feed.
    const format = read === null ? undefined : read?.format || holds.get(entry.archive_id)?.format;
    return format ? entryWithFormat(entry, format) : null;
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

  /** What to do with a session, from its metadata now and what the index holds of it. Traces
   * already in `cache` are not read again; those read are added to it. */
  private async plan(
    owner: string,
    archive: string,
    held: IndexedSession | null,
    replaced: Replaced | undefined,
    cache: Map<string, ReadTrace>,
    attempt = 0,
  ): Promise<Plan> {
    const { readAt, metadata } = await this.stampedMetadata(owner, archive);
    const gone = metadata === null || metadata.status === "redacted" || metadata.head === undefined;
    if (
      gone ||
      (this.admit !== undefined && !this.admit({ owner, visibility: metadata.visibility }))
    ) {
      return { kind: "remove", removal: { archive, read_at: readAt, scrub: gone }, metadata };
    }
    const wanted = replaced ? tracesFrom(metadata, replaced.content_hash) : currentTraces(metadata);
    const extends_ = !replaced && held !== null && startsWith(wanted, held.traces);
    const toRead = extends_ ? wanted.slice((held as IndexedSession).traces.length) : wanted;
    const traces = await mapLimit(toRead, 4, async (hash) => {
      const known = cache.get(hash);
      if (known) return known;
      // A trace that could not be read is not remembered: the second attempt reads it again.
      const read = await this.traceOf(owner, archive, hash);
      if (read) cache.set(hash, read);
      return read;
    });
    if (traces.some((t) => t === null) && attempt === 0) {
      return this.plan(owner, archive, held, replaced, cache, 1);
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
    // Each trace's events take their `seq`s after those of the traces before it.
    let start = extends_ ? (held as IndexedSession).event_count : 0;
    const events: IndexedEvent[] = [];
    for (const t of read) {
      for (const e of t.events) events.push({ ...e, seq: start + e.seq });
      start += t.count;
    }
    session.event_count = start;
    return {
      kind: "apply",
      metadata,
      update: {
        session,
        events,
        llm_calls: read.flatMap((t) => t.llm_calls),
        replace: !extends_,
        ...(extends_ ? { base } : {}),
        read_at: readAt,
        ...(replaced?.scrub ? { scrub: true } : {}),
      },
    };
  }

  private async stampedMetadata(
    owner: string,
    archive: string,
  ): Promise<{ readAt: number; metadata: SessionMetadata | null }> {
    const readAt = this.now().getTime();
    const bytes = await getBytes(this.store, keys.metadata(owner, archive));
    if (bytes === null) return { readAt, metadata: null };
    try {
      const metadata = decodeMetadata(bytes);
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !Array.isArray(metadata.traces) ||
        typeof metadata.format !== "string" ||
        typeof metadata.session_id !== "string"
      ) {
        throw new Error("not session metadata");
      }
      return { readAt, metadata };
    } catch {
      this.log?.warn(`search: skipped a session of ${owner} whose metadata cannot be read`);
      return { readAt, metadata: null };
    }
  }

  private async traceOf(owner: string, archive: string, hash: string): Promise<ReadTrace | null> {
    const bytes = await getBytes(this.store, keys.trace(owner, archive, hash));
    if (bytes === null) return null;
    try {
      const trace = decodeTrace(bytes);
      if (!Array.isArray(trace?.events) || !Array.isArray(trace.records)) {
        throw new Error("not a trace");
      }
      const facts: TraceFacts = {
        started_at: trace.started_at,
        ended_at: trace.ended_at,
        project: trace.project,
        branch: trace.branch,
        source: trace.source,
        metadata: {
          git_branch: trace.metadata?.git_branch,
          agent_version: trace.metadata?.agent_version,
        },
      };
      return {
        trace: facts,
        events: searchableEvents(hash, trace, this.roles, this.maxChars),
        count: trace.events.length,
        llm_calls: indexedCalls(hash, trace.llm_calls),
      };
    } catch {
      return null;
    }
  }

  private sessionFields(
    owner: string,
    metadata: SessionMetadata,
    read: readonly { trace: TraceFacts }[],
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
    const harness = metadata.source ?? first?.source ?? held?.harness;
    const latest = read.at(-1)?.trace;
    const agentVersion =
      metadata.agent_version ?? latest?.metadata.agent_version ?? held?.agent_version;
    return {
      owner,
      archive_id: metadata.archive_id,
      format: metadata.format,
      session_id: metadata.session_id,
      ...(metadata.origin_agent ? { origin_agent: metadata.origin_agent } : {}),
      ...(metadata.native_session_id ? { native_session_id: metadata.native_session_id } : {}),
      ...(project ? { project } : {}),
      ...(branch ? { branch } : {}),
      ...(metadata.repo ? { repo: metadata.repo } : {}),
      ...(harness ? { harness } : {}),
      ...(agentVersion ? { agent_version: agentVersion } : {}),
      ...(metadata.models && metadata.models.length > 0 ? { models: metadata.models } : {}),
      ...(metadata.labels && Object.keys(metadata.labels).length > 0
        ? { labels: metadata.labels }
        : {}),
      ...(source ? { source_id: source } : {}),
      visibility: metadata.visibility,
      ...(starts.length > 0 ? { started_at: Math.min(...starts) } : {}),
      ...(ends.length > 0 ? { ended_at: Math.max(...ends) } : {}),
      updated_at: metadata.updated_at,
      traces: [],
      event_count: 0,
    };
  }
}
