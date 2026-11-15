/** One ingest pipeline (X4): five ways in, one way through. Every source builds an envelope and
 * submits it here; the stages run in order, in memory, and the session is written last, so
 * nothing is stored before regex redaction, the session filter and model review have run
 * (X4.3). Only the normalized, redacted trace is stored, never the payload (X6.3).
 *
 * 1. Authorize the caller and resolve the owner (`Authorizer`).
 * 2. Normalize the payload in memory: a whole log through its format adapter; a chunk through
 *    the adapter's partial mode, with the session's small stored state (`metadata.normalized`:
 *    where the log ends and the prefix hash; `withheld_calls`).
 * 3. Regex redaction on the normalized records (`Redactor`, F2).
 * 4. The session filter, on a session's first trace only (X4.10).
 * 5. Model review (`Reviewer`, F3): allow, redact or drop.
 * 6. Write the trace, the head and the change entry (`ingest`).
 *
 * Logs are processed inline (X4.4): the call returns once the session is written, so an
 * uploader learns at once about 409 `offset_mismatch` (with `expected`), 409 `conflict` or 422.
 * Span batches go to the span assembler (X4.2), which returns once they are stored.
 *
 * The log protocol without raw (X6.3, F9.1): until a session has a trace the server stores
 * nothing for it and takes only the whole log, so a chunk (`offset` > 0) for such a session is
 * 409 `offset_mismatch` with `expected: 0`. Once it has one, a chunk must start where the
 * session's log ends, and a whole upload must extend what is stored (its records start with
 * the stored prefix) or set `replace`, which only the original writer or an admin may (X4.6).
 *
 * Every envelope carries an idempotency key (X4.7); a session remembers the last ones it applied
 * with their answers, so a resend gets the same answer and runs no stage again. A permanent
 * failure is thrown to a caller that is waiting (uploads, hooks) and recorded under
 * `sources/<id>/failed/` for one that is not (pollers, the assembler); a transient one (the
 * store) is always thrown, so it is retried (X4.8). */

import { type FormatRegistry, NORMALIZER, NormalizeError } from "@seshi/formats";
import {
  type AppliedEnvelope,
  EMPTY_PREFIX_SHA256,
  type Envelope,
  Forbidden,
  IngestRejected,
  type LlmCall,
  type NormalizedRecord,
  type NormalizedState,
  OffsetMismatch,
  PrefixHash,
  prefixSha256,
  type RedactionSummary,
  SessionConflict,
  type SessionMetadata,
  SessionRejected,
  type ShippedState,
  StoreError,
  type StoreSessionResult,
  VERSION,
  type Visibility,
} from "@seshi/model";
import {
  type RedactionRules,
  type Redactor,
  redactionRules,
  redactLlmCalls,
  ruleRedactor,
} from "@seshi/redact";
import {
  archiveId,
  ensureLayout,
  isPreconditionFailed,
  listReviews,
  readMetadata,
  type Store,
  writeDropped,
  writeFailed,
  writeReview,
} from "@seshi/store";
import { copiedPrefix, planShipment } from "./continuation";
import {
  checkEnvelope,
  hasCaller,
  isLogEnvelope,
  type LogEnvelope,
  type SpanEnvelope,
} from "./envelope";
import { type FilterSetting, filterRulesFor, isFiltered } from "./filter";
import {
  getSession,
  getTrace,
  ingest,
  recordProgress,
  type WithheldCallIds,
  type WriteContext,
} from "./ingest";
import { DEFAULT_LIMITS, type Limits } from "./limits";
import {
  type AssembledSession,
  type Authorization,
  type Authorizer,
  type HealthCounters,
  mayReplace,
  noHealth,
  noReview,
  permissiveAuthorizer,
  type ReviewDecision,
  type Reviewer,
  type ReviewNote,
  type SpanAssembler,
  type SpanBatchResult,
} from "./stages";

