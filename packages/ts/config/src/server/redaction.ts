/** `[redaction]`: the operator's rule packs (F2.1), added to the built-in rules. */

import * as z from "zod";

export const redactionSection = z
  .strictObject({
    packs: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Rule pack files, applied on top of the built-in rules. Today's JSON file (patterns, sensitive_files, secret_commands) loads as a pack.",
      ),
  })
  .prefault({})
  .describe("Regex redaction (F2). The built-in rules always run.");

export type RedactionSection = z.output<typeof redactionSection>;
