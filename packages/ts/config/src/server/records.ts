/** `[records]`: how long drop and failure records, and source health counters, are kept (X6.4,
 * X4.8). The worker's retention job prunes them. */

import * as z from "zod";
import { duration } from "../units";

export const recordsSection = z
  .strictObject({
    dropped_retention: duration()
      .prefault("30d")
      .describe(
        "How long records of envelopes model review dropped are kept (sources/<id>/dropped/).",
      ),
    failed_retention: duration()
      .prefault("30d")
      .describe("How long records of envelopes that failed are kept (sources/<id>/failed/)."),
    health_retention: duration()
      .prefault("90d")
      .describe("How many days of source health counters are kept (sources/<id>/health/)."),
  })
  .prefault({})
  .describe("Records of envelopes that were not stored (X6.4).");

export type RecordsSection = z.output<typeof recordsSection>;
