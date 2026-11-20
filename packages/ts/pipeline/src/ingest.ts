import {
  type AppliedEnvelope,
  type Claims,
  type DroppedPrefix,
  IngestRejected,
  type IngestResult,
  type LlmCall,
  localWriter,
  METADATA_SCHEMA,
  type NormalizedRecord,
  type NormalizedState,
  type Normalizer,
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
  accessDeniedIn,
  archiveId,
  type ChangeUpdate,
  decodeMetadata,
  decodeTrace,
  deleteSpans,
  ensureLayout,
  getBytes,
  gzipJsonDeterministic,
  keys,
  publishObject,
  readMetadata,
  type Store,
  sweepTraces,
  updateMetadata,
  updateMetadataWithChange,
} from "@seshi/store";
import { DEFAULT_LIMITS, type Limits } from "./limits";

export { IngestRejected, type IngestResult, type StoredTrace };

/** How many applied envelopes a session remembers (X4.7). A resend older than that is
 * processed again; for a log that means 409 `offset_mismatch` with where the log ends, which
 * an uploader already handles. */
export const APPLIED_KEPT = 16;

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
  provenance?: Provenance;
}

function newSession(
  owner: string,
  archive: string,
  sessionId: string,
  format: string,
  at: string,
  context: WriteContext,
): SessionMetadata {
  return {
    schema: METADATA_SCHEMA,
    owner,
    archive_id: archive,
    session_id: sessionId,
    format,
    status: "stored",
    traces: [],
    writer: context.writer ?? localWriter(owner),
    owner_basis: context.owner_basis ?? "verified",
    visibility: context.visibility ?? "org",
    created_at: at,
    updated_at: at,
  };
}

function withContext(metadata: SessionMetadata, context: WriteContext): SessionMetadata {
  const next = { ...metadata };
  if (context.claims && Object.keys(context.claims).length > 0) {
    next.claims = { ...metadata.claims, ...context.claims };
  }
  if (context.provenance) next.provenance = context.provenance;
  return next;
}

function changed(a: SessionMetadata | null, b: SessionMetadata): boolean {
  return (
    a === null ||
    JSON.stringify({ ...a, updated_at: "" }) !== JSON.stringify({ ...b, updated_at: "" })
  );
}

/** The models a session used, in the order first seen: `before` (the session's so far), then
 * this trace's LLM calls, or its metadata's `model` when no call names one. */
export function modelsOf(before: readonly string[] | undefined, trace: Trace): string[] {
  const seen = new Set(before ?? []);
  const called = (trace.llm_calls ?? []).map((call) => call.model).filter((m) => m !== undefined);
  const named = trace.metadata.model;
  for (const model of called.length > 0 ? called : named ? [named] : []) seen.add(model);
  return [...seen];
}

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
  /** The format the session is filed under; the archive id derives from it. */
  format: string;
  project?: string;
  branch?: string;
  /** The repository's normalized remote: the session keeps the first one it is given. */
  repo?: string;
  /** Recorded on the trace's metadata. */
  commit?: string;
  path_in_repo?: string;
  client?: string;
  /** The uploader's hints, for a log that names neither: used only where the meta record has
   * no `agent_version` or `model`. */
  hints?: { agent_version?: string; model?: string };
  parent_session_id?: string;
  continuation?: { from_record: number; prefix_sha256: string };
  /** What normalized these records; recorded on the trace, and on the session unless
   * `session_normalizer` says otherwise. */
  normalizer?: Normalizer;
}

export interface IngestInput extends WriteContext {
  store: Store;
  owner: string;
  /** Normalized, redacted and reviewed; `parseTrace` validates the shape. */
  records: readonly NormalizedRecord[];
  metadata: IngestMetadata;
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
   * session is then swept (F2.5): trace objects no metadata names, over an hour old, go. The
   * caller has checked that this writer may. */
  replace?: boolean;
  /** Runs on the stored pointer inside the conditional update, before anything changes; throws
   * to abandon the write when the session is not as the caller planned (another write landed
   * first). The trace object written for it is removed again. */
  guard?: (existing: SessionMetadata | null) => void;
  layout_checked?: boolean;
  /** Size caps; `DEFAULT_LIMITS` when omitted. */
  limits?: Readonly<Limits>;
  llm_calls?: readonly LlmCall[];
  /** What redaction did on this write, added to the session's counts. */
  redaction?: RedactionSummary;
  /** The agent that ran the session (X4.5); the trace's `source` by default. */
  origin_agent?: string;
  /** The session's id in that agent (X4.5); `session_id` by default. */
  native_session_id?: string;
  /** What the session's metadata records as its normalizer, when it is not this trace's
   * (`metadata.normalizer`): a continuation keeps the older format version that built the
   * session's prefix, so the session stays stale until it is rebuilt (X4.9). */
  session_normalizer?: Normalizer;
  /** The uploading machine's retraction hash (F9.7). The first one a session gets is kept:
   * only the machine that first uploaded it can retract it, whoever writes later. */
  retract_hash?: string;
  /** The start of the log model review dropped before anything was stored (F3.4), as this write
   * leaves it out: a whole write past it sets it anew. Otherwise the stored one is kept, replace
   * included, so the dropped part is never stored or reviewed again. */
  dropped_prefix?: DroppedPrefix;
}

