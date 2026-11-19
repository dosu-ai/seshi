import type { FormatRegistry, NormalizeInput, NormalizeOutcome } from "@seshi/formats";
import { compileRuleSet, type RuleSet, redactLlmCalls, ruleRedactor } from "@seshi/redact";

/** Normalize one transcript to redacted trajectory-v1 records. `empty` for a transcript the
 * adapter reads but finds no conversation in; throws `NormalizeError` for one it cannot read.
 * With `chunk`, the transcript is a chunk of a log and the records are the chunk's own: no meta
 * record, and `empty` only when it holds no records at all. `rules` are the redaction rules;
 * the built-in pack alone when omitted. The LLM calls the records name, when the log records
 * them, are redacted with the same rules. */
export function normalizeTranscript(
  formats: FormatRegistry,
  input: NormalizeInput,
  rules: RuleSet = compileRuleSet(),
): NormalizeOutcome {
  const redactor = ruleRedactor(rules);
  const outcome = formats.normalize(input, {
    postprocess: (records) => redactor.redact(records).records,
  });
  if (outcome.empty || !outcome.llm_calls) return outcome;
  const named = new Set(outcome.records.map((r) => (r as { llm_call?: string }).llm_call));
  const calls = redactLlmCalls(
    redactor,
    outcome.llm_calls.filter((call) => named.has(call.id)),
  ).calls;
  return calls && calls.length > 0
    ? { records: outcome.records, llm_calls: calls }
    : { records: outcome.records };
}
