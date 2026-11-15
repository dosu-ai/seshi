/** The write stage: the decided records in, objects in the store out. The pipeline
 * (`pipeline.ts`) runs every other stage in memory first (X4.3) and calls `ingest` last, so this
 * is the only place a session's objects are written: cap → parse (validate, strip NUL, events,
 * hash) → publish the canonical trace (`seshi/trace/1`, X6.2) → change entry → update
 * `metadata.json` (the entry first: decision 7 of 18). Nothing raw is stored (X6.3): a session is its pointer, its traces and its change
 * entries. `tombstone` removes them.
 *
 * `metadata.json` is updated with If-Match and retried on 412 (X6.5), so two writers on one
 * session (an API instance and the worker, two uploads racing) each see the other's update; a
 * `guard` lets the caller refuse a version that is not the one it planned against. Every write
 * records who made it (X5.5): the session keeps its original writer and how its owner was
 * established, and each change entry its own writer. */

import {
  type AppliedEnvelope,
  type Claims,
  IngestRejected,
  type IngestResult,
  type LlmCall,
  localWriter,
  METADATA_SCHEMA,
  type NormalizedRecord,
  type NormalizedState,
  type OwnerBasis,
  type Provenance,
  parseTrace,
  type RedactionSummary,
  type SessionMetadata,
  type SessionTraceRef,
  type StoredTrace,
  type TombstoneReason,
  type Trace,
  type TraceMetadata,
  TrajectoryError,
  type Visibility,
  type Writer,
} from "@seshi/model";
import {
  archiveId,
  type ChangeUpdate,
  decodeJson,
  deleteSpans,
  ensureLayout,
  getBytes,
  gunzipJson,
  gzipJson,
  keys,
  publishObject,
  readMetadata,
  type Store,
  updateMetadata,
  updateMetadataWithChange,
} from "@seshi/store";
import { DEFAULT_LIMITS, type Limits } from "./limits";

export { IngestRejected, type IngestResult, type StoredTrace };

/** How many applied envelopes a session remembers (X4.7). A resend older than that is
 * processed again; for a log that means 409 `offset_mismatch` with where the log ends, which
 * an uploader already handles. */
export const APPLIED_KEPT = 16;

/** Withheld call ids, by id (`SessionMetadata.withheld_calls`). */
export type WithheldCallIds = NonNullable<SessionMetadata["withheld_calls"]>;

/** `applied` with `entry` added (a resend's entry replaces its earlier one), the oldest past
 * `APPLIED_KEPT` dropped. */
export function withApplied(
  applied: readonly AppliedEnvelope[] | undefined,
  entry: AppliedEnvelope,
): AppliedEnvelope[] {
  const kept = (applied ?? []).filter((a) => a.idempotency_key !== entry.idempotency_key);
  return [...kept, entry].slice(-APPLIED_KEPT);
}

/** Who is writing and on what basis (X5.5, X5.10), and what the data claimed and came from.
 * Everything is optional: without it a write is the owner's own, through the upload route
 * (`localWriter`), `verified`, visible to the `org`. */
export interface WriteContext {
  writer?: Writer;
  owner_basis?: OwnerBasis;
  /** The visibility a new session gets; an existing session keeps its own. */
  visibility?: Visibility;
  /** Identity the data asserts, merged into the session's (X5.5). */
  claims?: Claims;
  /** Where this write came from. */
  provenance?: Provenance;
}

/** A new session's pointer, before anything is in it. */
function newSession(
  owner: string,
  archive: string,
  sessionId: string,
  agent: string,
  at: string,
  context: WriteContext,
): SessionMetadata {
  return {
    schema: METADATA_SCHEMA,
    owner,
    archive_id: archive,
    session_id: sessionId,
    agent,
    status: "stored",
    traces: [],
    writer: context.writer ?? localWriter(owner),
    owner_basis: context.owner_basis ?? "verified",
    visibility: context.visibility ?? "org",
    created_at: at,
    updated_at: at,
  };
}

