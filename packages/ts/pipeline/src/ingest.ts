/** The write path: objects in the store out.
 *
 * `putRaw` comes first: the redacted transcript as the session's raw part, and the session's
 * `metadata.json` if it is the first. `ingest` follows with what normalizing that transcript
 * produced: cap → parse (validate, strip NUL, events, hash) → dedupe on `(owner, content_hash)`
 * → publish the canonical trace (`seshi/trace/1`, X6.2) → update `metadata.json` → change
 * entry. `tombstone` undoes both. Redaction happened in `redactRaw` and `normalizeTranscript`;
 * the hash is over what the latter produced.
 *
 * `metadata.json` is updated with If-Match and retried on 412 (X6.5), so two writers on one
 * session (an API instance and the worker, two uploads racing) each see the other's update.
 * Every write records who made it (X5.5): the session keeps its original writer and how its
 * owner was established, and each change entry its own writer. */

import {
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
  type PutRawResult,
  parseTrace,
  type RawFormat,
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
  appendChange,
  archiveId,
  decodeJson,
  ensureLayout,
  getBytes,
  gunzipJson,
  gzipJson,
  keys,
  publishObject,
  readMetadata,
  type Store,
  sha256,
  updateMetadata,
} from "@seshi/store";
import { DEFAULT_LIMITS, type Limits } from "./limits";

export { IngestRejected, type IngestResult, type PutRawResult, type StoredTrace };

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
    raw: [],
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

