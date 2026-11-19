import type { LlmCall, NormalizedRecord, RedactionSummary } from "@seshi/model";
import type { AppliesTo } from "./pack";
import { bump, type Counts, compileRuleSet, type RuleSet } from "./ruleset";
import { classifyCall, trimSensitiveInput, type WithheldCalls } from "./sensitive";

export { BUILTIN_RULES_VERSION } from "./builtin";

export interface RecordRedaction {
  records: NormalizedRecord[];
  withheld: WithheldCalls;
  summary: RedactionSummary;
}

export interface Redactor {
  readonly rule_set: string;
  redact(records: readonly NormalizedRecord[], carried?: Readonly<WithheldCalls>): RecordRedaction;
  redactText?(text: string, field?: AppliesTo): { text: string; counts: Record<string, number> };
}

const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "tool_call_id",
  "role",
  "timestamp",
  "source",
  "name",
  "git_branch",
  "withheld",
  "llm_call",
]);

function redactValue(
  value: unknown,
  rules: RuleSet,
  field: AppliesTo,
  counts: Counts,
  key?: string,
): unknown {
  if (typeof value === "string") {
    return key !== undefined && STRUCTURAL_KEYS.has(key)
      ? value
      : rules.redactString(value, field, counts);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, rules, field, counts));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, rules, field, counts, k)]),
    );
  }
  return value;
}

function redactRecord(record: NormalizedRecord, rules: RuleSet, counts: Counts): NormalizedRecord {
  const field: AppliesTo = record.role === "tool" ? "tool_output" : "text";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "tool_calls" && record.role === "assistant") {
      out[key] = redactValue(value, rules, "tool_input", counts);
    } else {
      out[key] = redactValue(value, rules, field, counts, key);
    }
  }
  return out as unknown as NormalizedRecord;
}

function withholdCalls(
  record: NormalizedRecord,
  rules: RuleSet,
  withheld: WithheldCalls,
  counts: Counts,
): NormalizedRecord {
  if (record.role === "assistant" && "tool_calls" in record && Array.isArray(record.tool_calls)) {
    let changed = false;
    const calls = record.tool_calls.map((call) => {
      const kind = classifyCall(call.args, rules.sensitive);
      if (!kind) return call;
      if (!Object.hasOwn(withheld, call.id)) bump(counts, rules.withholdingRule(call.args, kind));
      withheld[call.id] = kind;
      if (kind !== "sensitive-file") return call;
      const args = trimSensitiveInput(call.args, rules.sensitive.files);
      if (args === call.args) return call;
      changed = true;
      return { ...call, args };
    });
    return changed ? ({ ...record, tool_calls: calls } as NormalizedRecord) : record;
  }
  if (record.role === "tool" && Object.hasOwn(withheld, record.tool_call_id)) {
    const kind = withheld[record.tool_call_id];
    return { ...record, content: `[redacted:${kind}]`, withheld: kind } as NormalizedRecord;
  }
  return record;
}

export function ruleSetHash(rules: RuleSet): string {
  return rules.hash;
}

export function ruleRedactor(rules: RuleSet = compileRuleSet()): Redactor {
  const rule_set = rules.hash;
  return {
    rule_set,
    redact(records, carried = {}) {
      const withheld: WithheldCalls = { ...carried };
      const counts: Counts = {};
      const out = records.map((record) =>
        redactRecord(withholdCalls(record, rules, withheld, counts), rules, counts),
      );
      return { records: out, withheld, summary: { rule_set, counts } };
    },
    redactText(text, field = "text") {
      const counts: Counts = {};
      return { text: rules.redactString(text, field, counts), counts };
    },
  };
}

function textAsRecord(redactor: Redactor, text: string): { text: string; counts: Counts } {
  const out = redactor.redact([
    { role: "system", content: text, timestamp: "" } as NormalizedRecord,
  ]);
  const content = (out.records[0] as { content?: unknown } | undefined)?.content;
  return { text: typeof content === "string" ? content : text, counts: { ...out.summary.counts } };
}

export function redactLlmCalls(
  redactor: Redactor,
  calls: readonly LlmCall[] | undefined,
): { calls: LlmCall[] | undefined; counts: Record<string, number> } {
  const counts: Counts = {};
  if (!calls || calls.length === 0) {
    return { calls: calls ? [...calls] : undefined, counts };
  }
  const text = (value: string): string => {
    const out = redactor.redactText?.(value, "text") ?? textAsRecord(redactor, value);
    for (const [id, n] of Object.entries(out.counts)) bump(counts, id, n);
    return out.text;
  };
  const redacted = calls.map((call) => {
    let next = call;
    if (typeof call.error === "string") {
      const error = text(call.error);
      if (error !== call.error) next = { ...next, error };
    }
    if (call.parameters) {
      let changed = false;
      const parameters: NonNullable<LlmCall["parameters"]> = {};
      for (const [key, value] of Object.entries(call.parameters)) {
        const v = typeof value === "string" ? text(value) : value;
        if (v !== value) changed = true;
        parameters[key] = v;
      }
      if (changed) next = { ...next, parameters };
    }
    return next;
  });
  return { calls: redacted, counts };
}
