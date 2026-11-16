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
  parseChangeKey,
  type Store,
  stampTime,
} from "@seshi/store";
import type { IndexedEvent, IndexedSession, IndexStore, SessionUpdate } from "./backend";

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
  index: IndexStore;
  events: readonly EventRole[];
  now?: () => Date;
  log?: IndexerLogger;
  lagMs?: number;
  pageSize?: number;
  budget?: number;
  ownerRefreshMs?: number;
  /** Only these owners' feeds are read; every owner's when omitted (F11.9, scope `mine`). */
  owners?: (owner: string) => boolean;
  /** Only sessions this admits are indexed; one it stops admitting is removed (F11.9, scope
   * `visible`: others' owner-only sessions are left out). */
  admit?: (session: { owner: string; visibility?: SessionMetadata["visibility"] }) => boolean;
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

interface ReadTrace {
  trace: Trace;
  events: IndexedEvent[];
}

interface Replaced {
  content_hash: string;
}

type Plan =
  | {
      kind: "remove";
      owner: string;
      archive: string;
      read_at: number;
      metadata: SessionMetadata | null;
    }
  | { kind: "apply"; update: SessionUpdate; metadata: SessionMetadata };

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
  private readonly ownerFilter: ((owner: string) => boolean) | undefined;
  private readonly admit: IndexerOptions["admit"];
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
    this.ownerFilter = options.owners;
    this.admit = options.admit;
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
      const filter = this.ownerFilter;
      list.push(...(filter ? page.owners.filter((o) => filter(o)) : page.owners));
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
    const caughtUp = this.index.transaction(() => {
      if (this.index.generation() !== generation) return false;
      this.index.caughtUp(this.now().toISOString());
      return true;
    });
    run.more = !caughtUp;
    run.caught_up = caughtUp;
    return run;
  }

  private windowStart(prefix: string, cursor: string): string {
    const at = stampTime(cursor.slice(prefix.length));
    if (at === null) return cursor;
    return `${prefix}${changeStamp(new Date(Math.max(0, at - this.lagMs)).toISOString())}`;
  }

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
      const listed = page.keys.filter((k) => parseChangeKey(k.slice(prefix.length)) !== null);
      const seen = this.index.seen(owner, listed);
      const fresh = listed.filter((k) => !seen.has(k));
      const entries = await mapLimit(fresh, CONCURRENCY, (key) => this.entry(key));
      const named = entries.filter((e): e is ChangeEntry => e !== null && HEX64.test(e.archive_id));
      const archives = [...new Set(named.map((e) => e.archive_id))];
      const replaced = new Map<string, Replaced>();
      for (const e of named) {
        if (e.kind === "published" && e.replace === true && e.content_hash) {
          replaced.set(e.archive_id, { content_hash: e.content_hash });
        }
      }
      const plans = await mapLimit(archives, CONCURRENCY, (a) =>
        this.plan(owner, a, replaced.get(a)),
      );
      const last = page.keys.at(-1);
      const held = this.index.cursor(owner);
      const next = held === undefined || (last !== undefined && last > held) ? last : held;
      const nextAt = next === undefined ? undefined : stampTime(next.slice(prefix.length));
      const metadata = new Map(archives.map((a, i) => [a, plans[i]?.metadata ?? null]));
      const nowMs = this.now().getTime();
      const done = fresh.filter((key, i) => {
        const entry = entries[i];
        if (!entry || !HEX64.test(entry.archive_id)) return true;
        const at = parseChangeKey(key.slice(prefix.length))?.at ?? 0;
        if (nowMs - at >= this.lagMs) return true;
        return shows(metadata.get(entry.archive_id) ?? null, entry);
      });
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
          done.map((key) => ({ key, at: stampTime(key.slice(prefix.length)) ?? 0 })),
          nextAt === null || nextAt === undefined ? 0 : nextAt - this.lagMs,
        );
        return false;
      });
      if (reset) return true;
      for (const archive of refused) {
        this.applyPlan(await this.plan(owner, archive, replaced.get(archive)), run);
      }
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

  private applyPlan(plan: Plan, run: IndexerRun): boolean {
    if (plan.kind === "remove") {
      const held = this.index.session(plan.owner, plan.archive) !== null;
      if (this.index.remove(plan.owner, plan.archive, plan.read_at) && held) run.removed++;
      return true;
    }
    const applied = this.index.apply(plan.update);
    if (applied) run.indexed++;
    return applied;
  }

  private async plan(
    owner: string,
    archive: string,
    replaced?: Replaced,
    attempt = 0,
  ): Promise<Plan> {
    const { readAt, metadata } = await this.stampedMetadata(owner, archive);
    if (
      metadata === null ||
      metadata.status === "redacted" ||
      metadata.head === undefined ||
      (this.admit !== undefined && !this.admit({ owner, visibility: metadata.visibility }))
    ) {
      return { kind: "remove", owner, archive, read_at: readAt, metadata };
    }
    const held = this.index.session(owner, archive);
    const wanted = replaced ? tracesFrom(metadata, replaced.content_hash) : currentTraces(metadata);
    const extends_ = !replaced && held !== null && startsWith(wanted, held.traces);
    const toRead = extends_ ? wanted.slice((held as IndexedSession).traces.length) : wanted;
    const traces = await mapLimit(toRead, 4, (hash) => this.traceOf(owner, archive, hash));
    if (traces.some((t) => t === null) && attempt === 0) {
      return this.plan(owner, archive, replaced, 1);
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
      metadata,
      update: {
        session,
        events,
        replace: !extends_,
        ...(extends_ ? { base } : {}),
        read_at: readAt,
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
      const trace = gunzipJson<Trace>(bytes);
      if (!Array.isArray(trace?.events) || !Array.isArray(trace.records)) {
        throw new Error("not a trace");
      }
      return { trace, events: searchableEvents(hash, trace, this.roles) };
    } catch {
      return null;
    }
  }

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