function retractHashIfCreating(
  existing: SessionMetadata | null,
  retractHash: string | undefined,
): string | undefined {
  return existing === null ? retractHash : undefined;
}

async function removeTraceUnlessListed(
  store: Store,
  owner: string,
  archive: string,
  contentHash: string,
): Promise<void> {
  const now = await readMetadata(store, owner, archive);
  if (!now?.traces.some((t) => t.content_hash === contentHash)) {
    await store.delete(keys.trace(owner, archive, contentHash));
  }
}

interface PointerPlan {
  next: SessionMetadata | null;
  already: boolean;
  replaced: string[];
  basis: OwnerBasis;
}

interface IngestDecision extends ChangeUpdate {
  duplicate: boolean;
  replaced: string[];
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
  if (metadata.commit) traceMetadata.commit = metadata.commit;
  if (metadata.path_in_repo) traceMetadata.path_in_repo = metadata.path_in_repo;
  if (metadata.client) traceMetadata.client = metadata.client;

  const writer = input.writer ?? localWriter(owner);
  const provenance: Provenance = input.provenance ?? {
    source: "upload",
    source_id: writer.source_id,
    format: metadata.format,
  };
  let trace: Trace;
  try {
    trace = parseTrace(input.records, {
      format: metadata.format,
      session_id: metadata.session_id,
      project: metadata.project,
      branch: metadata.branch,
      metadata: traceMetadata,
      ...(metadata.hints ? { hints: metadata.hints } : {}),
      llm_calls: input.llm_calls,
      provenance,
    });
  } catch (err) {
    if (err instanceof TrajectoryError) throw new IngestRejected("invalid", err.message);
    throw err;
  }

  const archive = archiveId(owner, metadata.format, metadata.session_id);
  const at = now().toISOString();
  if (!input.layout_checked) await ensureLayout(store, { createdBy: input.client ?? "seshi" });

  const before = await readMetadata(store, owner, archive);
  if (before?.status === "redacted") {
    throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
  }
  input.guard?.(before);

  const outcome = await publishObject(
    store,
    keys.trace(owner, archive, trace.content_hash),
    gzipJsonDeterministic(trace),
    "application/gzip",
    input.replace ? "replace" : "immutable",
  );

