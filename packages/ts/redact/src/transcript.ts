import type { RawFormat, RedactionSummary } from "@seshi/model";
import { bump, type Counts, type RuleSet } from "./ruleset";
import { redactSensitive, type WithheldCalls } from "./sensitive";
import { NATIVE_UNREDACTED_KEYS } from "./structural-keys";

const INPUT_KEYS: ReadonlySet<string> = new Set(["input", "arguments", "args", "parameters"]);

function isStructural(key: string | undefined): boolean {
  return key !== undefined && NATIVE_UNREDACTED_KEYS.has(key);
}

type Redacted = { value: unknown; changed: boolean };

function redactInput(value: object, rules: RuleSet, counts: Counts): Redacted {
  const text = JSON.stringify(value);
  const found: Counts = {};
  const next = rules.redactString(text, "anywhere", found);
  if (next === text) return { value, changed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(next);
  } catch {
    return redactStrings(value, rules, counts, undefined, true);
  }
  for (const [rule, n] of Object.entries(found)) bump(counts, rule, n);
  return { value: parsed, changed: true };
}

function redactStrings(
  value: unknown,
  rules: RuleSet,
  counts: Counts,
  key?: string,
  every = false,
): Redacted {
  if (typeof value === "string") {
    if (!every && isStructural(key)) return { value, changed: false };
    const next = rules.redactString(value, "anywhere", counts);
    return { value: next, changed: next !== value };
  }
  if (!every && key !== undefined && INPUT_KEYS.has(key) && value !== null) {
    if (typeof value === "object") return redactInput(value, rules, counts);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = redactStrings(item, rules, counts, undefined, every);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: next, changed } : { value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(value)) {
      const r = redactStrings(item, rules, counts, k, every);
      changed ||= r.changed;
      next[k] = r.value;
    }
    return changed ? { value: next, changed } : { value, changed };
  }
  return { value, changed: false };
}

function redactDocument(text: string, rules: RuleSet, counts: Counts): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rules.redactString(text, "anywhere", counts);
  }
  const r = redactStrings(parsed, rules, counts);
  return r.changed ? JSON.stringify(r.value) : text;
}

export interface TranscriptRedaction {
  text: string;
  withheld: WithheldCalls;
  summary: RedactionSummary;
}

export function redactTranscript(
  rules: RuleSet,
  transcript: string,
  format: RawFormat,
  carried: Readonly<WithheldCalls> = {},
): TranscriptRedaction {
  const counts: Counts = {};
  const sensitive = redactSensitive(transcript, format, rules.sensitive, carried, (input, kind) =>
    bump(counts, rules.withholdingRule(input, kind)),
  );
  const text =
    format === "json"
      ? redactDocument(sensitive.text, rules, counts)
      : sensitive.text
          .split("\n")
          .map((line) => (line.trim() ? redactDocument(line, rules, counts) : line))
          .join("\n");
  return { text, withheld: sensitive.withheld, summary: { rule_set: rules.hash, counts } };
}