/** The session's claims and provenance with this write's added. */
function withContext(metadata: SessionMetadata, context: WriteContext): SessionMetadata {
  const next = { ...metadata };
  if (context.claims && Object.keys(context.claims).length > 0) {
    next.claims = { ...metadata.claims, ...context.claims };
  }
  if (context.provenance) next.provenance = context.provenance;
  return next;
}

/** Whether two pointers differ in anything but `updated_at`. */
function changed(a: SessionMetadata | null, b: SessionMetadata): boolean {
  return (
    a === null ||
    JSON.stringify({ ...a, updated_at: "" }) !== JSON.stringify({ ...b, updated_at: "" })
  );
}

/** Redaction counts summed over two writes; the later rule set is the one that last ran. Which
 * rule set each trace was written under is on its `SessionTraceRef` (`rule_set`), so a write
 * under new rules does not make the traces stored under the old ones look current. */
function addRedaction(
  before: RedactionSummary | undefined,
  write: RedactionSummary | undefined,
): RedactionSummary | undefined {
  if (!write) return before;
  const counts = { ...before?.counts };
  for (const [rule, n] of Object.entries(write.counts)) counts[rule] = (counts[rule] ?? 0) + n;
  return { rule_set: write.rule_set, counts };
}

export interface IngestMetadata {
  session_id: string;
  /** The trajectory source (`claude-code`, `codex`, …). */
  agent: string;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  continuation?: { from_record: number; prefix_sha256: string };
  normalizer?: { name: string; version: string };
}

export interface IngestInput extends WriteContext {
  store: Store;
  owner: string;
  /** Normalized, redacted and reviewed; `parseTrace` validates the shape. */
  records: readonly NormalizedRecord[];
  metadata: IngestMetadata;
  /** Identifies the writer in the layout marker (`seshi/0.9.0`). */
  client?: string;
  now?: () => Date;
  /** Where the session's log stands once these records are in, written with the pointer. */
  normalized?: NormalizedState;
  /** The calls the sensitive-call rules withheld in the session's log so far (replaces the
   * stored set when given; an empty set removes it). */
  withheld_calls?: WithheldCallIds;
  /** The envelope this write applies (X4.7): remembered with what it answered, so a resend
   * gets the same answer. Needs `normalized`. */
  applied?: { idempotency_key: string; at?: string };
  /** The trace replaces the session's traces instead of extending them (X4.6): the pointer
   * lists only it, the earlier objects are removed, the session's applied envelopes and
   * redaction counts start over from this write, and the change entry says `replace`. The
   * caller has checked that this writer may. */
  replace?: boolean;
  /** Runs on the stored pointer inside the conditional update, before anything changes; throws
   * to abandon the write when the session is not as the caller planned (another write landed
   * first). The trace object written for it is removed again. */
  guard?: (existing: SessionMetadata | null) => void;
  /** The layout marker was already checked by the caller (the pipeline checks it once). */
  layout_checked?: boolean;
  /** Size caps; `DEFAULT_LIMITS` when omitted. */
  limits?: Readonly<Limits>;
  /** The LLM calls the records' `llm_call` fields name (model, timing, token usage). */
  llm_calls?: readonly LlmCall[];
  /** What redaction did on this write, added to the session's counts. */
  redaction?: RedactionSummary;
  /** The agent that ran the session (X4.5); the trace's `source` by default. */
  origin_agent?: string;
  /** The session's id in that agent (X4.5); `session_id` by default. */
  native_session_id?: string;
  /** The uploading machine's retraction hash (F9.7). The first one a session gets is kept:
   * only the machine that first uploaded it can retract it, whoever writes later. */
  retract_hash?: string;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const { store, owner, metadata } = input;
  const now = input.now ?? (() => new Date());

  const limits = input.limits ?? DEFAULT_LIMITS;
  if (input.records.length > limits.max_records) {
    throw new IngestRejected(
      "too_large",
      `${input.records.length} records > ${limits.max_records}`,
    );
  }
  if (byteLength(input.records) > limits.max_records_bytes) {
    throw new IngestRejected("too_large", `records exceed ${limits.max_records_bytes} bytes`);
  }