export interface PipelineOptions {
  store: Store;
  /** The formats this deployment reads: `apps/seshi` builds the registry from its
   * integrations. */
  formats: FormatRegistry;
  /** Identifies the writer in the layout marker (`seshi/0.9.0`). */
  client?: string;
  now?: () => Date;
  /** The redaction stage; `ruleRedactor(redaction)` when omitted. */
  redactor?: Redactor;
  /** The operator's rules, added to the built-in ones, when no `redactor` is given. */
  redaction?: RedactionRules;
  /** The session filter (X4.10): config's `[filter]`, or the rules per source id
   * (`(id) => filterFor(config, id)`); `DEFAULT_FILTER` when omitted. */
  filter?: FilterSetting;
  /** Size caps, config's `[limits]`; `DEFAULT_LIMITS` when omitted. */
  limits?: Readonly<Limits>;
  /** Stage 1; `permissiveAuthorizer()` when omitted. */
  authorizer?: Authorizer;
  /** Stage 5; `noReview()` when omitted. */
  reviewer?: Reviewer;
  /** Where span batches go; without one a span batch is refused (`unsupported_payload`). */
  assembler?: SpanAssembler;
  /** Source health; `noHealth()` when omitted. */
  health?: HealthCounters;
  /** The visibility of a new session whose envelope sets none (X5.10): the source's setting,
   * then the server's `default_visibility` (`(id) => visibilityFor(config, id)`); `org` when
   * omitted. The request and the token's default are the envelope's `visibility`. */
  visibility?: VisibilitySetting;
}

/** One visibility for every source, or the visibility per source id. */
export type VisibilitySetting = Visibility | ((sourceId: string) => Visibility);

/** A permanent failure with no caller to tell, as recorded (X4.8). */
export interface FailedResult {
  status: "failed";
  code: string;
  message: string;
  /** The failure record's key under `sources/<id>/failed/`. */
  record: string;
}

export type SubmitResult = StoreSessionResult | FailedResult | SpanBatchResult;

export interface SubmitOptions {
  /** What a permanent failure does: `throw` it to the caller, or `record` it under
   * `sources/<id>/failed/` and answer `failed`. By default uploads and hooks throw and every
   * other source records (`hasCaller`). */
  onFailure?: "throw" | "record";
}

/** What a session the server holds nothing of answers (X6.3): the next upload is the whole
 * log again. */
const NOTHING: ShippedState = {
  records_total: 0,
  prefix_sha256: EMPTY_PREFIX_SHA256,
  bytes_total: 0,
};

/** How many times a whole upload is planned again when another write to the session landed
 * between reading it and writing. */
const PLAN_ATTEMPTS = 3;

/** Another write changed the session after it was read: plan again. */
class StalePlan extends Error {
  constructor() {
    super("the session changed while this envelope was written");
    this.name = "StalePlan";
  }
}

/** A refusal that sending the same envelope again cannot change. */
function isPermanent(err: unknown): err is { code: string; message: string } {
  return (
    err instanceof SessionRejected ||
    err instanceof OffsetMismatch ||
    err instanceof SessionConflict ||
    err instanceof Forbidden
  );
}

/** The longest failure message a failure record keeps. */
const RECORDED_MESSAGE_LENGTH = 300;

/** A failure's message as a failure record keeps it: never content (X4.8). An adapter's or the
 * trace validator's message can quote what it could not read (`unknown role "…"`, a JSON parse
 * error naming the token), so double-quoted text is elided and the message is capped. */
