import { type FormatRegistry, NormalizeError } from "@seshi/formats";
import {
  type AppliedEnvelope,
  type DroppedPrefix,
  EMPTY_PREFIX_SHA256,
  type Envelope,
  Forbidden,
  IngestRejected,
  isStub,
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
  type RecordRedaction,
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
  mayAddToSession,
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
  formats: FormatRegistry;
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

export type VisibilitySetting = Visibility | ((sourceId: string) => Visibility);

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

const NOTHING: ShippedState = {
  records_total: 0,
  prefix_sha256: EMPTY_PREFIX_SHA256,
  bytes_total: 0,
};

const PLAN_ATTEMPTS = 3;

class StalePlan extends Error {
  constructor() {
    super("the session changed while this envelope was written");
    this.name = "StalePlan";
  }
}

function rewrittenByBackfill(existing: SessionMetadata | null, planned: SessionMetadata): boolean {
  return (
    existing?.head !== planned.head || existing?.redaction?.rule_set !== planned.redaction?.rule_set
  );
}

function isPermanent(err: unknown): err is { code: string; message: string } {
  return (
    err instanceof SessionRejected ||
    err instanceof OffsetMismatch ||
    err instanceof SessionConflict ||
    err instanceof Forbidden
  );
}

function isProtocolAnswer(err: unknown): boolean {
  return err instanceof OffsetMismatch;
}

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

function stubMeta(envelope: Envelope): NormalizedRecord {
  return { role: "meta", source: envelope.format } as NormalizedRecord;
}

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
function hasBucketSafeSpanIds(part: SpanPart): boolean {
  return /^[0-9a-f]{32}$/.test(part.trace_id) && /^[0-9a-f]{16}$/.test(part.span_id);
}

interface LogCut {
  records: number;
  bytes: number;
}

interface KeptPart {
  from: number;
  before: RecordRedaction;
  kept: RecordRedaction;
  normalized: NormalizedState;
}

function keptPartFrom(
  redactor: Redactor,
  raw: readonly NormalizedRecord[],
  from: number,
  bytes: number,
  before: RecordRedaction = redactor.redact(raw.slice(0, from)),
): KeptPart {
  const kept = redactor.redact(raw.slice(from), before.withheld);
  return { from, before, kept, normalized: stateOf([...before.records, ...kept.records], bytes) };
}

interface DroppedStartEnd extends LogCut {
  before?: RecordRedaction;
}

function droppedStartEnd(
  redactor: Redactor,
  raw: readonly NormalizedRecord[],
  dropped: DroppedPrefix,
  recordsBeforeCut: WholeOptions["recordsBeforeCut"],
): DroppedStartEnd {
  if (dropped.records > 0 && dropped.records <= raw.length) {
    const before = redactor.redact(raw.slice(0, dropped.records));
    if (prefixSha256(before.records, dropped.records) === dropped.prefix_sha256) {
      return { records: dropped.records, bytes: dropped.bytes, before };
    }
  }
  const cut = dropped.bytes > 0 ? recordsBeforeCut?.(dropped.bytes) : undefined;
  if (cut) return { records: Math.min(cut.records, raw.length), bytes: cut.bytes };
  return { records: Math.min(dropped.records, raw.length), bytes: dropped.bytes };
}

function droppedStartOf(session: SessionMetadata, stub: boolean): DroppedPrefix | undefined {
  return session.dropped_prefix ?? (stub ? session.normalized : undefined);
}

interface WholeOptions {
  replace: boolean;
  rebuild?: boolean;
  retract_secret?: string;
  llm_calls?: readonly LlmCall[];
  arrived?: RedactionSummary;
  recordsBeforeCut?: (bytes: number) => LogCut | undefined;
}

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

interface Run {
  envelope: Envelope;
  auth: Authorization;
  owner: string;
  archive: string;
  session: SessionMetadata | null;
}

interface Plan {
  write: NormalizedRecord[];
  continuation?: { from_record: number; prefix_sha256: string };
  replace?: boolean;
  normalized: NormalizedState;
  withheld: WithheldCallIds;
  summary: RedactionSummary;
  llm_calls?: readonly LlmCall[];
  project?: string;
  branch?: string;
  guard: (existing: SessionMetadata | null) => void;
  sessionNormalizer?: Normalizer;
  dropped_prefix?: DroppedPrefix;
}

interface Outcome {
  result: StoreSessionResult;
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

  private layout(): Promise<unknown> {
    this.layoutChecked ??= ensureLayout(this.store, { createdBy: this.client }).catch((err) => {
      this.layoutChecked = undefined;
      throw err;
    });
    return this.layoutChecked;
  }

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

  private async failed(
    envelope: Envelope,
    err: unknown,
    options: SubmitOptions,
  ): Promise<FailedResult> {
    if (!isPermanent(err)) throw err;
    const respond = options.onFailure ?? (hasCaller(envelope) ? "throw" : "record");
    if (!isProtocolAnswer(err)) {
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
      if (!hasBucketSafeSpanIds(part)) {
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
        recordsBeforeCut: (bytes) => this.recordsBeforeCut(envelope, bytes),
      }),
    );
  }

  private recordsBeforeCut(envelope: LogEnvelope, bytes: number): LogCut | undefined {
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
      if (session && !mayAddToSession(auth, session.owner_basis)) {
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

  private async chunk(run: Run, text: string, offset: number): Promise<StoreSessionResult> {
    const { session, envelope } = run;
    if (!session?.normalized) {
      throw new OffsetMismatch(offset, 0);
    }
    const state = session.normalized;
    if (offset !== state.bytes) throw new OffsetMismatch(offset, state.bytes);
    const guard = (existing: SessionMetadata | null) => {
      const at = existing?.normalized?.bytes ?? 0;
      if (at !== offset) throw new OffsetMismatch(offset, at);
      if (rewrittenByBackfill(existing, session)) throw new StalePlan();
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
    const meta = session.head ? await this.headMeta(run, session.head) : stubMeta(envelope);
    const sessionNormalizer = this.chunkSessionNormalizer(session, envelope.format);
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

  private chunkSessionNormalizer(session: SessionMetadata, format: string): Normalizer {
    const current = this.formats.normalizerFor(format);
    const builtWith = session.normalizer?.format_version;
    const prefixStaysStale = session.head !== undefined && this.formats.isStale(format, builtWith);
    return prefixStaysStale
      ? {
          name: current.name,
          version: current.version,
          ...(builtWith ? { format_version: builtWith } : {}),
        }
      : current;
  }

  private async headMeta(run: Run, head: string): Promise<NormalizedRecord | undefined> {
    const trace = await getTrace(this.store, run.owner, run.archive, head);
    if (trace === null) {
      const now = await readMetadata(this.store, run.owner, run.archive);
      if (now?.head !== head) throw new StalePlan();
      return undefined;
    }
    return metaOf(trace.records as NormalizedRecord[]);
  }

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

    const stub = session !== null && isStub(session) && session.normalized !== undefined;
    if (session && (session.head || stub)) {
      const base =
        session.normalized ??
        (envelope.shipped
          ? { records: envelope.shipped.records, prefix_sha256: envelope.shipped.prefix_sha256 }
          : undefined);
      if (!options.rebuild && base && base.records > 0 && base.records <= raw.length) {
        const before = this.redactor.redact(raw.slice(0, base.records));
        if (prefixSha256(before.records, base.records) === base.prefix_sha256) {
          const { kept, normalized } = keptPartFrom(
            this.redactor,
            raw,
            base.records,
            bytes,
            before,
          );
          if (kept.records.length === 0) {
            return this.progress(run, normalized, kept.withheld, "unchanged", guard);
          }
          const lead = stub
            ? [stubMeta(envelope)]
            : meta
              ? [before.records[0] as NormalizedRecord]
              : [];
          return this.commit(run, {
            ...common,
            ...(stub ? { branch: envelope.branch } : {}),
            write: [...lead, ...kept.records],
            continuation: { from_record: base.records, prefix_sha256: base.prefix_sha256 },
            normalized,
            withheld: kept.withheld,
            summary: this.summaryOf(kept.summary, options, session, false),
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
      const dropped = droppedStartOf(session, stub);
      if (dropped && (dropped.records > 0 || dropped.bytes > 0)) {
        const past = this.pastDropped(run, raw, bytes, dropped, options, common);
        if (past) return past;
      }
      const all = this.redactor.redact(raw);
      return this.commit(run, {
        ...common,
        write: all.records,
        replace: true,
        normalized: stateOf(all.records, bytes),
        withheld: all.withheld,
        summary: this.summaryOf(all.summary, options, session, true),
      });
    }

    const all = this.redactor.redact(raw);
    const records = all.records;
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
    const end = droppedStartEnd(this.redactor, raw, dropped, options.recordsBeforeCut);
    if (end.records === 0) return undefined;
    const { from, before, kept, normalized } = keptPartFrom(
      this.redactor,
      raw,
      end.records,
      bytes,
      end.before,
    );
    const prefixHash = prefixSha256(before.records, from);
    if (kept.records.length === 0 && session?.head !== undefined) {
      return Promise.resolve({
        status: "dropped",
        ...shippedOf(session.normalized as NormalizedState),
      });
    }
    if (kept.records.length === 0) {
      return this.progress(run, normalized, kept.withheld, "unchanged", common.guard);
    }
    return this.commit(run, {
      ...common,
      branch: envelope.branch,
      write: [stubMeta(envelope), ...kept.records],
      continuation: { from_record: from, prefix_sha256: prefixHash },
      ...(session?.head !== undefined ? { replace: true } : {}),
      normalized,
      withheld: kept.withheld,
      summary: this.summaryOf(kept.summary, options, session, true),
      dropped_prefix: { bytes: end.bytes, records: from, prefix_sha256: prefixHash },
    });
  }

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

  private async forkCopy(run: Run, records: NormalizedRecord[]) {
    const forkOf = run.envelope.fork_of;
    if (!forkOf) return undefined;
    const parent = await getSession(this.store, run.owner, run.envelope.format, forkOf);
    if (!parent?.head) return undefined;
    const trace = await getTrace(this.store, run.owner, parent.archive_id, parent.head);
    return copiedPrefix(records, (trace?.records as NormalizedRecord[] | undefined) ?? null);
  }

  private async commit(run: Run, plan: Plan): Promise<StoreSessionResult> {
    const { envelope, session } = run;
    const lead = metaOf(plan.write) ? 1 : 0;
    const judged = plan.write.slice(lead);
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

  private async progress(
    run: Run,
    normalized: NormalizedState,
    withheld: WithheldCallIds,
    status: "unchanged" | "dropped",
    guard: (existing: SessionMetadata | null) => void,
    createStubIfMissing?: StubInput,
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
      ...(createStubIfMissing ? { createStubIfMissing } : {}),
    });
    return { status, ...shippedOf(normalized) };
  }

  private who(run: Run): Pick<WriteContext, "writer" | "owner_basis" | "visibility"> {
    const { envelope, auth } = run;
    const visibility =
      envelope.visibility ??
      (typeof this.visibility === "function"
        ? this.visibility(envelope.source_id)
        : this.visibility);
    return { writer: auth.writer, owner_basis: auth.owner_basis, visibility };
  }

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
        if (!isPreconditionFailed(err) || attempt === 4) throw err;
      }
    }
  }
}