  const traceMetadata: TraceMetadata = {};
  if (metadata.parent_session_id) traceMetadata.parent_session_id = metadata.parent_session_id;
  if (metadata.continuation) traceMetadata.continuation = metadata.continuation;
  if (metadata.normalizer) traceMetadata.normalizer = metadata.normalizer;

  const writer = input.writer ?? localWriter(owner);
  const provenance: Provenance = input.provenance ?? {
    source: "upload",
    source_id: writer.source_id,
    format: metadata.agent,
  };
  let trace: Trace;
  try {
    trace = parseTrace(input.records, {
      agent: metadata.agent,
      session_id: metadata.session_id,
      project: metadata.project,
      branch: metadata.branch,
      metadata: traceMetadata,
      llm_calls: input.llm_calls,
      provenance,
    });
  } catch (err) {
    if (err instanceof TrajectoryError) throw new IngestRejected("invalid", err.message);
    throw err;
  }

  const archive = archiveId(owner, metadata.agent, metadata.session_id);
  const at = now().toISOString();
  if (!input.layout_checked) await ensureLayout(store, { createdBy: input.client ?? "seshi" });

  const before = await readMetadata(store, owner, archive);
  if (before?.status === "redacted") {
    throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
  }
  input.guard?.(before);

  // A replace rewrites an object already under its hash: the content hash leaves things out (an
  // assistant record's text beside its tool calls, the meta record, LLM calls), so a session
  // redacted again under new rules, or reviewed again, can keep its hash while those differ, and
  // keeping the first object would leave what the new write took out (as backfill does).
  const outcome = await publishObject(
    store,
    keys.trace(owner, archive, trace.content_hash),
    gzipJson(trace),
    "application/gzip",
    input.replace ? "replace" : "immutable",
  );