  const context: WriteContext = { ...input, writer, provenance };
  const nextPointer = (existing: SessionMetadata | null): PointerPlan => {
    if (existing?.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
    }
    input.guard?.(existing);
    const listed = existing?.traces.find((t) => t.content_hash === trace.content_hash);
    const already = listed !== undefined;
    const ref: SessionTraceRef = {
      content_hash: trace.content_hash,
      created_at: listed?.created_at ?? at,
      records: trace.records.length,
    };
    if (metadata.continuation) ref.continuation = metadata.continuation;
    if (input.redaction) ref.rule_set = input.redaction.rule_set;

    const base =
      existing ?? newSession(owner, archive, metadata.session_id, metadata.format, at, context);
    const replaced = input.replace
      ? base.traces.map((t) => t.content_hash).filter((h) => h !== trace.content_hash)
      : [];
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
    const repo = base.repo ?? metadata.repo;
    if (repo) next.repo = repo;
    // The latest trace's (for a log that names it, the version the session started on: a
    // continuation keeps the first upload's meta record). A replace by a trace that names none
    // leaves none.
    if (trace.metadata.agent_version) next.agent_version = trace.metadata.agent_version;
    else if (input.replace) delete next.agent_version;
    const models = modelsOf(input.replace ? undefined : base.models, trace);
    if (models.length > 0) next.models = models;
    else delete next.models;
    const parent = metadata.parent_session_id ?? base.parent_session_id;
    if (parent) next.parent_session_id = parent;
    const active = latest(lastActivity(trace.records), input.replace ? undefined : base.active_at);
    if (active) next.active_at = active;
    else delete next.active_at;
    const normalized = input.normalized ?? base.normalized;
    if (normalized) next.normalized = normalized;
    if (input.dropped_prefix) next.dropped_prefix = input.dropped_prefix;
    if (input.withheld_calls !== undefined) {
      if (Object.keys(input.withheld_calls).length > 0) next.withheld_calls = input.withheld_calls;
      else delete next.withheld_calls;
    }
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
    const normalizer = input.session_normalizer ?? metadata.normalizer;
    if (normalizer) next.normalizer = normalizer;
    const retractHash = retractHashIfCreating(existing, input.retract_hash);
    if (retractHash) next.retract_hash = retractHash;
    const redaction = addRedaction(input.replace ? undefined : base.redaction, input.redaction);
    if (redaction) next.redaction = redaction;
    else delete next.redaction;
    return {
      next: changed(existing, next) ? next : null,
      already,
      replaced,
      basis: base.owner_basis,
    };
  };
  const step = (existing: SessionMetadata | null): IngestDecision => {
    const { next, already, replaced, basis } = nextPointer(existing);
    const duplicate = already && outcome === "exists" && replaced.length === 0;
    return {
      next,
      duplicate,
      replaced,
      change: duplicate
        ? null
        : {
            kind: "published",
            at,
            owner,
            archive_id: archive,
            session_id: metadata.session_id,
            format: metadata.format,
            content_hash: trace.content_hash,
            writer,
            owner_basis: basis,
            ...(metadata.continuation ? { continuation: metadata.continuation } : {}),
            ...(input.replace ? { replace: true as const } : {}),
          },
    };
  };
  let decided: IngestDecision;
  try {
    ({ decided } = await updateMetadataWithChange(store, owner, archive, step, {
      expected: before,
    }));
  } catch (err) {
    if (outcome === "written") {
      await removeTraceUnlessListed(store, owner, archive, trace.content_hash);
    }
    throw err;
  }
  const { duplicate, replaced } = decided;
  for (const hash of replaced) await store.delete(keys.trace(owner, archive, hash));

  if (input.replace) {
    await sweepTraces(store, { sessions: [{ owner, archive_id: archive }], now });
  }

  return {
    status: duplicate ? "duplicate" : "stored",
    archive_id: archive,
    content_hash: trace.content_hash,
    session_id: metadata.session_id,
    records: trace.records.length,
    events: trace.events.length,
  };
}

export interface StubInput {
  session_id: string;
  format: string;
  writer?: Writer;
  owner_basis?: OwnerBasis;
  visibility?: Visibility;
  retract_hash?: string;
}

function newStub(owner: string, archive: string, stub: StubInput, at: string): SessionMetadata {
  const metadata = newSession(owner, archive, stub.session_id, stub.format, at, stub);
  if (stub.retract_hash) metadata.retract_hash = stub.retract_hash;
  return metadata;
}

