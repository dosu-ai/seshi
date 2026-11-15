/** Native transcript → redacted trajectory-v1 records: the format registry's adapter, then a
 * rule set's redaction (the built-in pack alone by default), as the pipeline's redaction stage
 * runs it: sensitive calls withheld, then the text rules and the built-in secret patterns over
 * every non-structural string. The registry is the deployment's (built by `apps/seshi` from its
 * integrations); redaction is this layer's, since `@seshi/formats` sits beside `@seshi/redact`
 * and may not import it (X3.2). */

import type { FormatRegistry, NormalizeInput, NormalizeOutcome } from "@seshi/formats";
import { compileRuleSet, type RuleSet, ruleRedactor } from "@seshi/redact";

/** Normalize one transcript to redacted trajectory-v1 records. `empty` for a transcript the
 * adapter reads but finds no conversation in; throws `NormalizeError` for one it cannot read.
 * With `chunk`, the transcript is a chunk of a log and the records are the chunk's own: no meta
 * record, and `empty` only when it holds no records at all. `rules` are the redaction rules;
 * the built-in pack alone when omitted. */
export function normalizeTranscript(
  formats: FormatRegistry,
  input: NormalizeInput,
  rules: RuleSet = compileRuleSet(),
): NormalizeOutcome {
  const redactor = ruleRedactor(rules);
  return formats.normalize(input, { postprocess: (records) => redactor.redact(records).records });
}
