/** `[redaction]`: the operator's rule packs (F2.1), added to the built-in rules. */

import * as z from "zod";

export const redactionSection = z
  .strictObject({
    packs: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Rule pack files (F2.1), in order, on top of the built-in pack: TOML packs (rules, sensitive_files, secret_commands, disable), and today's JSON rule files (patterns, sensitive_files, secret_commands), which load together as the `legacy` pack. Operator patterns run under RE2 (F2.2); every rule's test strings are checked at start-up. Restart to apply a change, then `seshi redact backfill` to apply it to stored sessions.",
      ),
  })
  .prefault({})
  .describe("Regex redaction (F2). The built-in rules always run.");

export type RedactionSection = z.output<typeof redactionSection>;
