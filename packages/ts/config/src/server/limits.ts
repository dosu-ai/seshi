/** `[limits]`: size caps that were fixed in code (F1, data notes), with today's values. Past
 * them a session is refused with a 422, which is final. */

import * as z from "zod";
import { bytes } from "../units";

export const limitsSection = z
  .strictObject({
    max_records: z.int().positive().default(50_000).describe("Records in one trace."),
    max_records_bytes: bytes().prefault("32MiB").describe("JSON bytes of one trace's records."),
    max_upload_bytes: bytes()
      .prefault("256MiB")
      .describe("Bytes of one upload's transcript as sent, before any gzip of the request."),
  })
  .prefault({})
  .describe("Size caps; past them a session is refused (422).");

export type LimitsSection = z.output<typeof limitsSection>;