  const context: WriteContext = { ...input, writer, provenance };
  // Whether the pointer already listed this trace, as of the version the update applied to, and
  // what a replacement took off it.
  let already = false;
  let replaced: string[] = [];
  let basis: OwnerBasis = input.owner_basis ?? "verified";
  const nextPointer = (existing: SessionMetadata | null): SessionMetadata | null => {
    if (existing?.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
    }
    input.guard?.(existing);
    const listed = existing?.traces.find((t) => t.content_hash === trace.content_hash);
    already = listed !== undefined;
    const ref: SessionTraceRef = {
      content_hash: trace.content_hash,
      created_at: listed?.created_at ?? at,
      records: trace.records.length,
    };
    if (metadata.continuation) ref.continuation = metadata.continuation;
    if (input.redaction) ref.rule_set = input.redaction.rule_set;

    const base =
      existing ?? newSession(owner, archive, metadata.session_id, metadata.agent, at, context);
    basis = base.owner_basis;
    replaced = input.replace
      ? base.traces.map((t) => t.content_hash).filter((h) => h !== trace.content_hash)
      : [];
    // Outside a replace, a trace already listed keeps its entry, and so the rule set its stored
    // object was written under: that object is not rewritten, so the old rules' output stays
    // under the hash. A replace rewrote it (above), so its entry is this write's.
    const traces = input.replace ? [ref] : listed ? base.traces : [...base.traces, ref];
    const next: SessionMetadata = withContext(
      {
        ...base,
        source: trace.source,
        status: "stored",
        head: trace.content_hash,
        traces,
        origin_agent: input.origin_agent ?? base.origin_agent ?? trace.source,
        native_session_id: input.native_session_id ?? base.native_session_id ?? metadata.session_id,
        updated_at: at,
      },
      context,
    );
    if (metadata.project ?? base.project) next.project = metadata.project ?? base.project;
    if (metadata.branch ?? base.branch) next.branch = metadata.branch ?? base.branch;
    // Lineage is backfilled onto an existing session: a duplicate upload that knows the parent
    // adds that knowledge rather than being ignored.
    const parent = metadata.parent_session_id ?? base.parent_session_id;
    if (parent) next.parent_session_id = parent;
    const normalized = input.normalized ?? base.normalized;
    if (normalized) next.normalized = normalized;
    if (input.withheld_calls !== undefined) {
      if (Object.keys(input.withheld_calls).length > 0) next.withheld_calls = input.withheld_calls;
      else delete next.withheld_calls;
    }
    // A replace starts the session over: what earlier envelopes answered named traces that are
    // gone, and their redaction counts described content that is no longer stored.
    if (input.replace) delete next.applied;
    if (input.applied && normalized) {
      next.applied = withApplied(input.replace ? [] : base.applied, {
        idempotency_key: input.applied.idempotency_key,
        at: input.applied.at ?? at,
        status: already && outcome === "exists" ? "duplicate" : "stored",
        content_hash: trace.content_hash,
        records: trace.records.length,
        events: trace.events.length,
        records_total: normalized.records,
        prefix_sha256: normalized.prefix_sha256,
        bytes_total: normalized.bytes,
      });
    }
    if (metadata.normalizer) next.normalizer = metadata.normalizer;
    if (input.retract_hash && !base.retract_hash) next.retract_hash = input.retract_hash;
    const redaction = addRedaction(input.replace ? undefined : base.redaction, input.redaction);
    if (redaction) next.redaction = redaction;
    else delete next.redaction;
    return changed(existing, next) ? next : null;
  };
  // A duplicate is one the pointer already lists and whose object was there: nothing new to say.
  // An object that exists without a pointer entry (an interrupted earlier publish) is completed
  // here, pointer and change entry included.
  let duplicate = false;
  // The change entry is written before the pointer moves (decision 7 of 18): a failure between
  // the two leaves an entry for a publish that did not happen, never a publish with no entry.
  const step = (existing: SessionMetadata | null): ChangeUpdate => {
    const next = nextPointer(existing);
    duplicate = already && outcome === "exists" && replaced.length === 0;
    return {
      next,
      change: duplicate
        ? null
        : {
            kind: "published",
            at,
            owner,
            archive_id: archive,
            session_id: metadata.session_id,
            content_hash: trace.content_hash,
            writer,
            owner_basis: basis,
            ...(metadata.continuation ? { continuation: metadata.continuation } : {}),
            ...(input.replace ? { replace: true as const } : {}),
          },
    };
  };
  try {
    await updateMetadataWithChange(store, owner, archive, step, { expected: before });
  } catch (err) {
    // Tombstoned between the check above and now, or the guard refused a session another write
    // changed: the object this write just created would be left behind (a tombstone already
    // removed the objects it knew of). Remove it too, unless the pointer already lists it (a
    // replace that rewrote a listed object leaves it rewritten: the write planned again puts the
    // same there). A change entry already written stays: readers find the session unchanged.
    if (outcome === "written") {
      const now = await readMetadata(store, owner, archive);
      if (!now?.traces.some((t) => t.content_hash === trace.content_hash)) {
        await store.delete(keys.trace(owner, archive, trace.content_hash));
      }
    }
    throw err;
  }
  // The pointer no longer lists them, so no reader looks for them any more.
  for (const hash of replaced) await store.delete(keys.trace(owner, archive, hash));

  return {
    status: duplicate ? "duplicate" : "stored",
    archive_id: archive,
    content_hash: trace.content_hash,
    session_id: metadata.session_id,
    records: trace.records.length,
    events: trace.events.length,
  };
}

/** Record where a session's log stands when no trace is written for an envelope: a chunk with
 * no records in it, a whole log with nothing past what is stored, an envelope model review
 * dropped. The log moves on and the envelope is remembered (X4.7) without a new trace. */
