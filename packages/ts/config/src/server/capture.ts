import { excludeEntryProblem, maskedEntry } from "@seshi/model/exclude";
import * as z from "zod";

/** One entry of an exclude list (the server's `[capture] exclude`, the CLI's
 * `capture.exclude`): one that could never match is refused. The message shows the entry with
 * any credential in it masked, so it can be found in its file (the path's index counts every
 * file's entries). */
export const excludeEntry = z.string().superRefine((entry, ctx) => {
  const problem = excludeEntryProblem(entry);
  if (problem !== undefined) {
    ctx.addIssue({ code: "custom", message: `${JSON.stringify(maskedEntry(entry))} ${problem}` });
  }
});

export const captureSection = z
  .strictObject({
    allow_retract: z
      .boolean()
      .default(true)
      .describe(
        "Let the machine that uploaded a session retract it with its per-session secret (F9.7).",
      ),
    exclude: z
      .array(excludeEntry)
      .default([])
      .describe(
        "The org's exclude list: sessions in these repositories (owner/name on any host, host/owner/name on one) or folders (starting with /, ~, a drive or \\\\server, and everything under them) are never stored, from any source. The server applies it to its own sources (repositories only); laptops download it (GET /v1/capture/rules) and apply it with their own capture.exclude. * matches within a path segment, ** across any number of them; blank entries and # comments are skipped. Drop-ins in seshi.d/ add to it.",
      ),
  })
  .prefault({})
  .describe("Capture integrations (F9) and the org's exclude list.");

export type CaptureSection = z.output<typeof captureSection>;
