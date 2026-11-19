import * as z from "zod";

export const filterSection = z
  .strictObject({
    enabled: z.boolean().default(true).describe("false keeps every session."),
    min_chars: z
      .int()
      .nonnegative()
      .default(2000)
      .describe(
        "At least this many characters of text, tool arguments and tool results (the meta record aside).",
      ),
    require_user: z
      .boolean()
      .default(true)
      .describe(
        "At least one user record. false has no effect until the trace format accepts such sessions.",
      ),
    require_reply: z
      .boolean()
      .default(true)
      .describe(
        "At least one assistant or tool record. false has no effect until the trace format accepts such sessions.",
      ),
  })
  .prefault({})
  .describe("Which sessions are worth storing (X4.10). It judges a session's first trace only.");

export const filterOverride = z
  .strictObject({
    enabled: z.boolean().optional(),
    min_chars: z.int().nonnegative().optional(),
    require_user: z.boolean().optional(),
    require_reply: z.boolean().optional(),
  })
  .describe("This source's session filter rules; the rest come from [filter].");

export type FilterSection = z.output<typeof filterSection>;
export type FilterOverride = z.output<typeof filterOverride>;