export async function recordProgress(input: {
  store: Store;
  owner: string;
  archive_id: string;
  normalized: NormalizedState;
  withheld_calls?: WithheldCallIds;
  applied?: { idempotency_key: string; status: "unchanged" | "dropped" };
  guard?: (existing: SessionMetadata | null) => void;
  now?: () => Date;
}): Promise<void> {
  const { store, owner, normalized } = input;
  const at = (input.now ?? (() => new Date()))().toISOString();
  await updateMetadata(store, owner, input.archive_id, (existing) => {
    if (existing?.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
    }
    input.guard?.(existing);
    if (!existing) return null;
    const next: SessionMetadata = { ...existing, normalized, updated_at: at };
    if (input.withheld_calls !== undefined) {
      if (Object.keys(input.withheld_calls).length > 0) next.withheld_calls = input.withheld_calls;
      else delete next.withheld_calls;
    }
    if (input.applied) {
      next.applied = withApplied(existing.applied, {
        idempotency_key: input.applied.idempotency_key,
        at,
        status: input.applied.status,
        records_total: normalized.records,
        prefix_sha256: normalized.prefix_sha256,
        bytes_total: normalized.bytes,
      });
    }
    return next;
  });
}

export interface TombstoneInput {
  store: Store;
  owner: string;
  agent: string;
  session_id: string;
  now?: () => Date;
  /** Why: `deleted` (the default) by the owner or an admin, `retracted` by the uploading
   * machine (F9.7), `redacted` by an operator. */
  reason?: TombstoneReason;
  /** Who removed it; the owner through the upload route by default. */
  writer?: Writer;
}

/** Remove a session's trace objects and mark it redacted. Irreversible; a later ingest
 * of the same session is refused, so a tombstoned session stays gone. The change entry records
 * the reason and the writer, never the content. A session never published (no metadata) has
 * only its span records and pending marker removed; null when there was nothing to remove. */
