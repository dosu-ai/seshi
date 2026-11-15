/** The seams the pipeline's stages plug into. Each is an interface the pipeline is given, with a
 * default that does the least: the branch that owns a stage supplies the real one.
 *
 * - `Authorizer` (stage 1, X4.3): checks the caller and resolves the owner. 05 (auth) supplies
 *   scopes and roles; the default trusts what the envelope says, which the HTTP route already
 *   resolved from a static or legacy token.
 * - `Reviewer` (stage 5, F3): labels what an envelope adds `allow`, `redact` or `drop`. 08
 *   supplies the decision model and the redactor; the default allows everything.
 * - `HealthCounters`: counts how each envelope ended, per source (X4.8, X4.10).
 * - `SpanAssembler` (X4.2): takes span batches. 09 builds it and the span store. */

import type {
  Envelope,
  LlmCall,
  NormalizedRecord,
  OwnerBasis,
  SessionMetadata,
  Writer,
} from "@seshi/model";
import {
  addHealth,
  type HealthCounts,
  type HealthOutcome,
  healthDay,
  type ReviewFinding,
  type Store,
} from "@seshi/store";
import type { SpanEnvelope } from "./envelope";
import { writerOf } from "./envelope";

// --- authorize ----------------------------------------------------------------

/** Who may write an envelope's session, as the authorizer resolved it. */
export interface Authorization {
  /** Whose session it is (X5.4, X5.8). */
  owner: string;
  owner_basis: OwnerBasis;
  /** Who writes (X5.5): recorded on the change entry, and as the session's original writer
   * when it is new. */
  writer: Writer;
  /** An admin may replace any session (X4.6, X5.3). */
  admin: boolean;
}

export interface Authorizer {
  /** Check that the envelope's caller may write it and resolve whose session it is. Throws
   * `Forbidden` (permanent) when it may not, `StoreError` when it cannot tell (transient). */
  authorize(envelope: Envelope): Authorization | Promise<Authorization>;
}

/** Trust the envelope: its owner and basis as given, its caller as the writer, admin when the
 * caller is. Right for routes that resolved the caller themselves (a static token binds its
 * owner); 05 replaces it with scopes and roles. */
export function permissiveAuthorizer(): Authorizer {
  return {
    authorize: (envelope) => ({
      owner: envelope.owner,
      owner_basis: envelope.owner_basis,
      writer: writerOf(envelope),
      admin: envelope.caller.kind === "admin",
    }),
  };
}

/** Whether `auth` may replace a session first written by `original` (X4.6): its original writer
 * (the same person or service account, through the same source) or an admin. */
export function mayReplace(auth: Authorization, original: Writer): boolean {
  return (
    auth.admin ||
    (auth.writer.principal === original.principal && auth.writer.source_id === original.source_id)
  );
}

// --- model review ---------------------------------------------------------------

/** What a review decided, as kept beside the session (`review/<n>.json`, F3.8): never the
 * matched text. */
export interface ReviewNote {
  policy: string;
  policy_hash: string;
  decision_model: string;
  redactor_model?: string;
  findings: ReviewFinding[];
}

export interface ReviewInput {
  envelope: Envelope;
  owner: string;
  archive_id: string;
  /** The session as stored before this write; null for a new one. */
  session: SessionMetadata | null;
  /** The session's meta record (the head's, for a chunk), for context; not judged. */
  meta: NormalizedRecord | undefined;
  /** What the envelope adds to the session, after regex redaction and the session filter: the
   * records to judge (F3.6: this envelope's only). */
  records: readonly NormalizedRecord[];
}

export type ReviewDecision =
  /** Write as regex redaction left it. */
  | { action: "allow"; note?: ReviewNote }
  /** Write `records` instead: the reviewed records with the findings applied, one for one. */
  | { action: "redact"; records: NormalizedRecord[]; note?: ReviewNote }
  /** Review failed and the policy says `on_failure = "skip"` (F3.4): write with regex
   * redaction only. */
  | { action: "skipped"; note?: ReviewNote }
  /** Write nothing; a drop record says why (X6.4). */
  | {
      action: "drop";
      reason: "review_drop" | "review_failed";
      policy: string;
      policy_hash: string;
      decision_model: string;
    };

