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
 * A session whose first envelope model review dropped keeps a stub with no trace, only where
 * its log ends and the prefix hash (F3.4): it is extended exactly as a stored session is, so
 * the dropped records are never stored or judged again. The session remembers that dropped
 * start (`dropped_prefix`) once it has a trace, and a whole write that does not extend what is
 * stored (a rebuild, a replace, an assembled session written again) leaves it out too.
 *
 * Every envelope carries an idempotency key (X4.7); a session remembers the last ones it applied
 * with their answers, so a resend gets the same answer and runs no stage again. A permanent
 * failure is thrown to a caller that is waiting (uploads, hooks) and recorded under
 * `sources/<id>/failed/` for one that is not (pollers, the assembler); a transient one (the
 * store) is always thrown, so it is retried (X4.8). */

import { type FormatRegistry, NormalizeError } from "@seshi/formats";
import {
  type AppliedEnvelope,
  type DroppedPrefix,
  EMPTY_PREFIX_SHA256,
  type Envelope,
  Forbidden,
  IngestRejected,
  type LlmCall,
  type NormalizedRecord,
  type NormalizedState,
  type Normalizer,
  OffsetMismatch,
  PrefixHash,
  prefixSha256,
  type ReceivedSpan,
  type RedactionSummary,
  SessionConflict,
  type SessionMetadata,
  SessionRejected,
  type ShippedState,
  type SpanPart,
  type SpanResource,
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
  type StubInput,
  type WithheldCallIds,
  type WriteContext,
} from "./ingest";
import { DEFAULT_LIMITS, type Limits } from "./limits";
import { redactSpanPart } from "./spans";
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
  retractSecretMatches,
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
  /** The session's retraction secret (F9.7), as the caller sent it with a `replace`. An org-key
   * caller (`claimed`, X5.12) replaces a session only with it (`mayReplace`); never stored. */
  retractSecret?: string;
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

/** The meta record of a stub's first trace (F3.4). The session's own was in the envelope review
 * dropped, and nothing of that is stored or judged again (its working directory, branch or model
 * included), so the trace names only the format it was filed under. The same whether the next
 * envelope is a chunk or the whole log again. */