export async function tombstone(input: TombstoneInput): Promise<{ removed: number } | null> {
  const { store, owner } = input;
  const archive = archiveId(owner, input.agent, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
  let removedObjects: { traces: string[] } | null = null;
  // Mark it redacted first, so no write that races the removal can give it a new head; the
  // change entry goes before that (decision 7 of 18), naming the head as it was.
  await updateMetadataWithChange(store, owner, archive, (existing) => {
    if (!existing) {
      removedObjects = null;
      return { next: null, change: null };
    }
    removedObjects = { traces: existing.traces.map((t) => t.content_hash) };
    // What the next chunk would continue from goes too: nothing of the session is left.
    const { head: _head, normalized: _n, withheld_calls: _w, applied: _a, ...rest } = existing;
    return {
      next: { ...rest, status: "redacted", traces: [], updated_at: at },
      change: {
        kind: "tombstone",
        at,
        owner,
        archive_id: archive,
        session_id: input.session_id,
        content_hash: existing.head ?? null,
        writer: input.writer ?? localWriter(owner),
        owner_basis: existing.owner_basis,
        reason: input.reason ?? "deleted",
      },
    };
  });
  const gone = removedObjects as { traces: string[] } | null;
  if (gone === null) {
    // Never published (pending, or refused by the filter or model review): no pointer, but its
    // span records (F4.4) may hold content, and only this removes them. Nothing was indexed, so
    // there is no change entry; null when there was nothing at all.
    const spans = await deleteSpans(store, owner, archive);
    await store.delete(keys.pending(archive));
    return spans > 0 ? { removed: spans } : null;
  }
  let removed = 0;
  for (const hash of gone.traces) {
    await store.delete(keys.trace(owner, archive, hash));
    removed++;
  }
  // Span records (F4.4) hold the session's content too, and a pending marker would only have
  // the assembler find them again.
  await deleteSpans(store, owner, archive);
  await store.delete(keys.pending(archive));
  return { removed };
}

export interface SetVisibilityInput {
  store: Store;
  owner: string;
  agent: string;
  session_id: string;
  visibility: Visibility;
  now?: () => Date;
  /** Who changed it; the owner through the upload route by default. */
  writer?: Writer;
}

/** Change who may read a session (X5.10) and append a `visibility_changed` change entry, so the
 * search index and downstream readers update (F10.4). The session as it now is; null for one
 * not stored. A session that is already so is returned as it is, with no entry. A redacted
 * session refuses (`IngestRejected` `redacted`): nothing of it is left to read. */
export async function setVisibility(input: SetVisibilityInput): Promise<SessionMetadata | null> {
  const { store, owner } = input;
  const archive = archiveId(owner, input.agent, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
  // The change entry goes before the pointer (decision 7 of 18).
  const result = await updateMetadataWithChange(store, owner, archive, (existing) => {
    if (!existing) return { next: null, change: null };
    if (existing.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted; nothing is left to read");
    }
    if (existing.visibility === input.visibility) return { next: null, change: null };
    return {
      next: { ...existing, visibility: input.visibility, updated_at: at },
      change: {
        kind: "visibility_changed",
        at,
        owner,
        archive_id: archive,
        session_id: input.session_id,
        content_hash: existing.head ?? null,
        writer: input.writer ?? localWriter(owner),
        owner_basis: existing.owner_basis,
        visibility: input.visibility,
      },
    };
  });
  const session = result.value;
  if (session === null) return null;
  return session;
}

// --- read side ----------------------------------------------------------------

/** One stored trace, the canonical `seshi/trace/1` object; null when there is none. Render it
 * with `renderTrace` from `@seshi/formats` for another format. */
export async function getTrace(
  store: Store,
  owner: string,
  archive: string,
  contentHash: string,
): Promise<Trace | null> {
  const bytes = await getBytes(store, keys.trace(owner, archive, contentHash));
  return bytes === null ? null : gunzipJson<Trace>(bytes);
}

export async function getSession(
  store: Store,
  owner: string,
  agent: string,
  sessionId: string,
): Promise<SessionMetadata | null> {
  return readMetadata(store, owner, archiveId(owner, agent, sessionId));
}

/** Every session's metadata under an owner, by walking `sessions/`. A full listing, paged by
 * key; a reader that wants an index builds its own from `changes/`. A session's span records
 * (`spans/`, F4.4: thousands for a long OTLP session) are stepped over rather than listed, so
 * they neither fill pages nor count toward `limit`. */
export async function listSessions(
  store: Store,
  owner: string,
  options: { startAfter?: string; limit?: number } = {},
): Promise<{ sessions: SessionMetadata[]; cursor: string | undefined; truncated: boolean }> {
  const prefix = keys.sessions(owner);
  const page = await listSessionKeys(store, prefix, options);
  const metadataKeys = page.keys.filter((k) => k.endsWith("/metadata.json"));
  const sessions = (
    await Promise.all(
      metadataKeys.map(async (k) => {
        const bytes = await getBytes(store, k);
        return bytes === null ? null : decodeJson<SessionMetadata>(bytes);
      }),
    )
  ).filter((m): m is SessionMetadata => m !== null);
  return { sessions, cursor: page.cursor, truncated: page.truncated };
}

/** Up to `limit` keys under `prefix` after `startAfter`, stepping over each session's `spans/`:
 * on reaching one, listing starts again just past it (`…/spans0`; `0` sorts right after `/`).
 * The cursor is the last key looked at, or such a step, so the next page never walks the
 * spans again. */
async function listSessionKeys(
  store: Store,
  prefix: string,
  options: { startAfter?: string; limit?: number },
): Promise<{ keys: string[]; cursor: string | undefined; truncated: boolean }> {
  const out: string[] = [];
  let after = options.startAfter;
  let cursor: string | undefined;
  for (;;) {
    const left = options.limit === undefined ? undefined : options.limit - out.length;
    const page = await store.list(prefix, { startAfter: after, limit: left });
    let past: string | undefined;
    for (const key of page.keys) {
      const at = key.indexOf("/spans/", prefix.length);
      if (at >= 0) {
        past = `${key.slice(0, at)}/spans0`;
        break;
      }
      out.push(key);
      cursor = key;
    }
    if (past === undefined) return { keys: out, cursor, truncated: page.truncated };
    cursor = past;
    if (left !== undefined && out.length >= (options.limit ?? 0)) {
      return { keys: out, cursor, truncated: true };
    }
    after = past;
  }
}
