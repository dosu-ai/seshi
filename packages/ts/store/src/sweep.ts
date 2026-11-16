import type { SessionMetadata } from "@seshi/model";
import { isOwner, keys, PAST_FOLDER } from "./layout";
import { listOwners } from "./owners";
import { readMetadata } from "./publish";
import type { ListedKey, Store } from "./store";

export const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

const TRACE_NAME = /^trace\.([0-9a-f]{64})\.json\.gz$/;

export interface SweptObject {
  owner: string;
  archive_id: string;
  content_hash: string;
  modified: string;
}

export interface SweepOptions {
  sessions?: readonly { owner: string; archive_id: string }[];
  /** Only these owners' sessions; every owner when neither this nor `sessions` is given. */
  owners?: readonly string[];
  /** `SWEEP_MIN_AGE_MS` by default. */
  minAgeMs?: number;
  now?: () => Date;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Told of each object as it is deleted (or would be). */
  onSwept?: (object: SweptObject) => void;
}

export interface SweepReport {
  dry_run: boolean;
  /** Sessions with at least one trace object that were looked at. */
  sessions: number;
  /** Trace objects looked at. */
  traces: number;
  /** Unnamed trace objects deleted (or that would be, in a dry run). */
  deleted: number;
  /** Unnamed trace objects kept because they are under the age (a publish may be in flight). */
  young: number;
  /** Sessions the sweep could not finish (the bucket failed, unreadable metadata): nothing of
   * theirs was deleted after the failure, and the next sweep tries again. */
  errors: number;
  /** The first such failure. */
  error?: string;
  /** What was deleted: the first 100. */
  swept: SweptObject[];
  /** Stopped by the signal before every session was looked at. */
  more: boolean;
}

const SWEPT_SHOWN = 100;

interface ListedTrace {
  hash: string;
  modified?: string;
}

export function namedTraces(metadata: SessionMetadata | null): Set<string> {
  const named = new Set<string>();
  if (!metadata) return named;
  for (const ref of metadata.traces ?? []) named.add(ref.content_hash);
  if (metadata.head) named.add(metadata.head);
  return named;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SessionFolder {
  archive: string;
  metadata: boolean;
  traces: Map<string, string | undefined>;
  folders: Set<string>;
}

export async function* sessionFolders(
  store: Store,
  owner: string,
  prefix: string,
): AsyncGenerator<SessionFolder> {
  const base = keys.sessions(owner);
  let after: string | undefined;
  let current: SessionFolder | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000, details: true });
    const listed: ListedKey[] = page.objects ?? page.keys.map((key) => ({ key }));
    let stepped = false;
    for (const object of listed) {
      after = object.key;
      const rest = object.key.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const archive = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (current?.archive !== archive) {
        if (current) yield current;
        current = { archive, metadata: false, traces: new Map(), folders: new Set() };
      }
      const inner = name.indexOf("/");
      if (inner >= 0) {
        const folder = name.slice(0, inner);
        current.folders.add(folder);
        after = `${base}${archive}/${folder}/${PAST_FOLDER}`;
        stepped = true;
        break;
      }
      if (name === "metadata.json") current.metadata = true;
      const hash = TRACE_NAME.exec(name)?.[1];
      if (hash) current.traces.set(hash, object.modified);
    }
    if (!stepped && (!page.truncated || listed.length === 0)) break;
  }
  if (current) yield current;
}

async function* traceObjectsBySession(
  store: Store,
  owner: string,
): AsyncGenerator<{ archive: string; traces: ListedTrace[] }> {
  for await (const folder of sessionFolders(store, owner, keys.sessions(owner))) {
    if (folder.traces.size === 0) continue;
    const traces = [...folder.traces].map(([hash, modified]) => ({
      hash,
      ...(modified ? { modified } : {}),
    }));
    yield { archive: folder.archive, traces };
  }
}

