/** Native transcript → redacted trajectory-v1 records: the format registry's adapter, then the
 * built-in secret patterns over every non-structural string (`redactRecords`). The registry is
 * the deployment's (built by `apps/seshi` from its integrations); redaction is this layer's,
 * since `@seshi/formats` sits beside `@seshi/redact` and may not import it (X3.2). */

import type { FormatRegistry, NormalizeInput, NormalizeOutcome } from "@seshi/formats";
import { redactRecords } from "@seshi/redact";

/** Normalize one transcript to redacted trajectory-v1 records. `empty` for a transcript the
 * adapter reads but finds no conversation in; throws `NormalizeError` for one it cannot read.
 * With `chunk`, the transcript is a chunk of a log and the records are the chunk's own: no meta
 * record, and `empty` only when it holds no records at all. */
export function normalizeTranscript(
  formats: FormatRegistry,
  input: NormalizeInput,
): NormalizeOutcome {
  return formats.normalize(input, { postprocess: redactRecords });
}