function droppedPrefixOf(state: NormalizedState): DroppedPrefix {
  return { bytes: state.bytes, records: state.records, prefix_sha256: state.prefix_sha256 };
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
  createStubIfMissing?: StubInput;
}): Promise<void> {
  const { store, owner, normalized, createStubIfMissing } = input;
  const at = (input.now ?? (() => new Date()))().toISOString();
  await updateMetadata(store, owner, input.archive_id, (existing) => {
    if (existing?.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
    }
    input.guard?.(existing);
    const base =
      existing ??
      (createStubIfMissing ? newStub(owner, input.archive_id, createStubIfMissing, at) : null);
    if (!base) return null;
    const next: SessionMetadata = { ...base, normalized, updated_at: at };
    if (base.head === undefined) next.dropped_prefix = droppedPrefixOf(normalized);
    if (input.withheld_calls !== undefined) {
      if (Object.keys(input.withheld_calls).length > 0) next.withheld_calls = input.withheld_calls;
      else delete next.withheld_calls;
    }
    if (input.applied) {
      next.applied = withApplied(base.applied, {
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
  format: string;
  session_id: string;
  now?: () => Date;
  /** Why: `deleted` (the default) by the owner or an admin, `retracted` by the uploading
   * machine (F9.7), `redacted` by an operator. */
  reason?: TombstoneReason;
  /** Who removed it; the owner through the upload route by default. */
  writer?: Writer;
}

interface TombstoneDecision extends ChangeUpdate {
  traces: string[] | null;
}

function tracesEveryAttemptRead(attempts: readonly TombstoneDecision[]): string[] | null {
  let read: Set<string> | null = null;
  for (const { traces } of attempts) {
    read = traces === null ? null : new Set([...(read ?? []), ...traces]);
  }
  return read === null ? null : [...read];
}

/** Remove a session's trace objects and mark it redacted. Irreversible; a later ingest
 * of the same session is refused, so a tombstoned session stays gone. The change entry records
 * the reason and the writer, never the content. A stub (F3.4) is tombstoned like any session:
 * it becomes `redacted`, so what would have extended it is refused, and its entry names no
 * trace. A session never published (no metadata) has only its span records and pending marker
 * removed; null when there was nothing to remove. */
export async function tombstone(input: TombstoneInput): Promise<{ removed: number } | null> {
  const { store, owner } = input;
  const archive = archiveId(owner, input.format, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
  const { attempts } = await updateMetadataWithChange(
    store,
    owner,
    archive,
    (existing): TombstoneDecision => {
      if (!existing) return { next: null, change: null, traces: null };
      const {
        head: _head,
        normalized: _n,
        dropped_prefix: _d,
        withheld_calls: _w,
        applied: _a,
        ...rest
      } = existing;
      return {
        next: { ...rest, status: "redacted", traces: [], updated_at: at },
        change: {
          kind: "tombstone",
          at,
          owner,
          archive_id: archive,
          session_id: input.session_id,
          format: existing.format,
          content_hash: existing.head ?? null,
          writer: input.writer ?? localWriter(owner),
          owner_basis: existing.owner_basis,
          reason: input.reason ?? "deleted",
        },
        traces: existing.traces.map((t) => t.content_hash),
      };
    },
  );
  const gone = tracesEveryAttemptRead(attempts);
  if (gone === null) {
    const spans = await deleteSpans(store, owner, archive);
    await deletePending(store, archive);
    return spans > 0 ? { removed: spans } : null;
  }
  let removed = 0;
  for (const hash of gone) {
    await store.delete(keys.trace(owner, archive, hash));
    removed++;
  }
  await deleteSpans(store, owner, archive);
  await deletePending(store, archive);
  return { removed };
}

/** Delete a session's span-assembly marker (`assembly/pending/`), which only a server's OTLP
 * intake writes. A key limited to its owner's folder may not touch `assembly/` (F11.11): there
 * is no marker to delete then, so a refusal is not an error. */
async function deletePending(store: Store, archive: string): Promise<void> {
  try {
    await store.delete(keys.pending(archive));
  } catch (err) {
    if (!accessDeniedIn(err)) throw err;
  }
}

/** Remove what a tombstone of an already tombstoned session left behind: trace objects still in
 * its folder, span records, the pending marker; how many trace objects went. A session not
 * redacted is left alone. */
export async function finishTombstone(input: {
  store: Store;
  owner: string;
  format: string;
  session_id: string;
}): Promise<number> {
  const { store, owner } = input;
  const archive = archiveId(owner, input.format, input.session_id);
  const metadata = await readMetadata(store, owner, archive);
  if (metadata?.status !== "redacted") return 0;
  const prefix = `${keys.session(owner, archive)}/trace.`;
  const found: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    found.push(...page.keys);
    if (!page.truncated || page.keys.length === 0) break;
    after = page.keys.at(-1);
  }
  for (const key of found) await store.delete(key);
  await deleteSpans(store, owner, archive);
  await deletePending(store, archive);
  return found.length;
}

export interface SetVisibilityInput {
  store: Store;
  owner: string;
  format: string;
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
  const archive = archiveId(owner, input.format, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
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
        format: existing.format,
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

/** One stored trace, the canonical `seshi/trace/1` object; null when there is none. Render it
 * with `renderTrace` from `@seshi/formats` for another format. */
export async function getTrace(
  store: Store,
  owner: string,
  archive: string,
  contentHash: string,
): Promise<Trace | null> {
  const bytes = await getBytes(store, keys.trace(owner, archive, contentHash));
  return bytes === null ? null : decodeTrace(bytes);
}

export async function getSession(
  store: Store,
  owner: string,
  format: string,
  sessionId: string,
): Promise<SessionMetadata | null> {
  return readMetadata(store, owner, archiveId(owner, format, sessionId));
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
        return bytes === null ? null : decodeMetadata(bytes);
      }),
    )
  ).filter((m): m is SessionMetadata => m !== null);
  return { sessions, cursor: page.cursor, truncated: page.truncated };
}

export function keyPastSpansOf(sessionFolder: string): string {
  return `${sessionFolder}/spans0`;
}

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
        past = keyPastSpansOf(key.slice(0, at));
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

/** The latest record timestamp, as an ISO timestamp; undefined when no record has one. */
export function lastActivity(records: readonly object[]): string | undefined {
  let at: number | undefined;
  for (const record of records) {
    const stamp = (record as { timestamp?: unknown }).timestamp;
    if (typeof stamp !== "string") continue;
    const t = Date.parse(stamp);
    if (Number.isFinite(t) && (at === undefined || t > at)) at = t;
  }
  return at === undefined ? undefined : new Date(at).toISOString();
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}