function stubMeta(envelope: Envelope): NormalizedRecord {
  return { role: "meta", source: envelope.format } as NormalizedRecord;
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

/** Whether a part's ids are OTLP's: lowercase hex, 16 bytes of trace id and 8 of span id. */
function isSpanIds(part: SpanPart): boolean {
  return /^[0-9a-f]{32}$/.test(part.trace_id) && /^[0-9a-f]{16}$/.test(part.span_id);
}

/** How a whole session is written. */
interface WholeOptions {
  replace: boolean;
  /** Build the session again from these records and review them, even when they only extend
   * what is stored (X4.9): a replace, with its permission. */
  rebuild?: boolean;
  /** The retraction secret sent with a `replace` (`SubmitOptions.retractSecret`). */
  retract_secret?: string;
  /** Redacted, and counted, by `commit` (F2). */
  llm_calls?: readonly LlmCall[];
  /** For an assembled session: what redaction found in its spans when they arrived, summed over
   * all of them. A write of the whole session counts all of it; a tail counts what the
   * session's stored counts do not have yet. */
  arrived?: RedactionSummary;
  /** For an uploaded log: how many records its first `bytes` bytes normalize to now, cut at the
   * line boundary at or past them (`bytes`, the cut). Finds where a session's dropped start ends
   * when its records no longer hash to it (F3.4). Undefined when the log cannot be cut (a
   * document) or what the cut leaves cannot be read. */
  recordsIn?: (bytes: number) => { records: number; bytes: number } | undefined;
}

/** `total` less what `stored` already counts (by rule, never below zero); everything when the
 * rule set changed, since the stored counts are another rule set's. */
function countsNotIn(
  total: RedactionSummary,
  stored: RedactionSummary | undefined,
): Record<string, number> {
  if (!stored || stored.rule_set !== total.rule_set) return { ...total.counts };
  const out: Record<string, number> = {};
  for (const [rule, n] of Object.entries(total.counts)) {
    const left = n - (stored.counts[rule] ?? 0);
    if (left > 0) out[rule] = left;
  }
  return out;
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
  /** What the session's metadata records as its normalizer, when it is not this write's: a
   * chunk added to a session an older normalizer built leaves it stale (X4.9). */
  sessionNormalizer?: Normalizer;
  /** The session's dropped start as this write leaves it out (F3.4); the stored one otherwise. */
  dropped_prefix?: DroppedPrefix;
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
      const { result, replay } = await this.log(envelope, auth, options.retractSecret);
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
      // LLM calls carry free text (an error message, string parameters): `commit` redacts what
      // the written records refer to with the rule set and counts it, as for any write (F2).
      const outcome = await this.planned(envelope, auth, (run) =>
        this.whole(run, input.records, 0, {
          replace: true,
          ...(input.llm_calls ? { llm_calls: input.llm_calls } : {}),
          ...(input.redaction ? { arrived: input.redaction } : {}),
        }),
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
    const adapter = this.formats.get(envelope.format)?.spans;
    if (!adapter) {
      throw new SessionRejected(
        "unsupported_payload",
        `format ${envelope.format} takes logs, not span batches`,
      );
    }
    const { spans, resource = [] } = envelope.payload;
    // Normalize and regex-redact each span on arrival (X6.3): the span store keeps only what
    // redaction left, never the span as received. A span the format cannot read is left out.
    const parts: { part: SpanPart; redaction: RedactionSummary }[] = [];
    let rejected = 0;
    for (const span of spans as unknown as ReceivedSpan[]) {
      let part: SpanPart;
      try {
        part = adapter.normalize(span, resource as unknown as SpanResource);
      } catch {
        rejected++;
        continue;
      }
      // The ids name the span's record in the bucket: a connector's span with ids that are not
      // OTLP's hex is the sender's fault, not the store's, so it is left out like any span the
      // format cannot read (a bad key would otherwise fail the batch as a store error, which a
      // poller retries forever).
      if (!isSpanIds(part)) {
        rejected++;
        continue;
      }
      const redacted = redactSpanPart(this.redactor, part);
      parts.push({ part: redacted.part, redaction: redacted.summary });
    }
    if (parts.length === 0) {
      throw new SessionRejected(
        spans.length === 0 ? "empty" : "bad_spans",
        spans.length === 0 ? "the batch has no spans" : "no span in the batch could be read",
      );
    }
    const archive_id = archiveId(auth.owner, envelope.format, envelope.session_key);
    const { payload: _payload, ...about } = envelope;
    return this.assembler.accept({
      envelope: about,
      authorization: auth,
      archive_id,
      parts,
      ...(rejected > 0 ? { rejected } : {}),
    });
  }

  private unsupported(format: string): never {
    throw new SessionRejected(
      "unsupported_agent",
      `no normalizer for '${format}' (one of ${this.formats.sources.join(", ")})`,
    );
  }

  // --- logs ---------------------------------------------------------------------

  private async log(
    envelope: LogEnvelope,
    auth: Authorization,
    retractSecret?: string,
  ): Promise<Outcome> {
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
      if (envelope.rebuild === true) {
        throw new SessionRejected("bad_chunk", "a rebuild sends the whole log, at offset 0");
      }
      return this.planned(envelope, auth, (run) => this.chunk(run, payload.text, payload.offset));
    }
    if (payload.text.trim() === "") throw new SessionRejected("empty", "transcript is empty");
    // The whole log's records do not depend on what is stored: normalize once.
    const { records, llm_calls } = this.normalize(
      envelope.format,
      payload.text,
      envelope.session_key,
    );
    return this.planned(envelope, auth, (run) =>
      this.whole(run, records, utf8Length(payload.text), {
        replace: envelope.replace === true,
        ...(envelope.rebuild === true ? { rebuild: true } : {}),
        ...(retractSecret !== undefined ? { retract_secret: retractSecret } : {}),
        ...(llm_calls ? { llm_calls } : {}),
        recordsIn: (bytes) => this.recordsIn(envelope, bytes),
      }),
    );
  }

  /** How many records a whole log's first `bytes` bytes normalize to with the current adapter,
   * cut at the first line boundary at or past them (a cut that falls inside a line takes all of
   * it, so more is left out rather than less); undefined for a log that cannot be cut there (a
   * document) or whose start cannot be read. */
  private recordsIn(
    envelope: LogEnvelope,
    bytes: number,
  ): { records: number; bytes: number } | undefined {
    const { payload } = envelope;
    const cuttable = payload.encoding === "jsonl" && this.formats.isChunkable(envelope.format);
    if (!cuttable) return undefined;
    const encoded = new TextEncoder().encode(payload.text);
    let cut = Math.min(bytes, encoded.length);
    while (cut < encoded.length && encoded[cut - 1] !== 0x0a) cut++;
    const text = new TextDecoder().decode(encoded.subarray(0, cut));
    if (text.trim() === "") return { records: 0, bytes: cut };
    try {
      const { records } = this.normalize(envelope.format, text, envelope.session_key);
      return { records: records.length, bytes: cut };
    } catch (err) {
      if (err instanceof SessionRejected) return undefined;
      throw err;
    }
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

  /** Stage 2 for a log: the adapter's records, unredacted, and the LLM calls they name (redacted
   * by `commit`). A log the adapter reads but finds no conversation in has none. */
  private normalize(
    format: string,
    text: string,
    sessionId: string,
    offset = 0,
  ): { records: NormalizedRecord[]; llm_calls?: LlmCall[] } {
    try {
      const outcome = this.formats.normalize({
        source: format,
        transcript: text,
        ...(offset > 0 ? { chunk: { offset, session_id: sessionId } } : {}),
      });
      return outcome.empty || !outcome.llm_calls
        ? { records: outcome.records }
        : { records: outcome.records, llm_calls: outcome.llm_calls };
    } catch (err) {
      if (err instanceof NormalizeError) {
        throw new SessionRejected(`normalize_${err.code}`, err.message);
      }
      throw err;
    }
  }

  /** A chunk: the bytes of the log from where the session's log ends, normalized on its own and
   * written as a continuation of the head, or of a stub's dropped envelopes (F3.4). Never
   * filtered: the session's first envelope was. */
  private async chunk(run: Run, text: string, offset: number): Promise<StoreSessionResult> {
    const { session, envelope } = run;
    if (!session?.normalized) {
      // Nothing is stored for a session without a trace or a stub (X6.3): send the whole log.
      throw new OffsetMismatch(offset, 0);
    }
    const state = session.normalized;
    if (offset !== state.bytes) throw new OffsetMismatch(offset, state.bytes);
    const guard = (existing: SessionMetadata | null) => {
      const at = existing?.normalized?.bytes ?? 0;
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
    const { records: raw, llm_calls } = this.normalize(
      envelope.format,
      text,
      envelope.session_key,
      offset,
    );
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
    // The session's meta record is the head's: a chunk has none of its own. A stub has no head,
    // and its meta record was in what review dropped: the stub's own stands in.
    const meta = session.head ? await this.headMeta(run, session.head) : stubMeta(envelope);
    // The tail is this normalizer's, the prefix still whatever built it: a session an older one
    // built stays stale until it is rebuilt whole (X4.9). A stub has no stored prefix (review
    // dropped it), so its first trace is all this normalizer's: it takes the current version, or
    // it would count as stale forever and be resent whole at every format bump.
    const current = this.formats.normalizerFor(envelope.format);
    const builtWith = session.normalizer?.format_version;
    const sessionNormalizer: Normalizer =
      session.head !== undefined && this.formats.isStale(envelope.format, builtWith)
        ? {
            name: current.name,
            version: current.version,
            ...(builtWith ? { format_version: builtWith } : {}),
          }
        : current;
    return this.commit(run, {
      sessionNormalizer,
      write: [...(meta ? [meta] : []), ...redacted.records],
      continuation: { from_record: state.records, prefix_sha256: state.prefix_sha256 },
      normalized,
      withheld: redacted.withheld,
      summary: redacted.summary,
      ...(llm_calls ? { llm_calls } : {}),
      project: envelope.project ?? session.project,
      branch: envelope.branch ?? session.branch,
      guard,
    });
  }

  /** The meta record of the session's head trace, which a chunk's continuation repeats. */
  private async headMeta(run: Run, head: string): Promise<NormalizedRecord | undefined> {
    const trace = await getTrace(this.store, run.owner, run.archive, head);
    // Gone because the session moved since it was read (a backfill or a replace removed it):
    // plan again on the session as it is now, rather than write a continuation with no meta.
    if (trace === null) {
      const now = await readMetadata(this.store, run.owner, run.archive);
      if (now?.head !== head) throw new StalePlan();
      return undefined;
    }
    return metaOf(trace.records as NormalizedRecord[]);
  }

  /** A whole session (a whole log, or what the assembler rebuilt): the first trace, judged by
   * the session filter; a tail that extends the stored session or a stub, never judged; or,
   * with `replace`, a rewrite of the session by its original writer or an admin (X4.6). */
  private async whole(
    run: Run,
    raw: readonly NormalizedRecord[],
    bytes: number,
    options: WholeOptions,
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

    // A stub (F3.4): model review dropped the session's first envelopes. The log it holds is
    // handled like a stored prefix: a log that extends it ships only its tail, reviewed alone,
    // and the dropped records are neither judged nor written again.
    const stub = session !== null && session.head === undefined && session.normalized !== undefined;
    if (session && (session.head || stub)) {
      // What is stored: the server's own state, or for a session without it what the uploader
      // says shipped.
      const base =
        session.normalized ??
        (envelope.shipped
          ? { records: envelope.shipped.records, prefix_sha256: envelope.shipped.prefix_sha256 }
          : undefined);
      // A rebuild writes the whole session again even when it extends what is stored, so what
      // review skipped or dropped, or an older normalizer built, is built and reviewed anew.
      if (!options.rebuild && base && base.records > 0 && base.records <= raw.length) {
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
          // A stub's tail is its first trace, with the stub's meta record: the log's own is in
          // what review dropped, as is the branch it records.
          const lead = stub
            ? [stubMeta(envelope)]
            : meta
              ? [prefix.records[0] as NormalizedRecord]
              : [];
          return this.commit(run, {
            ...common,
            ...(stub ? { branch: envelope.branch } : {}),
            write: [...lead, ...tail.records],
            continuation: { from_record: base.records, prefix_sha256: base.prefix_sha256 },
            normalized,
            withheld: tail.withheld,
            summary: this.summaryOf(tail.summary, options, session, false),
          });
        }
      }
      if (!options.replace && !options.rebuild) {
        throw new SessionConflict(
          "the upload does not extend the stored session (its records do not start with what is stored); send it with replace to rewrite the session",
        );
      }
      const proven = retractSecretMatches(options.retract_secret, session.retract_hash);
      if (!mayReplace(run.auth, session.writer, session.owner_basis, proven)) {
        throw new Forbidden(
          run.auth.owner_basis === "claimed" &&
            (session.owner_basis ?? "claimed") === "claimed" &&
            !proven
            ? "with the org key, only the machine that uploaded a session may replace it: send its retraction secret (X-Seshi-Retract), or use an admin token"
            : `only the session's original writer or an admin may ${options.rebuild ? "rebuild" : "replace"} it`,
        );
      }
      // A session whose first envelopes review dropped: the rewrite leaves the dropped start out.
      const dropped = session.dropped_prefix ?? (stub ? session.normalized : undefined);
      if (dropped && (dropped.records > 0 || dropped.bytes > 0)) {
        const past = this.pastDropped(run, raw, bytes, dropped, options, common);
        if (past) return past;
      }
      const all = this.redactor.redact(raw);
      // A rewrite of a session that passed the filter is not judged again.
      return this.commit(run, {
        ...common,
        write: all.records,
        replace: true,
        normalized: stateOf(all.records, bytes),
        withheld: all.withheld,
        summary: this.summaryOf(all.summary, options, session, true),
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
      summary: this.summaryOf(all.summary, options, session, true),
    });
  }

  /** A whole write that does not extend what is stored (a rebuild, a replace, an assembled
   * session written again) of a session whose first envelopes model review dropped (F3.4): the
   * dropped start is left out, and only what follows it is reviewed and written, as the
   * continuation of the dropped records a stub's first trace is. Where the dropped start ends:
   * - its records, when they still hash to what was dropped (as regex redaction leaves them);
   * - else, for an uploaded log, what the current adapter makes of its first `bytes` bytes (the
   *   rules or the adapter changed since);
   * - else (an assembled session, or a document) the count that was dropped: a span that
   *   arrived late inside the dropped part leaves the last dropped record in what follows.
   * Undefined when nothing is left out (the dropped start held no records), so the session is
   * rewritten whole. A write of nothing past the dropped start answers `unchanged`. */
  private pastDropped(
    run: Run,
    raw: readonly NormalizedRecord[],
    bytes: number,
    dropped: DroppedPrefix,
    options: WholeOptions,
    common: {
      llm_calls: readonly LlmCall[] | undefined;
      project: string | undefined;
      guard: (existing: SessionMetadata | null) => void;
    },
  ): Promise<StoreSessionResult> | undefined {
    const { session, envelope } = run;
    let skip = Math.min(dropped.records, raw.length);
    let cut = dropped.bytes;
    const same =
      dropped.records > 0 &&
      dropped.records <= raw.length &&
      prefixSha256(this.redactor.redact(raw.slice(0, dropped.records)).records, dropped.records) ===
        dropped.prefix_sha256;
    if (!same && dropped.bytes > 0) {
      const now = options.recordsIn?.(dropped.bytes);
      if (now) {
        skip = Math.min(now.records, raw.length);
        cut = now.bytes;
      }
    }
    if (skip === 0) return undefined;
    // The dropped start and what follows as two passes of one, as for a tail that extends what is
    // stored: what follows carries the dropped part's withheld calls, and only its matches count.
    const prefix = this.redactor.redact(raw.slice(0, skip));
    const tail = this.redactor.redact(raw.slice(skip), prefix.withheld);
    const normalized = stateOf([...prefix.records, ...tail.records], bytes);
    const prefixHash = prefixSha256(prefix.records, skip);
    if (tail.records.length === 0) {
      return this.progress(run, normalized, tail.withheld, "unchanged", common.guard);
    }
    return this.commit(run, {
      ...common,
      // The log's meta record and the branch it names are in the dropped start.
      branch: envelope.branch,
      write: [stubMeta(envelope), ...tail.records],
      continuation: { from_record: skip, prefix_sha256: prefixHash },
      // A stub has no trace to replace: its first trace extends it, and a drop moves it on.
      ...(session?.head !== undefined ? { replace: true } : {}),
      normalized,
      withheld: tail.withheld,
      summary: this.summaryOf(tail.summary, options, session, true),
      dropped_prefix: { bytes: cut, records: skip, prefix_sha256: prefixHash },
    });
  }

  /** A write's redaction summary: the records' pass, plus for an assembled session what its
   * spans' arrival found (`arrived`; see `WholeOptions`). The LLM calls' matches are added by
   * `commit`. */
  private summaryOf(
    pass: RedactionSummary,
    options: WholeOptions,
    session: SessionMetadata | null,
    whole: boolean,
  ): RedactionSummary {
    if (!options.arrived) return pass;
    const counts: Record<string, number> = { ...pass.counts };
    const add = (more: Readonly<Record<string, number>>) => {
      for (const [rule, n] of Object.entries(more))
        if (n > 0) counts[rule] = (counts[rule] ?? 0) + n;
    };
    add(whole ? options.arrived.counts : countsNotIn(options.arrived, session?.redaction));
    return { rule_set: pass.rule_set, counts };
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
      // A dropped replace leaves the session as stored: its log state stays the stored
      // history's, never the dropped one's, or a later upload extending the dropped history
      // would be written as a continuation of the stored one (two histories spliced). The next
      // upload of that history does not extend what is stored, so it must replace again and is
      // reviewed again. The answer says what is stored.
      if (plan.replace) {
        if (!session?.normalized) return { status: "dropped", ...NOTHING };
        return this.progress(
          run,
          session.normalized,
          session.withheld_calls ?? {},
          "dropped",
          plan.guard,
        );
      }
      // The envelope counts as handled (F3.4): the log moves past it, whether or not the session
      // has a trace. A session with none (its first envelope, or every one so far, dropped)
      // keeps a stub that says where its log ends and nothing of what was dropped (F3.4 over
      // F3.1, revised 15 Nov 2026), so the next envelope continues from there.
      return this.progress(run, plan.normalized, plan.withheld, "dropped", plan.guard, {
        session_id: envelope.session_key,
        agent: envelope.format,
        ...this.who(run),
        ...(envelope.retract_hash ? { retract_hash: envelope.retract_hash } : {}),
      });
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
        normalizer: this.formats.normalizerFor(envelope.format),
      },
      ...(plan.sessionNormalizer ? { session_normalizer: plan.sessionNormalizer } : {}),
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
      ...(envelope.retract_hash ? { retract_hash: envelope.retract_hash } : {}),
      ...(plan.dropped_prefix ? { dropped_prefix: plan.dropped_prefix } : {}),
      ...this.context(run),
    });
    const note = "note" in decision ? decision.note : undefined;
    if (result.status === "stored" && note) {
      await this.writeNote(run, result.content_hash, decision, note);
    }
    return { ...result, ...shippedOf(plan.normalized) };
  }

  /** No trace to write, but the log moved on and the envelope is remembered; with `stub`, a
   * session with no pointer gets a stub (`recordProgress`). */
  private async progress(
    run: Run,
    normalized: NormalizedState,
    withheld: WithheldCallIds,
    status: "unchanged" | "dropped",
    guard: (existing: SessionMetadata | null) => void,
    stub?: StubInput,
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
      ...(stub ? { stub } : {}),
    });
    return { status, ...shippedOf(normalized) };
  }

  /** Who writes, how the owner was established and who may read a new session (X5.5, X5.10). */
  private who(run: Run): Pick<WriteContext, "writer" | "owner_basis" | "visibility"> {
    const { envelope, auth } = run;
    const visibility =
      envelope.visibility ??
      (typeof this.visibility === "function"
        ? this.visibility(envelope.source_id)
        : this.visibility);
    return { writer: auth.writer, owner_basis: auth.owner_basis, visibility };
  }

  /** Who writes and what the data claims and came from (X5.5). */
  private context(run: Run): WriteContext {
    const { envelope } = run;
    return {
      ...this.who(run),
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
