/** `[store]`: the bucket every session goes to (X6.1), and what the deployment it belongs to
 * is called (X1.4). */

import * as z from "zod";
import { secret } from "../secret";
import { storeUrl } from "./common";

export const TRACE_FORMATS = ["letta", "otlp"] as const;

/** Static bucket keys. Without them the bucket client falls back to the standard
 * `AWS_*` / `S3_*` (and `R2_*` for `r2://`) variables, like any S3 tool. */
export const bucketCredentials = z
  .strictObject({
    access_key_id: secret().describe("The access key id."),
    secret_access_key: secret().describe("The secret access key."),
    session_token: secret().optional().describe("A session token, for temporary credentials."),
  })
  .describe("Static bucket keys.");

const store = z.strictObject({
  url: storeUrl.describe(
    "Where sessions go: s3://bucket/prefix, r2://bucket/prefix, or file:///path for one machine.",
  ),
  credentials: bucketCredentials.optional(),
  region: z.string().min(1).optional().describe("The bucket's region (s3://)."),
  endpoint: z
    .string()
    .min(1)
    .optional()
    .describe("An S3-compatible endpoint (MinIO, Backblaze, Wasabi…); overrides the region."),
  account_id: z.string().min(1).optional().describe("The Cloudflare account id (r2://)."),
  format: z
    .enum(TRACE_FORMATS)
    .default("letta")
    .describe(
      "How traces are written: letta (trajectory-v1 records) or otlp (GenAI spans). A bucket holds one format, fixed by its first writer. Transitional: one canonical format replaces it (X6.2).",
    ),
  deployment_id: z
    .string()
    .min(1)
    .optional()
    .describe("This deployment's id, recorded in the layout marker (X1.4)."),
  org: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The organization this deployment serves (X1.1); the server will not start against a bucket marked for another (X1.4).",
    ),
});

export const storeSection = store.describe("The bucket: the source of truth (X6.1).");

export type StoreSection = z.output<typeof storeSection>;
