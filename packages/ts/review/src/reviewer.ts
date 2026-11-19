import type { ReviewDecision, Reviewer, ReviewInput, ReviewNote } from "@seshi/pipeline";
import type { ReviewFailure } from "@seshi/store";
import { applyFindings, checkFindings, checkLabel, type Label, type RawFinding } from "./apply";
import { matches, type Policy, type PolicyStep } from "./policy";
import {
  DECISION_SCHEMA,
  decisionSystem,
  FINDINGS_SCHEMA,
  recordsMessage,
  redactorSystem,
} from "./prompts";
import { ProviderError } from "./provider";
import { type Entry, partsOf } from "./render";

export interface ReviewLogger {
  warn(message: string): void;
}

export interface ModelReviewerOptions {
  policies: readonly Policy[];
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  log?: ReviewLogger;
}

export function modelName(step: PolicyStep): string {
  return `${step.provider.kind}/${step.provider.model}`;
}

type CallResult<T> = { ok: true; value: T } | { ok: false; failure: ReviewFailure };

export class ModelReviewer implements Reviewer {
  readonly policies: readonly Policy[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly log: ReviewLogger | undefined;

  constructor(options: ModelReviewerOptions) {
    this.policies = options.policies;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.backoffMs = options.backoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.log = options.log;
  }

  policyFor(input: ReviewInput): Policy | undefined {
    const project = input.envelope.project ?? input.session?.project;
    return this.policies.find((p) =>
      matches(p, {
        source_id: input.envelope.source_id,
        format: input.envelope.format,
        ...(project ? { project } : {}),
      }),
    );
  }

  async review(input: ReviewInput): Promise<ReviewDecision> {
    const policy = this.policyFor(input);
    if (!policy) return { action: "allow" };
    const base = {
      policy: policy.id,
      policy_hash: policy.hash,
      decision_model: modelName(policy.decision),
    };
    const parts = partsOf(input.records, policy.maxInputChars);
    if (parts.length === 0) {
      return { action: "allow", note: { ...base, findings: [], parts: 0 } };
    }

    const labelled: { label: Label; part: Entry[] }[] = [];
    for (const part of parts) {
      const result = await this.call(policy, "decision", part, checkLabel);
      if (!result.ok) return this.failed(policy, base, result.failure, parts.length);
      if (result.value === "drop") {
        return { action: "drop", reason: "review_drop", ...base };
      }
      labelled.push({ label: result.value, part });
    }
    const flagged = labelled.filter((l) => l.label === "redact");
    if (flagged.length === 0) {
      return { action: "allow", note: { ...base, findings: [], parts: parts.length } };
    }

    const answers: { findings: RawFinding[]; shown: Entry[] }[] = [];
    for (const { part } of flagged) {
      const result = await this.call(policy, "redactor", part, checkFindings);
      if (!result.ok) return this.failed(policy, base, result.failure, parts.length);
      answers.push({ findings: result.value, shown: part });
    }
    const applied = applyFindings(
      input.records,
      answers,
      new Set(policy.redactor.categories.map((c) => c.name)),
      input.meta ? 1 : 0,
    );
    const note: ReviewNote = {
      ...base,
      redactor_model: modelName(policy.redactor),
      findings: applied.findings,
      parts: parts.length,
      ...(applied.unmatched > 0 ? { unmatched: applied.unmatched } : {}),
    };
    return { action: "redact", records: applied.records, note };
  }

  private failed(
    policy: Policy,
    base: { policy: string; policy_hash: string; decision_model: string },
    failure: ReviewFailure,
    parts: number,
  ): ReviewDecision {
    this.log?.warn(
      `review policy '${policy.id}': the ${failure.step} model failed after ${failure.attempts} call(s) (${failure.code}); on_failure = ${policy.onFailure}`,
    );
    const redactor =
      failure.step === "redactor" ? { redactor_model: modelName(policy.redactor) } : {};
    if (policy.onFailure === "skip") {
      return { action: "skipped", note: { ...base, ...redactor, findings: [], parts, failure } };
    }
    return { action: "drop", reason: "review_failed", ...base, ...redactor, failure };
  }

  private async call<T>(
    policy: Policy,
    role: "decision" | "redactor",
    part: Entry[],
    check: (answer: unknown) => T,
  ): Promise<CallResult<T>> {
    const step = role === "decision" ? policy.decision : policy.redactor;
    const system =
      role === "decision"
        ? decisionSystem(policy.decision.prompt)
        : redactorSystem(policy.redactor.prompt, policy.redactor.categories);
    const request = {
      system,
      user: recordsMessage(part),
      schema: role === "decision" ? DECISION_SCHEMA : FINDINGS_SCHEMA,
      schemaName: role === "decision" ? "decision" : "findings",
      maxTokens: step.maxTokens,
      timeoutMs: step.timeoutMs,
    };
    const attempts = policy.retries + 1;
    let last: ProviderError = new ProviderError("error", true);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return { ok: true, value: check(await step.provider.complete(request)) };
      } catch (err) {
        last = err instanceof ProviderError ? err : new ProviderError("error", true);
        if (!last.retryable || attempt === attempts) {
          return { ok: false, failure: { step: role, code: last.code, attempts: attempt } };
        }
        await this.sleep(this.backoff(attempt));
      }
    }
    return { ok: false, failure: { step: role, code: last.code, attempts } };
  }

  private backoff(attempt: number): number {
    const full = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - 1));
    return Math.round(full * (0.5 + this.random() / 2));
  }
}
