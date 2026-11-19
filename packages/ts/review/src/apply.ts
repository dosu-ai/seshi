import type { NormalizedRecord } from "@seshi/model";
import type { ReviewFinding } from "@seshi/store";
import { ProviderError } from "./provider";
import { type Entry, fieldText } from "./render";

export type Label = "allow" | "redact" | "drop";

const LABELS: ReadonlySet<string> = new Set(["allow", "redact", "drop"]);

export function checkLabel(answer: unknown): Label {
  if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
    const keys = Object.keys(answer);
    const label = (answer as { label?: unknown }).label;
    if (keys.length === 1 && typeof label === "string" && LABELS.has(label)) return label as Label;
  }
  throw new ProviderError("invalid_answer", true, "the decision model's answer is not one label");
}

export interface RawFinding {
  record: number;
  field: string;
  text: string;
  category: string;
  action: "redact" | "withhold";
}

export function checkFindings(answer: unknown): RawFinding[] {
  const bad = () =>
    new ProviderError("invalid_answer", true, "the redactor's answer does not fit its schema");
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw bad();
  const list = (answer as { findings?: unknown }).findings;
  if (!Array.isArray(list)) throw bad();
  return list.map((item) => {
    if (typeof item !== "object" || item === null) throw bad();
    const f = item as Record<string, unknown>;
    if (
      typeof f.record !== "number" ||
      !Number.isInteger(f.record) ||
      typeof f.field !== "string" ||
      typeof f.text !== "string" ||
      typeof f.category !== "string" ||
      (f.action !== "redact" && f.action !== "withhold")
    ) {
      throw bad();
    }
    return {
      record: f.record,
      field: f.field,
      text: f.text,
      category: f.category,
      action: f.action,
    };
  });
}

export const MIN_FINDING_CHARS = 4;

function categoryOf(name: string, known: ReadonlySet<string>): string {
  return known.has(name) ? name : "other";
}

export function marker(category: string): string {
  return `[redacted:${category}]`;
}

export interface Applied {
  records: NormalizedRecord[];
  findings: ReviewFinding[];
  unmatched: number;
}

interface FieldPlan {
  withhold?: string;
  spans: { start: number; end: number; category: string }[];
}

export function applyFindings(
  records: readonly NormalizedRecord[],
  answers: readonly { findings: readonly RawFinding[]; shown: readonly Entry[] }[],
  categories: ReadonlySet<string>,
  lead: number,
): Applied {
  const plans = new Map<string, FieldPlan>();
  const recorded = new Map<string, ReviewFinding>();
  let unmatched = 0;
  for (const { findings, shown } of answers) {
    const allowed = new Set(shown.map((e) => `${e.record}\n${e.field}`));
    for (const finding of findings) {
      const key = `${finding.record}\n${finding.field}`;
      const record = records[finding.record];
      const text = record ? fieldText(record, finding.field) : undefined;
      if (!allowed.has(key) || text === undefined) {
        unmatched++;
        continue;
      }
      const category = categoryOf(finding.category, categories);
      const plan = plans.get(key) ?? { spans: [] };
      const role = (record as { role: string }).role;
      const withhold =
        finding.action === "withhold" && role === "tool" && finding.field === "content";
      if (withhold) {
        plan.withhold ??= category;
      } else {
        if (finding.text.length < MIN_FINDING_CHARS || !text.includes(finding.text)) {
          unmatched++;
          continue;
        }
        for (let at = text.indexOf(finding.text); at !== -1; ) {
          plan.spans.push({ start: at, end: at + finding.text.length, category });
          at = text.indexOf(finding.text, at + finding.text.length);
        }
      }
      plans.set(key, plan);
      const action = withhold ? "withhold" : "redact";
      const location: ReviewFinding = {
        record: lead + finding.record,
        field: finding.field,
        category,
        action,
      };
      recorded.set(`${location.record}\n${location.field}\n${category}\n${action}`, location);
    }
  }

  const out = records.map((r) => structuredClone(r)) as NormalizedRecord[];
  for (const [key, plan] of plans) {
    const [index, field] = key.split("\n") as [string, string];
    const record = out[Number(index)] as unknown as Record<string, unknown>;
    if (plan.withhold !== undefined) {
      record.content = marker(plan.withhold);
      record.withheld = "review";
      continue;
    }
    const text = fieldText(record as unknown as NormalizedRecord, field) as string;
    setField(record, field, removeSpans(text, plan.spans));
  }
  const findings = [...recorded.values()].sort(
    (a, b) =>
      a.record - b.record ||
      a.field.localeCompare(b.field) ||
      a.category.localeCompare(b.category) ||
      a.action.localeCompare(b.action),
  );
  return { records: out, findings, unmatched };
}

export function removeSpans(
  text: string,
  spans: readonly { start: number; end: number; category: string }[],
): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i] as (typeof sorted)[number];
    let end = first.end;
    i++;
    while (i < sorted.length && (sorted[i] as (typeof sorted)[number]).start < end) {
      end = Math.max(end, (sorted[i] as (typeof sorted)[number]).end);
      i++;
    }
    out += text.slice(at, first.start) + marker(first.category);
    at = end;
  }
  return out + text.slice(at);
}

function setField(record: Record<string, unknown>, field: string, value: string): void {
  if (field === "content") {
    record.content = value;
    return;
  }
  const m = /^tool_calls\[(\d+)\]\.args$/.exec(field) as RegExpExecArray;
  const calls = record.tool_calls as Record<string, unknown>[];
  (calls[Number(m[1])] as Record<string, unknown>).args = value;
}
