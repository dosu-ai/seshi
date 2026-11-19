import type { NormalizedRecord } from "@seshi/model";
import type { ReviewDecision, ReviewInput } from "@seshi/pipeline";
import BUILTIN from "./labelled-fixtures.json";
import type { Policy } from "./policy";
import { entriesOf } from "./render";
import { ModelReviewer, type ModelReviewerOptions } from "./reviewer";

export interface Fixture {
  name: string;
  label: "allow" | "redact" | "drop";
  sensitive: string[];
  records: NormalizedRecord[];
}

export const BUILTIN_FIXTURES: readonly Fixture[] = BUILTIN as unknown as Fixture[];

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

export function parseFixtures(value: unknown, where: string): Fixture[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item, i) => {
    const at = `${where}[${i}]`;
    if (typeof item !== "object" || item === null) throw new FixtureError(`${at}: not an object`);
    const f = item as Record<string, unknown>;
    if (typeof f.name !== "string" || f.name === "") throw new FixtureError(`${at}: name`);
    if (f.label !== "allow" && f.label !== "redact" && f.label !== "drop") {
      throw new FixtureError(`${at}: label must be allow, redact or drop`);
    }
    const sensitive = f.sensitive ?? [];
    if (!Array.isArray(sensitive) || sensitive.some((s) => typeof s !== "string" || s === "")) {
      throw new FixtureError(`${at}: sensitive must be a list of text`);
    }
    if (!Array.isArray(f.records) || f.records.length === 0) {
      throw new FixtureError(`${at}: records must be a non-empty list`);
    }
    return {
      name: f.name,
      label: f.label,
      sensitive: sensitive as string[],
      records: f.records as NormalizedRecord[],
    };
  });
}

export interface FixtureResult {
  name: string;
  expected: Fixture["label"];
  got: "allow" | "redact" | "drop" | "failed";
  findings: number;
  leaked: number;
  failure?: string;
}

export interface EvalReport {
  policy: string;
  policy_hash: string;
  decision_model: string;
  redactor_model: string;
  fixtures: number;
  label_accuracy: number;
  false_drops: number;
  missed_drops: number;
  redactor_recall: number | null;
  leaked: number;
  failures: number;
  results: FixtureResult[];
}

function stored(decision: ReviewDecision, records: readonly NormalizedRecord[]) {
  if (decision.action === "drop") return [];
  return decision.action === "redact" ? decision.records : records;
}

function survivors(records: readonly NormalizedRecord[], sensitive: readonly string[]): number {
  const texts = entriesOf(records).map((e) => e.text);
  return sensitive.filter((s) => texts.some((t) => t.includes(s))).length;
}

export async function evaluate(
  policy: Policy,
  fixtures: readonly Fixture[],
  options: Omit<ModelReviewerOptions, "policies"> = {},
): Promise<EvalReport> {
  const reviewer = new ModelReviewer({
    ...options,
    policies: [{ ...policy, sources: [], agents: [], repos: [] }],
  });
  const results: FixtureResult[] = [];
  let seen = 0;
  let removed = 0;
  for (const fixture of fixtures) {
    const input: ReviewInput = {
      envelope: {
        schema: "seshi/envelope/1",
        source: "upload",
        source_id: "upload",
        format: "eval",
        session_key: fixture.name,
        caller: { kind: "admin", principal: "eval" },
        owner: "eval",
        owner_basis: "verified",
        idempotency_key: `eval#${fixture.name}`,
        received_at: new Date(0).toISOString(),
      },
      owner: "eval",
      archive_id: "0".repeat(64),
      session: null,
      meta: undefined,
      records: fixture.records,
    };
    const decision = await reviewer.review(input);
    const left = survivors(stored(decision, fixture.records), fixture.sensitive);
    let got: FixtureResult["got"];
    let failure: string | undefined;
    if (
      decision.action === "skipped" ||
      (decision.action === "drop" && decision.reason === "review_failed")
    ) {
      got = "failed";
      const f = decision.action === "skipped" ? decision.note?.failure : decision.failure;
      failure = f ? `${f.step}: ${f.code}` : "failed";
    } else {
      got = decision.action;
    }
    if (decision.action === "redact") {
      seen += fixture.sensitive.length;
      removed += fixture.sensitive.length - left;
    }
    results.push({
      name: fixture.name,
      expected: fixture.label,
      got,
      findings: decision.action === "redact" ? (decision.note?.findings.length ?? 0) : 0,
      leaked: left,
      ...(failure ? { failure } : {}),
    });
  }
  const n = results.length;
  return {
    policy: policy.id,
    policy_hash: policy.hash,
    decision_model: `${policy.decision.provider.kind}/${policy.decision.provider.model}`,
    redactor_model: `${policy.redactor.provider.kind}/${policy.redactor.provider.model}`,
    fixtures: n,
    label_accuracy: n === 0 ? 0 : results.filter((r) => r.got === r.expected).length / n,
    false_drops: results.filter((r) => r.got === "drop" && r.expected !== "drop").length,
    missed_drops: results.filter((r) => r.expected === "drop" && r.got !== "drop").length,
    redactor_recall: seen === 0 ? null : removed / seen,
    leaked: results.reduce((sum, r) => sum + r.leaked, 0),
    failures: results.filter((r) => r.got === "failed").length,
    results,
  };
}
