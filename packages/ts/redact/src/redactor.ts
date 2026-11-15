/** Regex redaction of a session's normalized records: the pipeline's redaction stage (X4.3,
 * F2). With no raw stored (X6.3), the rules run on the records, where tool calls, file paths and
 * outputs are already separate fields, so each rule reads exactly what it is about:
 *
 * 1. Sensitive calls: a tool call whose input names a sensitive file or runs a secret command
 *    (`sensitive.ts`, the rule set's file and command rules) is kept, so the session still says
 *    the agent looked; a sensitive-file call's input keeps only what names the file, and the
 *    call's result is replaced by `[redacted:sensitive-file]` / `[redacted:secret-output]` and
 *    marked `withheld`. A result can arrive in a later chunk than its call, so the pass takes
 *    the ids withheld so far and returns them with this pass's added; the pipeline keeps them
 *    in the session's metadata.
 * 2. Every string that is not structural (ids, roles, timestamps, the source and the branch stay
 *    as they are, as in `redactRecords`) through the rule set: the text rules that apply where
 *    the string is (`text`: messages, `tool_input`: a call's arguments, `tool_output`: a tool
 *    record), then the built-in secret patterns.
 *
 * Deterministic: the same records and the same withheld ids always redact to the same records,
 * which content hashes and the continuation prefix (computed over the output) depend on.
 * Idempotent: redacted records redact to themselves, and count nothing the second time. What
 * ran is summarized as the rule set's hash and the matches by rule id (F2.3), never what
 * matched. */

import type { LlmCall, NormalizedRecord, RedactionSummary } from "@seshi/model";
import type { AppliesTo } from "./pack";
import { bump, type Counts, compileRuleSet, type RuleSet } from "./ruleset";
import { classifyCall, trimSensitiveInput, type WithheldCalls } from "./sensitive";

export { BUILTIN_RULES_VERSION } from "./builtin";

export interface RecordRedaction {
  records: NormalizedRecord[];
  /** The ids passed in as `carried`, plus every call this pass withheld. */
  withheld: WithheldCalls;
  /** The rule set that ran and how often each rule fired. */
  summary: RedactionSummary;
}

/** The pipeline's redaction stage. */
export interface Redactor {
  /** sha256 of the rule set, as `RedactionSummary.rule_set`. */
  readonly rule_set: string;
  /** `records` redacted; `carried` is what the passes over the session's earlier records
   * withheld. Never throws for content. */
  redact(records: readonly NormalizedRecord[], carried?: Readonly<WithheldCalls>): RecordRedaction;
  /** One string outside the records (an LLM call's error or parameters, a span attribute) as
   * the rules treat a string in `field` (`text` by default). */
  redactText?(text: string, field?: AppliesTo): { text: string; counts: Record<string, number> };
}

/** Keys whose string values are structural identity, not text (see `records.ts`). */
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

/** One record's strings, each by where it sits: a tool record's are tool output, an assistant
 * record's `tool_calls` are tool input, everything else is text. */
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

/** The sensitive-call pass over one record. */
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

/** sha256 of a rule set (`RuleSet.hash`). */
export function ruleSetHash(rules: RuleSet): string {
  return rules.hash;
}

/** A rule set as a `Redactor`: the built-in pack alone when none is given. */
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

/** The free text an LLM call carries (`error`, and the string values of `parameters`) through
 * the redactor's `redactText`, as `text`. Ids, model, provider, stop reason and timing are
 * structural and stay. Calls with nothing to redact are returned as they are; a redactor without
 * `redactText` (a test fake) leaves them all. `counts` are by rule id, for the session's summary. */
export function redactLlmCalls(
  redactor: Redactor,
  calls: readonly LlmCall[] | undefined,
): { calls: LlmCall[] | undefined; counts: Record<string, number> } {
  const counts: Counts = {};
  if (!calls || calls.length === 0 || !redactor.redactText) {
    return { calls: calls ? [...calls] : undefined, counts };
  }
  const text = (value: string): string => {
    const out = redactor.redactText?.(value, "text") ?? { text: value, counts: {} };
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