export function recordedMessage(message: string): string {
  const scrubbed = message.replace(/"(?:[^"\\]|\\.)*"/g, '"…"');
  return scrubbed.length > RECORDED_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, RECORDED_MESSAGE_LENGTH - 1)}…`
    : scrubbed;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function shippedOf(normalized: NormalizedState): ShippedState {
  return {
    records_total: normalized.records,
    prefix_sha256: normalized.prefix_sha256,
    bytes_total: normalized.bytes,
  };
}

function stateOf(records: readonly NormalizedRecord[], bytes: number): NormalizedState {
  const hash = PrefixHash.of(records);
  return {
    bytes,
    records: records.length,
    prefix_sha256: hash.digest(),
    hash_state: hash.export(),
  };
}

/** A recorded branch name, or undefined for the detached (`HEAD`) and empty values agents
 * record. */
function recordedBranch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const branch = value.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

function metaOf(records: readonly NormalizedRecord[]): NormalizedRecord | undefined {
  return records[0]?.role === "meta" ? records[0] : undefined;
}

/** The answer an applied envelope gave, given again (X4.7). */
function replayed(applied: AppliedEnvelope, session: SessionMetadata): StoreSessionResult {
  const shipped: ShippedState = {
    records_total: applied.records_total,
    prefix_sha256: applied.prefix_sha256,
    bytes_total: applied.bytes_total,
  };
  if ((applied.status === "stored" || applied.status === "duplicate") && applied.content_hash) {
    return {
      status: applied.status,
      archive_id: session.archive_id,
      content_hash: applied.content_hash,
      session_id: session.session_id,
      records: applied.records ?? 0,
      events: applied.events ?? 0,
      ...shipped,
    };
  }
  return { status: applied.status === "dropped" ? "dropped" : "unchanged", ...shipped };
}

/** The LLM calls the records name, in their order. */
function callsFor(
  records: readonly NormalizedRecord[],
  calls: readonly LlmCall[] | undefined,
): LlmCall[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  const named = new Set(
    records.map((r) => (r as { llm_call?: string }).llm_call).filter((id) => id !== undefined),
  );
  const kept = calls.filter((c) => named.has(c.id));
  return kept.length > 0 ? kept : undefined;
}

/** `summary` with `extra` counts added. */
function withCounts(
  summary: RedactionSummary,
  extra: Readonly<Record<string, number>>,
): RedactionSummary {
  if (Object.keys(extra).length === 0) return summary;
  const counts = { ...summary.counts };
  for (const [rule, n] of Object.entries(extra)) counts[rule] = (counts[rule] ?? 0) + n;
  return { ...summary, counts };
}

/** One envelope on its way through: who, whose, which session, as stored when read. */
interface Run {
  envelope: Envelope;
  auth: Authorization;
  owner: string;
  archive: string;
  session: SessionMetadata | null;
}

/** What a run decided to write: the records (the meta record first), where they sit in the
 * session's log, and whether they replace it. */
interface Plan {
  write: NormalizedRecord[];
  continuation?: { from_record: number; prefix_sha256: string };
  replace?: boolean;
  /** The session's log state once the envelope is in: what the answer and the next chunk
   * continue from. */
  normalized: NormalizedState;
  withheld: WithheldCallIds;
  summary: RedactionSummary;
  llm_calls?: readonly LlmCall[];
  project?: string;
  branch?: string;
  /** Refuses a stored session that is not the one the plan was made against. */
  guard: (existing: SessionMetadata | null) => void;
}

interface Outcome {
  result: StoreSessionResult;
  /** A resend answered from the session's applied envelopes. */
  replay?: boolean;
}

export class Pipeline {
  readonly store: Store;
  readonly formats: FormatRegistry;
  private readonly client: string;
  private readonly now: () => Date;
  private readonly redactor: Redactor;
  private readonly filter: FilterSetting | undefined;
  private readonly limits: Readonly<Limits>;
  private readonly authorizer: Authorizer;
  private readonly reviewer: Reviewer;
  private readonly assembler: SpanAssembler | undefined;
  readonly health: HealthCounters;
  private readonly visibility: VisibilitySetting;
  private layoutChecked: Promise<unknown> | undefined;

  constructor(options: PipelineOptions) {
    this.store = options.store;
    this.formats = options.formats;
    this.client = options.client ?? `seshi/${VERSION}`;
    this.now = options.now ?? (() => new Date());
    this.redactor = options.redactor ?? ruleRedactor(options.redaction ?? redactionRules());
    this.filter = options.filter;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.authorizer = options.authorizer ?? permissiveAuthorizer();
    this.reviewer = options.reviewer ?? noReview();
    this.assembler = options.assembler;
    this.health = options.health ?? noHealth();
    this.visibility = options.visibility ?? "org";
  }

  /** The layout marker, checked once per pipeline (and again after a failure). */
  private layout(): Promise<unknown> {
    this.layoutChecked ??= ensureLayout(this.store, { createdBy: this.client }).catch((err) => {
      this.layoutChecked = undefined;
      throw err;
    });
    return this.layoutChecked;
  }

  /** Run one envelope through every stage (see above). */
  async submit(envelope: Envelope, options: SubmitOptions = {}): Promise<SubmitResult> {
    try {
      checkEnvelope(envelope);
      const auth = await this.authorizer.authorize(envelope);
      if (!isLogEnvelope(envelope)) return await this.spans(envelope as SpanEnvelope, auth);
      const { result, replay } = await this.log(envelope, auth);
      this.health.count(envelope.source_id, replay ? "duplicate" : result.status);
      return result;
    } catch (err) {
      return this.failed(envelope, err, options);
    }
  }

  /** A session the span assembler rebuilt, through the filter, review and the write. The
   * assembler is the session's writer and rebuilds the whole session every time, so what does
   * not extend the stored trace replaces it. The idempotency key is the assembled records'
   * digest, not the batch's: the same assembly published twice is applied once. A permanent
   * failure is recorded, as for any source with no caller to tell (X4.8). */
  async publishAssembled(
    input: AssembledSession,
    options: SubmitOptions = {},
  ): Promise<StoreSessionResult | FailedResult> {
    const envelope: Envelope = {
      ...input.envelope,
      idempotency_key: `assembled#${prefixSha256(input.records, input.records.length)}`,
    };
    try {
      checkEnvelope(envelope);
      const auth = await this.authorizer.authorize(envelope);
      const outcome = await this.planned(envelope, auth, (run) =>
        this.whole(run, input.records, 0, { replace: true, llm_calls: input.llm_calls }),
      );
      this.health.count(envelope.source_id, outcome.replay ? "duplicate" : outcome.result.status);
      return outcome.result;
    } catch (err) {
      return this.failed(envelope, err, options);
    }
  }

  /** A failure: thrown when transient, or to a caller who waits; otherwise recorded under
   * `sources/<id>/failed/` (X4.8). */
  private async failed(
    envelope: Envelope,
    err: unknown,
    options: SubmitOptions,
  ): Promise<FailedResult> {
    if (!isPermanent(err)) throw err;
    const respond = options.onFailure ?? (hasCaller(envelope) ? "throw" : "record");
    // Telling an uploader where its log ends is the protocol working, not a refusal.
    if (!(err instanceof OffsetMismatch)) {
      this.health.count(envelope.source_id, respond === "throw" ? "rejected" : "failed");
    }
    if (respond === "throw") throw err;
    const message = recordedMessage(err.message);
    const record = await writeFailed(this.store, {
      at: this.now().toISOString(),
      source: envelope.source_id,
      source_kind: envelope.source,
      owner: envelope.owner,
      session_key: envelope.session_key,
      idempotency_key: envelope.idempotency_key,
      ...(envelope.provenance ? { provenance: envelope.provenance } : {}),
      code: err.code,
      message,
    });
    return { status: "failed", code: err.code, message, record };
  }

  // --- spans --------------------------------------------------------------------

  private async spans(envelope: SpanEnvelope, auth: Authorization): Promise<SpanBatchResult> {
    if (!this.assembler) {
      throw new SessionRejected(
        "unsupported_payload",
        "this deployment has no span assembler; span batches cannot be taken",
      );
    }
    if (!this.formats.has(envelope.format)) this.unsupported(envelope.format);
    const archive_id = archiveId(auth.owner, envelope.format, envelope.session_key);
    return this.assembler.accept({ envelope, authorization: auth, archive_id });
  }

  private unsupported(format: string): never {
    throw new SessionRejected(
      "unsupported_agent",
      `no normalizer for '${format}' (one of ${this.formats.sources.join(", ")})`,
    );
  }

  // --- logs ---------------------------------------------------------------------

  private async log(envelope: LogEnvelope, auth: Authorization): Promise<Outcome> {
    const { payload } = envelope;
    if (!this.formats.has(envelope.format)) this.unsupported(envelope.format);
    const max = this.limits.max_upload_bytes;
    if (utf8Length(payload.text) > max) {
      throw new IngestRejected("too_large", `upload exceeds ${max} bytes`);
    }
    if (payload.offset > 0) {
      if (payload.encoding !== "jsonl") {
        throw new SessionRejected("bad_chunk", "only a jsonl log can be sent in chunks");
      }
      if (!this.formats.isChunkable(envelope.format)) {
        throw new SessionRejected(
          "bad_chunk",
          `a ${envelope.format} document cannot be sent in chunks`,
        );
      }
      if (!payload.text.endsWith("\n")) {
        throw new SessionRejected("bad_chunk", "a chunk must end at a line boundary");
      }
      return this.planned(envelope, auth, (run) => this.chunk(run, payload.text, payload.offset));
    }
    if (payload.text.trim() === "") throw new SessionRejected("empty", "transcript is empty");
    // The whole log's records do not depend on what is stored: normalize once.
    const records = this.normalize(envelope.format, payload.text, envelope.session_key);
    return this.planned(envelope, auth, (run) =>
      this.whole(run, records, utf8Length(payload.text), { replace: envelope.replace === true }),
    );
  }

  /** Read the session, answer a resend from it, else run `body` against it; plan again when
   * another write to the session landed first. */
  private async planned(
    envelope: Envelope,
    auth: Authorization,
    body: (run: Run) => Promise<StoreSessionResult>,
  ): Promise<Outcome> {
    await this.layout();
    const owner = auth.owner;
    const archive = archiveId(owner, envelope.format, envelope.session_key);
    for (let attempt = 1; ; attempt++) {
      const session = await readMetadata(this.store, owner, archive);
      if (session?.status === "redacted") {
        throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
      }
      const applied = session?.applied?.find((a) => a.idempotency_key === envelope.idempotency_key);
      if (session && applied) return { result: replayed(applied, session), replay: true };
      // A caller whose owner is only claimed (the org key, X5.12) writes new sessions under any
      // username, but never adds to one whose owner was verified: the session would still say
      // `verified` while holding what anyone with the key sent (X5.5).
      if (
        session &&
        !auth.admin &&
        auth.owner_basis === "claimed" &&
        session.owner_basis !== "claimed"
      ) {
        throw new Forbidden(
          "an org-key caller cannot write to a session whose owner was verified; that person's own token can",
        );
      }
      try {
        return { result: await body({ envelope, auth, owner, archive, session }) };
      } catch (err) {
        if (!(err instanceof StalePlan)) throw err;
        if (attempt >= PLAN_ATTEMPTS) {
          throw new StoreError("the session kept changing while this envelope was written");
        }
      }
    }
  }

  /** Stage 2 for a log: the adapter's records, unredacted. A log the adapter reads but finds no
   * conversation in has none. */
  private normalize(
    format: string,
    text: string,
    sessionId: string,
    offset = 0,
  ): NormalizedRecord[] {
    try {
      return this.formats.normalize({
        source: format,
        transcript: text,
        ...(offset > 0 ? { chunk: { offset, session_id: sessionId } } : {}),
      }).records;
    } catch (err) {
      if (err instanceof NormalizeError) {
        throw new SessionRejected(`normalize_${err.code}`, err.message);
      }
      throw err;
    }
  }

  /** A chunk: the bytes of the log from where the session's log ends, normalized on its own and
   * written as a continuation of the head. Never filtered: the session's first trace was. */
  private async chunk(run: Run, text: string, offset: number): Promise<StoreSessionResult> {
    const { session, envelope } = run;
    if (!session?.head || !session.normalized) {
      // Nothing is stored for a session without a trace (X6.3): send the whole log.
      throw new OffsetMismatch(offset, 0);
    }
    const state = session.normalized;
    if (offset !== state.bytes) throw new OffsetMismatch(offset, state.bytes);
    const guard = (existing: SessionMetadata | null) => {
      const at = existing?.head ? (existing.normalized?.bytes ?? 0) : 0;
      if (at !== offset) throw new OffsetMismatch(offset, at);
      // The log did not move but a redaction backfill rewrote the session (a new head, or the
      // same hash with what it leaves out redacted, and always a new rule set): the meta record
      // read from the old head may hold what the new rules take out. Plan again.
      if (
        existing?.head !== session.head ||
        existing?.redaction?.rule_set !== session.redaction?.rule_set
      ) {
        throw new StalePlan();
      }
    };
    const raw = this.normalize(envelope.format, text, envelope.session_key, offset);
    const redacted = this.redactor.redact(raw, session.withheld_calls ?? {});
    const bytes = offset + utf8Length(text);
    if (redacted.records.length === 0) {
      // Lines with no records in them (transport, progress): the log moved on, nothing to write.
      const normalized = { ...state, bytes };
      return this.progress(run, normalized, redacted.withheld, "unchanged", guard);
    }
    const hash = PrefixHash.resume(state.hash_state);
    for (const record of redacted.records) hash.append(record);
    const normalized: NormalizedState = {
      bytes,
      records: hash.records,
      prefix_sha256: hash.digest(),
      hash_state: hash.export(),
    };
    // The session's meta record is the head's: a chunk has none of its own.
    const head = await getTrace(this.store, run.owner, run.archive, session.head);
    // Gone because the session moved since it was read (a backfill or a replace removed it):
    // plan again on the session as it is now, rather than write a continuation with no meta.
    if (head === null) {
      const now = await readMetadata(this.store, run.owner, run.archive);
      if (now?.head !== session.head) throw new StalePlan();
    }
    const meta = head ? metaOf(head.records as NormalizedRecord[]) : undefined;
    return this.commit(run, {
      write: [...(meta ? [meta] : []), ...redacted.records],
      continuation: { from_record: state.records, prefix_sha256: state.prefix_sha256 },
      normalized,
      withheld: redacted.withheld,
      summary: redacted.summary,
      project: envelope.project ?? session.project,
      branch: envelope.branch ?? session.branch,
      guard,
    });
  }

  /** A whole session (a whole log, or what the assembler rebuilt): the first trace, judged by
   * the session filter; a tail that extends the stored session, never judged; or, with
   * `replace`, a rewrite of the session by its original writer or an admin (X4.6). */
  private async whole(
    run: Run,
    raw: readonly NormalizedRecord[],
    bytes: number,
    options: { replace: boolean; llm_calls?: readonly LlmCall[] },
  ): Promise<StoreSessionResult> {
    const { session, envelope } = run;
    const expectedHead = session?.head;
    const expectedPrefix = session?.normalized?.prefix_sha256;
    const guard = (existing: SessionMetadata | null) => {
      if (
        existing?.head !== expectedHead ||
        existing?.normalized?.prefix_sha256 !== expectedPrefix
      ) {
        throw new StalePlan();
      }
    };
    const meta = metaOf(raw);
    const branch = recordedBranch((meta as { git_branch?: unknown } | undefined)?.git_branch);
    const common = {
      llm_calls: options.llm_calls,
      project: envelope.project,
      branch: branch ?? envelope.branch,
      guard,
    };

    if (session?.head) {
      // What is stored: the server's own state, or for a session without it what the uploader
      // says shipped.
      const base =
        session.normalized ??
        (envelope.shipped
          ? { records: envelope.shipped.records, prefix_sha256: envelope.shipped.prefix_sha256 }
          : undefined);
      if (base && base.records > 0 && base.records <= raw.length) {
        // Redact the stored prefix and the tail as two passes of one: the tail carries the
        // prefix's withheld calls, and only the tail's matches count, since only it is written.
        const prefix = this.redactor.redact(raw.slice(0, base.records));
        if (prefixSha256(prefix.records, base.records) === base.prefix_sha256) {
          const tail = this.redactor.redact(raw.slice(base.records), prefix.withheld);
          const records = [...prefix.records, ...tail.records];
          const normalized = stateOf(records, bytes);
          if (tail.records.length === 0) {
            return this.progress(run, normalized, tail.withheld, "unchanged", guard);
          }
          return this.commit(run, {
            ...common,
            write: [...(meta ? [prefix.records[0] as NormalizedRecord] : []), ...tail.records],
            continuation: { from_record: base.records, prefix_sha256: base.prefix_sha256 },
            normalized,
            withheld: tail.withheld,
            summary: tail.summary,
          });
        }
      }
      if (!options.replace) {
        throw new SessionConflict(
          "the upload does not extend the stored session (its records do not start with what is stored); send it with replace to rewrite the session",
        );
      }
      if (!mayReplace(run.auth, session.writer, session.owner_basis)) {
        throw new Forbidden("only the session's original writer or an admin may replace it");
      }
      const all = this.redactor.redact(raw);
      // A rewrite of a session that passed the filter is not judged again.
      return this.commit(run, {
        ...common,
        write: all.records,
        replace: true,
        normalized: stateOf(all.records, bytes),
        withheld: all.withheld,
        summary: all.summary,
      });
    }

    // The session's first trace.
    const all = this.redactor.redact(raw);
    const records = all.records;
    // A fork's copy of its parent's history is the parent's to ship.
    const copied = await this.forkCopy(run, records);
    const plan = copied ? planShipment(records, copied) : { records, fresh: records };
    if (isFiltered(plan.fresh, filterRulesFor(this.filter, envelope.source_id))) {
      return { status: "filtered", ...NOTHING };
    }
    return this.commit(run, {
      ...common,
      write: plan.records,
      ...(plan.continuation ? { continuation: plan.continuation } : {}),
      normalized: stateOf(records, bytes),
      withheld: all.withheld,
      summary: all.summary,
    });
  }

  /** What a fork copied from the session it was made from, when that parent is stored here. */
  private async forkCopy(run: Run, records: NormalizedRecord[]) {
    const forkOf = run.envelope.fork_of;
    if (!forkOf) return undefined;
    const parent = await getSession(this.store, run.owner, run.envelope.format, forkOf);
    if (!parent?.head) return undefined;
    const trace = await getTrace(this.store, run.owner, parent.archive_id, parent.head);
    return copiedPrefix(records, (trace?.records as NormalizedRecord[] | undefined) ?? null);
  }

  /** Stages 5 and 6: review what the plan adds, then write it, or record the drop. */
  private async commit(run: Run, plan: Plan): Promise<StoreSessionResult> {
    const { envelope, session } = run;
    const lead = metaOf(plan.write) ? 1 : 0;
    const judged = plan.write.slice(lead);
    // The reviewer may send what it judges to a model provider: never the raw payload.
    const { payload: _payload, ...about } = envelope;
    const decision = await this.reviewer.review({
      envelope: about,
      owner: run.owner,
      archive_id: run.archive,
      session,
      meta: lead ? plan.write[0] : undefined,
      records: judged,
    });
    if (decision.action === "drop") {
      await writeDropped(this.store, {
        at: this.now().toISOString(),
        source: envelope.source_id,
        source_kind: envelope.source,
        owner: run.owner,
        session_key: envelope.session_key,
        idempotency_key: envelope.idempotency_key,
        ...(envelope.provenance ? { provenance: envelope.provenance } : {}),
        reason: decision.reason,
        policy: decision.policy,
        policy_hash: decision.policy_hash,
        decision_model: decision.decision_model,
        ...(decision.redactor_model ? { redactor_model: decision.redactor_model } : {}),
        ...(decision.failure ? { failure: decision.failure } : {}),
      });
      // Nothing of a session without a trace is stored, so there is no log position to move.
      if (!session?.head) return { status: "dropped", ...NOTHING };
      // The envelope counts as handled (F3.4): the log moves past it.
      return this.progress(run, plan.normalized, plan.withheld, "dropped", plan.guard);
    }
    let write = plan.write;
    if (decision.action === "redact") {
      if (decision.records.length !== judged.length) {
        throw new Error(
          `the reviewer returned ${decision.records.length} records for ${judged.length}`,
        );
      }
      write = [...plan.write.slice(0, lead), ...decision.records];
    }
    // An LLM call's free text (its error, string parameters) is redacted like the records (F2).
    const calls = redactLlmCalls(this.redactor, callsFor(write, plan.llm_calls));
    const summary = withCounts(plan.summary, calls.counts);

    const result = await ingest({
      store: this.store,
      owner: run.owner,
      records: write,
      metadata: {
        session_id: envelope.session_key,
        agent: envelope.format,
        project: plan.project,
        branch: plan.branch,
        parent_session_id: envelope.parent_session_id,
        ...(plan.continuation ? { continuation: plan.continuation } : {}),
        normalizer: NORMALIZER,
      },
      normalized: plan.normalized,
      withheld_calls: plan.withheld,
      applied: { idempotency_key: envelope.idempotency_key },
      replace: plan.replace,
      guard: plan.guard,
      layout_checked: true,
      client: this.client,
      now: this.now,
      limits: this.limits,
      llm_calls: calls.calls,
      redaction: summary,
      ...this.context(run),
    });
    const note = "note" in decision ? decision.note : undefined;
    if (result.status === "stored" && note) {
      await this.writeNote(run, result.content_hash, decision, note);
    }
    return { ...result, ...shippedOf(plan.normalized) };
  }

  /** No trace to write, but the log moved on and the envelope is remembered. */
  private async progress(
    run: Run,
    normalized: NormalizedState,
    withheld: WithheldCallIds,
    status: "unchanged" | "dropped",
    guard: (existing: SessionMetadata | null) => void,
  ): Promise<StoreSessionResult> {
    await recordProgress({
      store: this.store,
      owner: run.owner,
      archive_id: run.archive,
      normalized,
      withheld_calls: withheld,
      applied: { idempotency_key: run.envelope.idempotency_key, status },
      guard,
      now: this.now,
    });
    return { status, ...shippedOf(normalized) };
  }

  /** Who writes and what the data claims and came from (X5.5). */
  private context(run: Run): WriteContext {
    const { envelope, auth } = run;
    const visibility =
      envelope.visibility ??
      (typeof this.visibility === "function"
        ? this.visibility(envelope.source_id)
        : this.visibility);
    return {
      writer: auth.writer,
      owner_basis: auth.owner_basis,
      visibility,
      ...(envelope.claims ? { claims: envelope.claims } : {}),
      provenance: {
        source: envelope.source,
        source_id: envelope.source_id,
        format: envelope.format,
        ...(envelope.provenance ? { location: envelope.provenance } : {}),
      },
    };
  }

  /** Keep what review decided for a stored write (F3.8), numbered after the session's last. */
  private async writeNote(
    run: Run,
    contentHash: string,
    decision: Exclude<ReviewDecision, { action: "drop" }>,
    note: ReviewNote,
  ): Promise<void> {
    const kind = decision.action === "skipped" ? "skipped" : decision.action;
    let n = (await listReviews(this.store, run.owner, run.archive)).length;
    for (let attempt = 0; attempt < 5; attempt++, n++) {
      try {
        await writeReview(this.store, run.owner, run.archive, {
          n,
          at: this.now().toISOString(),
          content_hash: contentHash,
          decision: kind,
          ...note,
        });
        return;
      } catch (err) {
        // Another write of the session took that number: take the next.
        if (!isPreconditionFailed(err) || attempt === 4) throw err;
      }
    }
  }
}