/** Redaction counts summed over two writes; the later rule set is the one that last ran. */
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
  /** Normalized and redacted; `parseTrajectory` validates the shape. */
  records: readonly NormalizedRecord[];
  metadata: IngestMetadata;
  /** Identifies the writer in the layout marker (`seshi/0.9.0`). */
  client?: string;
  now?: () => Date;
  /** Where the session's log stands once these records are in, written with the pointer. */
  normalized?: NormalizedState;
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
  await ensureLayout(store, { createdBy: input.client ?? "seshi" });

  const before = await readMetadata(store, owner, archive);
  if (before?.status === "redacted") {
    throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
  }

  const outcome = await publishObject(
    store,
    keys.trace(owner, archive, trace.content_hash),
    gzipJson(trace),
    "application/gzip",
  );

  const context: WriteContext = { ...input, writer, provenance };
  // Whether the pointer already listed this trace, as of the version the update applied to.
  let already = false;
  const pointer = updateMetadata(store, owner, archive, (existing) => {
    if (existing?.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
    }
    const listed = existing?.traces.find((t) => t.content_hash === trace.content_hash);
    already = listed !== undefined;
    const ref: SessionTraceRef = {
      content_hash: trace.content_hash,
      created_at: listed?.created_at ?? at,
      records: trace.records.length,
    };
    if (metadata.continuation) ref.continuation = metadata.continuation;

    const base =
      existing ?? newSession(owner, archive, metadata.session_id, metadata.agent, at, context);
    const next: SessionMetadata = withContext(
      {
        ...base,
        source: trace.source,
        status: "stored",
        head: trace.content_hash,
        traces: listed ? base.traces : [...base.traces, ref],
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
    if (metadata.normalizer) next.normalizer = metadata.normalizer;
    const redaction = addRedaction(base.redaction, input.redaction);
    if (redaction) next.redaction = redaction;
    return changed(existing, next) ? next : null;
  });
  try {
    await pointer;
  } catch (err) {
    // Tombstoned between the check above and now: the tombstone already removed the objects
    // it knew of, so the one this write just created would be left behind. Remove it too.
    if (err instanceof IngestRejected && err.code === "redacted" && outcome === "written") {
      await store.delete(keys.trace(owner, archive, trace.content_hash));
    }
    throw err;
  }

  // A duplicate is one the pointer already lists and whose object was there: nothing new to say.
  // An object that exists without a pointer entry (an interrupted earlier publish) is completed
  // here, pointer and change entry included.
  const duplicate = already && outcome === "exists";
  if (!duplicate) {
    await appendChange(store, {
      kind: "published",
      at,
      owner,
      archive_id: archive,
      session_id: metadata.session_id,
      content_hash: trace.content_hash,
      writer,
      ...(metadata.continuation ? { continuation: metadata.continuation } : {}),
    });
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

export interface PutRawInput extends WriteContext {
  store: Store;
  owner: string;
  agent: string;
  session_id: string;
  part: number;
  format: RawFormat;
  /** Already redacted (`redactRaw`) and gzipped. */
  bytes: Uint8Array;
  /** Where the part sits in the log: its first byte's offset, and the log bytes it covers
   * before redaction. */
  offset: number;
  length: number;
  /** The part is the whole log: every other part stored is of an earlier version of it and is
   * removed. */
  whole?: boolean;
  /** The calls withheld in the log so far, this part included (`SessionMetadata.withheld_calls`). */
  withheld_calls?: SessionMetadata["withheld_calls"];
  /** Identifies the writer in the layout marker. */
  client?: string;
  now?: () => Date;
  /** Size caps; `DEFAULT_LIMITS` when omitted. */
  limits?: Readonly<Limits>;
}

/** Store one raw part. The first thing stored for a session: when there is no `metadata.json`
 * yet this writes one with the part and no head, and the trace, if the transcript normalizes to
 * one, is added by `ingest` after. Idempotent for the same bytes. Raw is transitional: 04 stops
 * storing it (X6.3). */
export async function putRaw(input: PutRawInput): Promise<PutRawResult> {
  const { store, owner, part, format, offset, length } = input;
  const maxBytes = (input.limits ?? DEFAULT_LIMITS).max_upload_bytes;
  if (input.bytes.length > maxBytes) {
    throw new IngestRejected("too_large", `raw part exceeds ${maxBytes} bytes`);
  }
  if (!Number.isInteger(part) || part < 0) throw new IngestRejected("invalid", "part must be ≥ 0");
  const archive = archiveId(owner, input.agent, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
  await ensureLayout(store, { createdBy: input.client ?? "seshi" });
  const before = await readMetadata(store, owner, archive);
  if (before?.status === "redacted") {
    throw new IngestRejected("redacted", "session was redacted");
  }

  const outcome = await publishObject(
    store,
    keys.raw(owner, archive, part, format),
    input.bytes,
    "application/gzip",
    "replace",
  );
  const withheld =
    input.withheld_calls && Object.keys(input.withheld_calls).length > 0
      ? input.withheld_calls
      : undefined;
  let stale: SessionMetadata["raw"] = [];
  const update = await updateMetadata(store, owner, archive, (existing) => {
    if (existing?.status === "redacted") {
      throw new IngestRejected("redacted", "session was redacted");
    }
    const others = (existing?.raw ?? []).filter((r) => r.part !== part);
    stale = input.whole ? others : [];
    const same = existing?.raw.find((r) => r.part === part);
    if (same && outcome === "exists" && same.offset === offset && same.length === length) {
      const kept = JSON.stringify(existing?.withheld_calls ?? null);
      if (stale.length === 0 && kept === JSON.stringify(withheld ?? null)) return null;
    }
    const raw = [
      ...(input.whole ? [] : others),
      {
        part,
        format,
        size: input.bytes.length,
        sha256: sha256(input.bytes),
        created_at: at,
        offset,
        length,
      },
    ].sort((a, b) => a.part - b.part);
    const base = existing ?? newSession(owner, archive, input.session_id, input.agent, at, input);
    const next: SessionMetadata = withContext(
      { ...base, raw, raw_format: format, updated_at: at },
      input,
    );
    // A whole log starts the chunk state over: what was normalized was of the parts just removed.
    if (input.whole) delete next.normalized;
    if (withheld) next.withheld_calls = withheld;
    else delete next.withheld_calls;
    return next;
  });
  if (!update.written) return { status: "exists", part };
  // The pointer no longer lists them, so no reader looks for them any more.
  for (const r of stale) await store.delete(keys.raw(owner, archive, r.part, r.format));
  return { status: "stored", part };
}

/** Record where a session's log stands when nothing was ingested for it: a trivial session, a
 * chunk with no records in it. */
export async function recordNormalized(input: {
  store: Store;
  owner: string;
  agent: string;
  session_id: string;
  normalized: NormalizedState;
  now?: () => Date;
}): Promise<void> {
  const { store, owner, normalized } = input;
  const archive = archiveId(owner, input.agent, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
  await updateMetadata(store, owner, archive, (existing) =>
    !existing || existing.status === "redacted"
      ? null
      : { ...existing, normalized, updated_at: at },
  );
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

/** Remove a session's trace and raw objects and mark it redacted. Irreversible; a later ingest
 * of the same session is refused, so a tombstoned session stays gone. The change entry records
 * the reason and the writer, never the content. */
export async function tombstone(input: TombstoneInput): Promise<{ removed: number } | null> {
  const { store, owner } = input;
  const archive = archiveId(owner, input.agent, input.session_id);
  const at = (input.now ?? (() => new Date()))().toISOString();
  let removedObjects: { traces: string[]; raw: SessionMetadata["raw"] } | null = null;
  let head: string | null = null;
  // Mark it redacted first, so no write that races the removal can give it a new head.
  await updateMetadata(store, owner, archive, (existing) => {
    if (!existing) {
      removedObjects = null;
      return null;
    }
    removedObjects = { traces: existing.traces.map((t) => t.content_hash), raw: existing.raw };
    head = existing.head ?? null;
    const { head: _head, ...rest } = existing;
    return { ...rest, status: "redacted", traces: [], raw: [], updated_at: at };
  });
  const gone = removedObjects as { traces: string[]; raw: SessionMetadata["raw"] } | null;
  if (gone === null) return null;
  let removed = 0;
  for (const hash of gone.traces) {
    await store.delete(keys.trace(owner, archive, hash));
    removed++;
  }
  for (const r of gone.raw) {
    await store.delete(keys.raw(owner, archive, r.part, r.format));
    removed++;
  }
  await appendChange(store, {
    kind: "tombstone",
    at,
    owner,
    archive_id: archive,
    session_id: input.session_id,
    content_hash: head,
    writer: input.writer ?? localWriter(owner),
    reason: input.reason ?? "deleted",
  });
  return { removed };
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
 * key; a reader that wants an index builds its own from `changes/`. */
export async function listSessions(
  store: Store,
  owner: string,
  options: { startAfter?: string; limit?: number } = {},
): Promise<{ sessions: SessionMetadata[]; cursor: string | undefined; truncated: boolean }> {
  const prefix = keys.sessions(owner);
  const page = await store.list(prefix, { startAfter: options.startAfter, limit: options.limit });
  const metadataKeys = page.keys.filter((k) => k.endsWith("/metadata.json"));
  const sessions = (
    await Promise.all(
      metadataKeys.map(async (k) => {
        const bytes = await getBytes(store, k);
        return bytes === null ? null : decodeJson<SessionMetadata>(bytes);
      }),
    )
  ).filter((m): m is SessionMetadata => m !== null);
  return { sessions, cursor: page.keys.at(-1), truncated: page.truncated };
}