async function traceObjectsOf(
  store: Store,
  owner: string,
  archive: string,
): Promise<ListedTrace[]> {
  const prefix = `${keys.session(owner, archive)}/trace.`;
  const traces: ListedTrace[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000, details: true });
    const listed: ListedKey[] = page.objects ?? page.keys.map((key) => ({ key }));
    for (const object of listed) {
      after = object.key;
      const hash = TRACE_NAME.exec(object.key.slice(object.key.lastIndexOf("/") + 1))?.[1];
      if (hash) traces.push({ hash, ...(object.modified ? { modified: object.modified } : {}) });
    }
    if (!page.truncated || listed.length === 0) return traces;
  }
}

async function* ownersOf(store: Store): AsyncGenerator<string> {
  let after: string | undefined;
  for (;;) {
    const page = await listOwners(store, { after, limit: 100 });
    for (const owner of page.owners) yield owner;
    if (!page.truncated || page.cursor === undefined) return;
    after = page.cursor;
  }
}

async function sweepSession(
  store: Store,
  owner: string,
  archive: string,
  traces: readonly ListedTrace[],
  options: SweepOptions,
  report: SweepReport,
): Promise<void> {
  report.sessions++;
  report.traces += traces.length;
  const now = (options.now ?? (() => new Date()))().getTime();
  const cutoff = now - (options.minAgeMs ?? SWEEP_MIN_AGE_MS);
  const named = namedTraces(await readMetadata(store, owner, archive));
  const unnamed = traces.filter((t) => !named.has(t.hash));
  const old = unnamed.filter((t) => {
    const at = t.modified === undefined ? Number.NaN : Date.parse(t.modified);
    return Number.isFinite(at) && at < cutoff;
  });
  report.young += unnamed.length - old.length;
  if (old.length === 0) return;
  const still = options.dryRun ? named : namedTraces(await readMetadata(store, owner, archive));
  for (const trace of old) {
    if (options.signal?.aborted) return;
    if (still.has(trace.hash)) continue;
    if (!options.dryRun) {
      const key = keys.trace(owner, archive, trace.hash);
      const now = await store.stat(key);
      if (now === null) continue;
      const at = now.modified === undefined ? Number.NaN : Date.parse(now.modified);
      if (!Number.isFinite(at) || at >= cutoff) {
        report.young++;
        continue;
      }
      await store.delete(key, now.etag ? { ifMatch: now.etag } : {});
    }
    const swept: SweptObject = {
      owner,
      archive_id: archive,
      content_hash: trace.hash,
      modified: trace.modified as string,
    };
    report.deleted++;
    if (report.swept.length < SWEPT_SHOWN) report.swept.push(swept);
    options.onSwept?.(swept);
  }
}

async function guarded(report: SweepReport, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    report.errors++;
    report.error ??= message(err);
  }
}

/** Delete the trace objects no metadata names that are over `minAgeMs` old: in `sessions`, in
 * `owners`' sessions, or in every session. A session that fails (the bucket, unreadable metadata)
 * is counted in `errors` and the sweep goes on; it never throws for one. */
export async function sweepTraces(store: Store, options: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = {
    dry_run: options.dryRun === true,
    sessions: 0,
    traces: 0,
    deleted: 0,
    young: 0,
    errors: 0,
    swept: [],
    more: false,
  };
  if (options.sessions) {
    for (const { owner, archive_id } of options.sessions) {
      if (options.signal?.aborted) {
        report.more = true;
        return report;
      }
      await guarded(report, async () => {
        const traces = await traceObjectsOf(store, owner, archive_id);
        if (traces.length > 0) {
          await sweepSession(store, owner, archive_id, traces, options, report);
        }
      });
    }
    return report;
  }
  for (const owner of options.owners ?? []) {
    if (!isOwner(owner)) throw new Error(`'${owner}' is not an owner id`);
  }
  const owners = options.owners ? options.owners.values() : ownersOf(store);
  for await (const owner of owners) {
    await guarded(report, async () => {
      for await (const { archive, traces } of traceObjectsBySession(store, owner)) {
        if (options.signal?.aborted) break;
        await guarded(report, () => sweepSession(store, owner, archive, traces, options, report));
      }
    });
    if (options.signal?.aborted) {
      report.more = true;
      return report;
    }
  }
  return report;
}
