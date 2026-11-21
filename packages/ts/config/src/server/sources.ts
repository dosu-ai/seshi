import { LABEL_KEY, MAX_LABEL_VALUE_LENGTH, MAX_LABELS } from "@seshi/model/labels";
import * as z from "zod";
import { secret } from "../secret";
import { duration } from "../units";
import { httpUrl, sourceId, storeUrl, visibility } from "./common";
import { filterOverride } from "./filter";
import { bucketCredentials, credentialsMismatch } from "./store";

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
  labels: z
    .record(
      z
        .string()
        .regex(
          LABEL_KEY,
          "lowercase letters, digits, '.', '_' or '-', starting with a letter or digit, up to 64 characters",
        ),
      z.string().min(1).max(MAX_LABEL_VALUE_LENGTH),
    )
    .refine((labels) => Object.keys(labels).length <= MAX_LABELS, {
      message: `at most ${MAX_LABELS} labels`,
    })
    .optional()
    .describe(
      "Labels put on every session the source stores (keys [a-z0-9][a-z0-9._-]{0,63}, values up to 512 characters, at most 32). They win over labels the data carries.",
    ),
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
      .regex(/^[a-z0-9.-]+$/, "a Datadog site such as datadoghq.com or us5.datadoghq.com")
      .default("datadoghq.com")
      .describe("The Datadog site (datadoghq.eu, us5.datadoghq.com…)."),
    api_url: httpUrl
      .optional()
      .describe(
        "The Export API's base URL, instead of https://api.<site> (a proxy, or a test server).",
      ),
    api_key: secret().describe("The Datadog API key."),
    app_key: secret().describe("The Datadog application key."),
    ml_app: z.string().min(1).optional().describe("The LLM Observability ml_app to read."),
    tags: z
      .array(z.string().regex(/^[^:\s]+:\S.*$/, "a tag as key:value"))
      .default([])
      .describe("Span tags to filter by, each key:value; a span must carry all of them."),
    interval: duration().prefault("5m").describe("How often it polls."),
    overlap: duration()
      .prefault("10m")
      .describe("How far before the checkpoint each run reads again, for late spans (F5.2)."),
    lag: duration().prefault("2m").describe("How far behind now each run stops (F5.2)."),
    backfill: duration().prefault("7d").describe("How far back the first run reads (F5.2)."),
    page_size: z
      .int()
      .min(1)
      .max(5000)
      .default(500)
      .describe("Spans per Export API page (Datadog allows up to 5000, 50 MB a response)."),
    quiet_period: duration()
      .prefault("10m")
      .describe("Publish a session once no new spans have arrived for it for this long (F4.4)."),
  })
  .describe("Datadog LLM Observability (F5), polled.");

export const S3_PATH_PLACEHOLDERS = [
  "session",
  "format",
  "project",
  "branch",
  "email",
  "name",
  "username",
  "git_email",
  "git_name",
] as const;

const s3PathTemplate = z
  .string()
  .min(1)
  .superRefine((template, ctx) => {
    const seen = new Set<string>();
    for (const [, name] of template.matchAll(/\{([^{}]*)\}/g)) {
      if (!(S3_PATH_PLACEHOLDERS as readonly string[]).includes(name as string)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown placeholder {${name}} (one of ${S3_PATH_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`,
        });
      } else if (seen.has(name as string)) {
        ctx.addIssue({ code: "custom", message: `{${name}} appears twice` });
      }
      seen.add(name as string);
    }
    if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""))) {
      ctx.addIssue({ code: "custom", message: "an unmatched { or }" });
    }
    if (template.startsWith("/")) {
      ctx.addIssue({ code: "custom", message: "relative to the prefix: no leading /" });
    }
  });

export const s3Source = z
  .strictObject({
    type: z.literal("s3"),
    ...base,
    url: storeUrl.describe(
      "The bucket to read: s3://bucket/prefix, r2://bucket/prefix or az://container/prefix.",
    ),
    prefix: z.string().optional().describe("A key prefix under the URL's own."),
    credentials: bucketCredentials.optional().describe("Read-only keys for the source bucket."),
    role: z
      .strictObject({
        arn: z.string().min(1).describe("The role to assume."),
        external_id: secret().optional().describe("The external id the role requires."),
      })
      .optional()
      .describe("A role to assume instead of static keys (s3:// only)."),
    region: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    account_name: z
      .string()
      .min(1)
      .optional()
      .describe("The Azure storage account (az://). Falls back to AZURE_STORAGE_ACCOUNT."),
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
    path: s3PathTemplate
      .optional()
      .describe(
        "A template for keys under the prefix, such as {username}/{session}.jsonl: {session} names the session, {format} its format, {project} and {branch} the work, {email}, {name}, {username}, {git_email} and {git_name} identity claims (never the owner, X5.4); * and ** match the rest. Keys that do not match are skipped. Without it the session is the key under the prefix.",
      ),
  })
  .superRefine((source, ctx) => {
    const mismatch = credentialsMismatch(source.url, source.credentials);
    if (mismatch) ctx.addIssue({ code: "custom", path: ["credentials"], message: mismatch });
    if (source.role !== undefined && source.url.startsWith("az://")) {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message:
          "role applies to s3:// sources (AWS STS); an az:// source takes keys or workload identity",
      });
    }
  })
  .describe(
    "A bucket other systems write sessions to (F6), polled: S3 or S3-compatible (s3://, r2://) or Azure Blob Storage (az://).",
  );

export const cursorCloudSource = z
  .strictObject({
    type: z.literal("cursor-cloud"),
    ...base,
    api_key: secret().describe(
      "A Cursor API key (a member's, or a service account's): the poller reads the cloud agents it can see.",
    ),
    api_url: httpUrl
      .optional()
      .describe(
        "The Cloud Agents API's base URL, instead of https://api.cursor.com (a test server).",
      ),
    interval: duration().prefault("5m").describe("How often it polls."),
    lookback: duration()
      .prefault("25h")
      .describe(
        "How far back Cursor still has a run's events (it keeps them 24 hours, F7): agents untouched for longer are not read on the first poll, and a run carried past the session filter is read again only within it.",
      ),
    max_streams: z
      .int()
      .min(1)
      .max(60)
      .default(25)
      .describe(
        "Run streams one poll opens at most (Cursor allows 60 a minute); the rest wait for the next.",
      ),
    usage: z
      .boolean()
      .default(true)
      .describe("Also read each run's token usage (one more call per run)."),
  })
  .describe("Cursor Cloud agents (F7), polled through the Cloud Agents API.");

export const source = z.discriminatedUnion("type", [
  otlpSource,
  datadogSource,
  s3Source,
  cursorCloudSource,
]);

export const sourcesSection = z
  .array(source)
  .default([])
  .describe("Sources the server ingests from on its own (F4–F7).");

export type SourceConfig = z.output<typeof source>;
export type SourceType = SourceConfig["type"];
