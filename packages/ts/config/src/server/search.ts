/** `[search]`: the local search index (F10.3). */

import * as z from "zod";

export const searchSection = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .describe("Serve search from a local index built from the change feed."),
    backend: z.enum(["sqlite"]).default("sqlite").describe("The index backend (F10.3)."),
    path: z.string().min(1).optional().describe("The index file on local disk."),
  })
  .prefault({})
  .describe("Session search (F10).");

export type SearchSection = z.output<typeof searchSection>;
