/** `[capture]`: server-side settings for capture integrations (F9). */

import * as z from "zod";

export const captureSection = z
  .strictObject({
    allow_retract: z
      .boolean()
      .default(true)
      .describe(
        "Let the machine that uploaded a session retract it with its per-session secret (F9.7).",
      ),
  })
  .prefault({})
  .describe("Capture integrations (F9).");

export type CaptureSection = z.output<typeof captureSection>;
