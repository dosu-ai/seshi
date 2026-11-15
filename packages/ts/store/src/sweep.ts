/** The orphan sweep (F2.5, revised 15 Nov 2026): delete a session's trace objects that no
 * metadata names and that are over an hour old.
 *
 * A trace object is named when its session's `metadata.json` lists it in `traces` (the head and
 * every continuation of a chunked session, in order) or as `head`. Anything else under
 * `trace.<hash>.json.gz` was left by a write that stopped partway: a redaction backfill or a
 * replace stopped after the pointer moved and before it deleted the old objects, a publish that
 * died before its pointer update, a tombstone stopped mid-delete. No reader is served those
 * (the trace routes and `getTrace` serve only a hash `traces` names), but they hold content the
 * session no longer has, so they are deleted, not kept.
 *
 * The age guard: a publish writes its trace object before the pointer names it (layout.md,
 * publish steps 1–3), so a young unnamed object may be a publish in flight. Only objects whose
 * last write (the store's listing: S3's `LastModified`, the file's mtime) is more than
 * `minAgeMs` (1 hour) ago are deleted; a listing that gives no time keeps the object. The
 * metadata is read after the listing and read again just before deleting, so an object a
 * publish named meanwhile (one that reused an object already under its hash, whose age says
 * nothing) is kept unless it is named in the instant between that read and the delete.
 *
 * Only trace objects are ever deleted: span records, reviews, metadata and anything else in a
 * session's folder are not looked at. */

import type { SessionMetadata } from "@seshi/model";
import { isOwner, keys } from "./layout";
import { listOwners } from "./owners";
import { readMetadata } from "./publish";
import type { ListedKey, Store } from "./store";

/** How old an unnamed trace object must be before the sweep deletes it (F2.5). */
export const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/** Sorts after every character a key uses, so `startAfter` set to a folder plus this skips the
 * whole folder (as `listOwners` does). */
const PAST_FOLDER = "\u{10FFFF}";

const TRACE_NAME = /^trace\.([0-9a-f]{64})\.json\.gz$/;

/** A trace object the sweep deleted (or would, in a dry run). */
export interface SweptObject {
  owner: string;
  archive_id: string;
  content_hash: string;
  /** When it was last written, as the listing said. */
  modified: string;
}

export interface SweepOptions {
  /** Only these sessions: what a backfill or a replace touched. */
  sessions?: readonly { owner: string; archive_id: string }[];
  /** Only these owners' sessions; every owner when neither this nor `sessions` is given. */
  owners?: readonly string[];
  /** `SWEEP_MIN_AGE_MS` by default. */
  minAgeMs?: number;
  now?: () => Date;
  /** Find what would be deleted, and delete nothing. */
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

/** The objects `swept` keeps; `deleted` counts them all. */
const SWEPT_SHOWN = 100;

interface ListedTrace {
  hash: string;
  modified?: string;
}

/** The trace objects a session's metadata names: every `traces[]` entry (the head and each
 * continuation of a chunked session) and `head`. None when there is no metadata. */
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

/** The trace objects of each session under `owner`, from one walk of its `sessions/` folder.
 * Folders inside a session (`spans/`, `review/`, anything a later layout adds) are stepped over
 * rather than listed, so a session with thousands of span records costs one extra listing. */
async function* traceObjectsBySession(
  store: Store,
  owner: string,
): AsyncGenerator<{ archive: string; traces: ListedTrace[] }> {
  const prefix = keys.sessions(owner);
  let after: string | undefined;
  let current: { archive: string; traces: ListedTrace[] } | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000, details: true });
    const listed: ListedKey[] = page.objects ?? page.keys.map((key) => ({ key }));
    let stepped = false;
    for (const object of listed) {
      const rest = object.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      after = object.key;
      if (slash < 0) continue;
      const archive = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (current?.archive !== archive) {
        if (current && current.traces.length > 0) yield current;
        current = { archive, traces: [] };
      }
      const inner = name.indexOf("/");
      if (inner >= 0) {
        after = `${prefix}${archive}/${name.slice(0, inner)}/${PAST_FOLDER}`;
        stepped = true;
        break;
      }
      const hash = TRACE_NAME.exec(name)?.[1];
      if (hash)
        current.traces.push({ hash, ...(object.modified ? { modified: object.modified } : {}) });
    }
    if (!stepped && (!page.truncated || listed.length === 0)) break;
  }
  if (current && current.traces.length > 0) yield current;
}

/** One session's trace objects, listed. */
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

/** One session's unnamed, old trace objects deleted. */
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
  // The metadata after the listing: an object written after it was read is not in the listing.
  const named = namedTraces(await readMetadata(store, owner, archive));
  const unnamed = traces.filter((t) => !named.has(t.hash));
  const old = unnamed.filter((t) => {
    const at = t.modified === undefined ? Number.NaN : Date.parse(t.modified);
    return Number.isFinite(at) && at < cutoff;
  });
  report.young += unnamed.length - old.length;
  if (old.length === 0) return;
  // Again just before deleting: a publish that found its object already there (an earlier
  // publish of the same content that stopped) names it without writing it, so its age says
  // nothing about whether a publish is in flight.
  const still = options.dryRun ? named : namedTraces(await readMetadata(store, owner, archive));
  for (const trace of old) {
    if (options.signal?.aborted) return;
    if (still.has(trace.hash)) continue;
    if (!options.dryRun) await store.delete(keys.trace(owner, archive, trace.hash));
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

/** Delete the trace objects no metadata names that are over `minAgeMs` old (see the top of
 * this file): in `sessions`, in `owners`' sessions, or in every session. A session that fails
 * (the bucket, unreadable metadata) is counted in `errors` and the sweep goes on; it never
 * throws for one. */
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
