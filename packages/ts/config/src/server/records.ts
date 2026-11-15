/** `[records]`: how long drop and failure records are kept (X6.4). */

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
  })
  .prefault({})
  .describe("Records of envelopes that were not stored (X6.4).");

export type RecordsSection = z.output<typeof recordsSection>;
