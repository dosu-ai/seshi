/** `[[sources]]`: what the server ingests from on its own (F4–F6), each with an `id` and a
 * `type`. Defined in the config file only; env overrides a field of one by its id
 * (`SESHI_SOURCES__DATADOG_PROD__API_KEY`). Each writes as its service account `svc:<id>`
 * (X5.4). Pollers' timing defaults are provisional until their branches confirm them. */

import * as z from "zod";
import { secret } from "../secret";
import { duration } from "../units";
import { sourceId, storeUrl, visibility } from "./common";
import { filterOverride } from "./filter";
import { bucketCredentials } from "./store";

/** The source id hooks and the CLI upload under (X6.4); no `[[sources]]` entry may take it. */
export const UPLOAD_SOURCE_ID = "upload";

const base = {
  id: sourceId.refine(
    (id) => id !== UPLOAD_SOURCE_ID,
    `'${UPLOAD_SOURCE_ID}' is the id uploads use`,
  ),
  enabled: z.boolean().default(true).describe("false keeps the source configured but idle."),
  visibility: visibility
    .optional()
    .describe("Visibility of the sessions it writes (X5.10); default_visibility when unset."),
  filter: filterOverride.optional(),
};

export const otlpSource = z
  .strictObject({
    type: z.literal("otlp"),
    ...base,
    quiet_period: duration()
      .prefault("10m")
      .describe("Publish a session once it has had no new spans for this long (F4.4)."),
  })
  .describe(
    "An OTLP destination (F4): spans pushed to POST /otlp/v1/traces with its service token.",
  );

export const datadogSource = z
  .strictObject({
    type: z.literal("datadog"),
    ...base,
    site: z
      .string()
      .min(1)
      .default("datadoghq.com")
      .describe("The Datadog site (datadoghq.eu, us5.datadoghq.com…)."),
    api_key: secret().describe("The Datadog API key."),
    app_key: secret().describe("The Datadog application key."),
    ml_app: z.string().min(1).optional().describe("The LLM Observability ml_app to read."),
    tags: z.array(z.string().min(1)).default([]).describe("Span tags to filter by."),
    interval: duration().prefault("5m").describe("How often it polls."),
    overlap: duration()
      .prefault("10m")
      .describe("How far before the checkpoint each run reads again, for late spans (F5.2)."),
    lag: duration().prefault("2m").describe("How far behind now each run stops (F5.2)."),
    backfill: duration().prefault("7d").describe("How far back the first run reads (F5.2)."),
  })
  .describe("Datadog LLM Observability (F5), polled.");

export const s3Source = z
  .strictObject({
    type: z.literal("s3"),
    ...base,
    url: storeUrl.describe("The bucket to read: s3://bucket/prefix or r2://bucket/prefix."),
    prefix: z.string().optional().describe("A key prefix under the URL's own."),
    credentials: bucketCredentials.optional().describe("Read-only keys for the source bucket."),
    role: z
      .strictObject({
        arn: z.string().min(1).describe("The role to assume."),
        external_id: secret().optional().describe("The external id the role requires."),
      })
      .optional()
      .describe("A role to assume instead of static keys."),
    region: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    include: z
      .array(z.string().min(1))
      .default([])
      .describe("Globs of keys to read; every key when empty."),
    format: z
      .string()
      .min(1)
      .default("auto")
      .describe("auto (detect each object) or a format name (claude-code, atif…)."),
    ordered_keys: z
      .boolean()
      .default(false)
      .describe("Keys sort by time, so a run can start after the last key (F6.2)."),
    interval: duration().prefault("5m").describe("How often it polls."),
  })
  .describe("An S3-compatible bucket other systems write sessions to (F6), polled.");

export const source = z.discriminatedUnion("type", [otlpSource, datadogSource, s3Source]);

export const sourcesSection = z
  .array(source)
  .default([])
  .describe("Sources the server ingests from on its own (F4–F6).");

export type SourceConfig = z.output<typeof source>;
export type SourceType = SourceConfig["type"];