export interface Reviewer {
  /** Judge one envelope. Retries and `on_failure` are the reviewer's (F3.4); a throw is treated
   * as transient, so nothing is written and the caller retries. */
  review(input: ReviewInput): Promise<ReviewDecision>;
}

/** No review policy applies: everything is allowed, and nothing is recorded. */
export function noReview(): Reviewer {
  return { review: async () => ({ action: "allow" }) };
}

// --- source health --------------------------------------------------------------

export interface HealthCounters {
  /** Count one envelope from `sourceId` that ended as `outcome`. Never throws and never waits:
   * counting cannot fail an upload. */
  count(sourceId: string, outcome: HealthOutcome): void;
  /** Wait until what was counted is written. */
  flush(): Promise<void>;
}

/** Counts nothing. */
export function noHealth(): HealthCounters {
  return { count: () => {}, flush: async () => {} };
}

/** Counts in memory, for tests and for a status line in one process. */
export class MemoryHealthCounters implements HealthCounters {
  readonly counts: Record<string, HealthCounts> = {};

  count(sourceId: string, outcome: HealthOutcome): void {
    const source = this.counts[sourceId] ?? {};
    source[outcome] = (source[outcome] ?? 0) + 1;
    this.counts[sourceId] = source;
  }

  async flush(): Promise<void> {}
}

/** Counts into the store's health shards (`addHealth`): this process's own shard per source
 * and day, so instances never contend. Counts made while a write is in flight are coalesced
 * into the next one; a failed write is reported to `onError` and its counts are lost, since
 * counters are a health signal, not an audit. */
export class StoreHealthCounters implements HealthCounters {
  private pending = new Map<string, { source: string; day: string; counts: HealthCounts }>();
  private writing: Promise<void> | undefined;
  private readonly instance: string;
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly store: Store,
    options: { instance: string; now?: () => Date; onError?: (err: unknown) => void },
  ) {
    this.instance = options.instance;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
  }

  count(sourceId: string, outcome: HealthOutcome): void {
    const day = healthDay(this.now());
    const id = `${sourceId}\n${day}`;
    const entry = this.pending.get(id) ?? { source: sourceId, day, counts: {} };
    entry.counts[outcome] = (entry.counts[outcome] ?? 0) + 1;
    this.pending.set(id, entry);
    this.kick();
  }

  async flush(): Promise<void> {
    while (this.writing !== undefined || this.pending.size > 0) {
      this.kick();
      await this.writing;
    }
  }

  private kick(): void {
    if (this.writing !== undefined) return;
    this.writing = this.drain().finally(() => {
      this.writing = undefined;
      if (this.pending.size > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = [...this.pending.values()];
      this.pending = new Map();
      for (const { source, day, counts } of batch) {
        try {
          await addHealth(this.store, {
            source,
            day,
            instance: this.instance,
            counts,
            at: this.now().toISOString(),
          });
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }
}

// --- span sets ------------------------------------------------------------------

/** One batch of spans for the assembler, authorized. */
export interface SpanBatch {
  envelope: SpanEnvelope;
  authorization: Authorization;
  /** The session the spans belong to. */
  archive_id: string;
}

/** The answer to a span batch: it is in the span store (X4.4); the session is assembled and
 * published later. */
export interface SpanBatchResult {
  status: "accepted";
  archive_id: string;
  spans: number;
}

/** The span assembler (X4.2, F4.4, branch 09). `accept` normalizes and regex-redacts each span
 * on arrival, stores it under the session's `spans/` and touches the session's pending marker;
 * later the assembler orders a session's spans into records and hands them to
 * `Pipeline.publishAssembled`, which runs the session filter, model review and the write. */
export interface SpanAssembler {
  accept(batch: SpanBatch): Promise<SpanBatchResult>;
}

/** A session the assembler rebuilt from its spans: the whole session, every time. */
export interface AssembledSession {
  /** The envelope of a batch of the session: who wrote it, whose it is, which session, and the
   * source. Its payload is not read. */
  envelope: Envelope;
  /** The session's records, meta first, normalized and regex-redacted. */
  records: NormalizedRecord[];
  /** The LLM calls the records' `llm_call` fields name. */
  llm_calls?: LlmCall[];
}
