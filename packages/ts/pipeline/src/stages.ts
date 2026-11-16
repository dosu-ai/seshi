import { createHash, timingSafeEqual } from "node:crypto";
import type {
  Authorization,
  Authorizer,
  Envelope,
  LlmCall,
  NormalizedRecord,
  OwnerBasis,
  RedactionSummary,
  SessionMetadata,
  SpanPart,
  Writer,
} from "@seshi/model";
import {
  addHealth,
  type HealthCounts,
  type HealthOutcome,
  healthDay,
  type ReviewFailure,
  type ReviewFinding,
  type Store,
} from "@seshi/store";
import type { SpanEnvelope } from "./envelope";
import { writerOf } from "./envelope";

export type { Authorization, Authorizer };

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

/** Whether `secret` is the retraction secret whose sha256 (hex) a session keeps as
 * `retract_hash` (F9.7). False when either is missing. */
export function retractSecretMatches(
  secret: string | undefined,
  retractHash: string | undefined,
): boolean {
  if (secret === undefined || retractHash === undefined) return false;
  const given = Buffer.from(createHash("sha256").update(secret, "utf8").digest("hex"), "utf8");
  const kept = Buffer.from(retractHash, "utf8");
  return given.length === kept.length && timingSafeEqual(given, kept);
}

/** Whether `auth` may replace a session first written by `original` (X4.6): its original writer
 * (the same person or service account, through the same source) or an admin. */
export function mayReplace(
  auth: Authorization,
  original: Writer,
  originalBasis?: OwnerBasis,
  retractProven = false,
): boolean {
  if (auth.admin) return true;
  if (auth.owner_basis === "claimed") {
    if (originalBasis !== undefined && originalBasis !== "claimed") return false;
    if (!retractProven) return false;
  }
  return (
    auth.writer.principal === original.principal && auth.writer.source_id === original.source_id
  );
}

/** What a review decided, as kept beside the session (`review/<n>.json`, F3.8): never the
 * matched text. */
export interface ReviewNote {
  policy: string;
  policy_hash: string;
  decision_model: string;
  redactor_model?: string;
  findings: ReviewFinding[];
  /** Findings that named no text of the envelope, so removed nothing (F3.8). */
  unmatched?: number;
  /** How many parts the envelope was split into for the models (F3.7). */
  parts?: number;
  /** For `skipped`: which step failed and how (F3.4). */
  failure?: ReviewFailure;
}

export interface ReviewInput {
  /** The envelope without its payload: the reviewer judges `records`, which regex redaction has
   * already run on, and never sees the unredacted transcript or spans (X4.3, F3). */
  envelope: Omit<Envelope, "payload">;
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
      redactor_model?: string;
      /** For `review_failed`: which step failed and how. */
      failure?: ReviewFailure;
    };

export interface Reviewer {
  /** Judge one envelope. Retries and `on_failure` are the reviewer's (F3.4); a throw is treated
   * as transient, so nothing is written and the caller retries. */
  review(input: ReviewInput): Promise<ReviewDecision>;
}

export function noReview(): Reviewer {
  return { review: async () => ({ action: "allow" }) };
}

export interface HealthCounters {
  /** Count one envelope from `sourceId` that ended as `outcome`. Never throws and never waits:
   * counting cannot fail an upload. */
  count(sourceId: string, outcome: HealthOutcome): void;
  /** Wait until what was counted is written. */
  flush(): Promise<void>;
}

export function noHealth(): HealthCounters {
  return { count: () => {}, flush: async () => {} };
}

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

/** One batch of spans for the assembler, authorized, normalized and regex-redacted by the
 * pipeline: the span store never sees a span as received. */
export interface SpanBatch {
  envelope: Omit<SpanEnvelope, "payload">;
  authorization: Authorization;
  archive_id: string;
  parts: { part: SpanPart; redaction?: RedactionSummary }[];
  /** Spans the format could not read, left out. */
  rejected?: number;
}

/** The answer to a span batch: it is in the span store (X4.4); the session is assembled and
 * published later. */
export interface SpanBatchResult {
  status: "accepted";
  archive_id: string;
  spans: number;
  /** Spans left out because the format could not read them. */
  rejected?: number;
}

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
  llm_calls?: LlmCall[];
  /** What regex redaction found in the session's spans when they arrived, summed over all of
   * them: the publish adds what the session's stored counts do not have yet. */
  redaction?: RedactionSummary;
}
