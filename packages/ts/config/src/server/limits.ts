import * as z from "zod";
import { bytes } from "../units";

export const limitsSection = z
  .strictObject({
    max_records: z.int().positive().default(50_000).describe("Records in one trace."),
    max_records_bytes: bytes().prefault("32MiB").describe("JSON bytes of one trace's records."),
    max_upload_bytes: bytes()
      .prefault("256MiB")
      .describe("Bytes of one upload's transcript as sent, before any gzip of the request."),
    max_otlp_bytes: bytes()
      .prefault("64MiB")
      .describe("Bytes of one OTLP request body as sent (gzipped or not); past it, 413."),
    max_otlp_inflated_bytes: bytes()
      .prefault("256MiB")
      .describe("Bytes of one gzipped OTLP request body once inflated; past it, 413."),
  })
  .prefault({})
  .describe("Size caps; past them a session is refused (422), or an OTLP request (413).");

export type LimitsSection = z.output<typeof limitsSection>;
