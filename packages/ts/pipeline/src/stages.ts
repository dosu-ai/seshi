/** The seams the pipeline's stages plug into. Each is an interface the pipeline is given, with a
 * default that does the least: the branch that owns a stage supplies the real one.
 *
 * - `Authorizer` (stage 1, X4.3): checks the caller and resolves the owner. `@seshi/auth`'s
 *   `ownershipAuthorizer` holds the X5 rules; the default trusts what the envelope says.
 * - `Reviewer` (stage 5, F3): labels what an envelope adds `allow`, `redact` or `drop`. 08
 *   supplies the decision model and the redactor; the default allows everything.
 * - `HealthCounters`: counts how each envelope ended, per source (X4.8, X4.10).
 * - `SpanAssembler` (X4.2): takes span batches. 09 builds it and the span store. */

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

// --- authorize ----------------------------------------------------------------

/** The stage's contract lives in `@seshi/model`, so `@seshi/auth` (the same layer) can
 * implement it; re-exported here for callers of the pipeline. */
export type { Authorization, Authorizer };

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
 * (the same person or service account, through the same source) or an admin.
 *
 * A caller whose owner is only `claimed` (an org-key caller, X5.12) states its username, and
 * anyone holding the key can state any username (X5.3), so the name alone never proves it is
 * the original writer: the key "cannot replace other people's sessions" (X5.12). Such a caller
 * never replaces a session whose owner was established otherwise, and replaces a `claimed` one
 * only with `retractProven`: it sent the session's retraction secret, which only the machine
 * that uploaded it holds (F9.7). */
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

// --- model review ---------------------------------------------------------------

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

/** One batch of spans for the assembler, authorized, normalized and regex-redacted by the
 * pipeline: the span store never sees a span as received. */
export interface SpanBatch {
  /** The batch's envelope without its payload. */
  envelope: Omit<SpanEnvelope, "payload">;
  authorization: Authorization;
  /** The session the spans belong to. */
  archive_id: string;
  /** Each span's part of the session, and what redaction did to it. */
  parts: { part: SpanPart; redaction?: RedactionSummary }[];
  /** Spans the format could not read, left out. */
  rejected?: number;
}

/** The answer to a span batch: it is in the span store (X4.4); the session is assembled and
 * published later. */
export interface SpanBatchResult {
  status: "accepted";
  archive_id: string;
  /** Spans stored. */
  spans: number;
  /** Spans left out because the format could not read them. */
  rejected?: number;
}

/** The span assembler (X4.2, F4.4, branch 09). `accept` stores each span's normalized,
 * redacted part under the session's `spans/` and touches the session's pending marker; later
 * the assembler (`assemblePending`) orders a session's parts into records and hands them to
 * `Pipeline.publishAssembled`, which runs the session filter, model review and the write.
 * `SpanStore` is the implementation. */
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
  /** What regex redaction found in the session's spans when they arrived, summed over all of
   * them: the publish adds what the session's stored counts do not have yet. */
  redaction?: RedactionSummary;
}
