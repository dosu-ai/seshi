import * as z from "zod";
import { secret } from "../secret";
import { storeUrl } from "./common";

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
  deployment_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "This deployment's id, recorded in the layout marker (seshi.json, X1.4): the server will not start against a bucket marked for another. Without it the first server generates one.",
    ),
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
