import * as z from "zod";
import { secret } from "../secret";
import { storeUrl } from "./common";

export const bucketCredentials = z
  .strictObject({
    access_key_id: secret().optional().describe("The access key id (s3://, r2://)."),
    secret_access_key: secret().optional().describe("The secret access key (s3://, r2://)."),
    session_token: secret()
      .optional()
      .describe("A session token, for temporary credentials (s3://, r2://)."),
    account_key: secret().optional().describe("The storage account's shared key (az://)."),
    sas_token: secret()
      .optional()
      .describe("A shared access signature for the container (az://), with or without its ?."),
    service_account_key: secret()
      .optional()
      .describe(
        'A Google service account key (gs://): the JSON key file\'s contents, usually { file = "/path/key.json" }.',
      ),
  })
  .superRefine((keys, ctx) => {
    const s3 = keys.access_key_id !== undefined || keys.secret_access_key !== undefined;
    const kinds = [
      s3,
      keys.account_key !== undefined,
      keys.sas_token !== undefined,
      keys.service_account_key !== undefined,
    ];
    if (kinds.filter(Boolean).length !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "give one kind of key: access_key_id and secret_access_key (s3://, r2://), account_key or sas_token (az://), service_account_key (gs://)",
      });
    } else if (s3 && (keys.access_key_id === undefined || keys.secret_access_key === undefined)) {
      ctx.addIssue({ code: "custom", message: "access_key_id and secret_access_key go together" });
    } else if (!s3 && keys.session_token !== undefined) {
      ctx.addIssue({ code: "custom", message: "session_token goes with access_key_id" });
    }
  })
  .describe(
    "Static bucket keys: access_key_id and secret_access_key for s3:// and r2://, account_key or sas_token for az://, service_account_key for gs://.",
  );

export type BucketCredentials = z.output<typeof bucketCredentials>;

/** Bucket keys as the store takes them, revealed. */
export type RevealedBucketCredentials =
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { accountKey: string }
  | { sasToken: string }
  | { serviceAccountKey: string };

export function revealBucketCredentials(keys: BucketCredentials): RevealedBucketCredentials {
  if (keys.service_account_key) {
    return { serviceAccountKey: keys.service_account_key.reveal() };
  }
  if (keys.account_key) return { accountKey: keys.account_key.reveal() };
  if (keys.sas_token) return { sasToken: keys.sas_token.reveal() };
  if (!keys.access_key_id || !keys.secret_access_key) {
    throw new Error("bucket credentials need access_key_id and secret_access_key");
  }
  return {
    accessKeyId: keys.access_key_id.reveal(),
    secretAccessKey: keys.secret_access_key.reveal(),
    ...(keys.session_token ? { sessionToken: keys.session_token.reveal() } : {}),
  };
}

/** A problem with keys given for a bucket of another kind: Azure or Google keys for an S3 URL,
 * S3 keys for an `az://` one, and so on. */
export function credentialsMismatch(
  url: string,
  keys: BucketCredentials | undefined,
): string | undefined {
  if (keys === undefined) return undefined;
  const given =
    keys.service_account_key !== undefined
      ? "service_account_key"
      : keys.account_key !== undefined || keys.sas_token !== undefined
        ? "account_key or sas_token"
        : "access_key_id";
  const wanted = url.startsWith("az://")
    ? { bucket: "an az:// bucket", takes: "account_key or sas_token" }
    : url.startsWith("gs://")
      ? { bucket: "a gs:// bucket", takes: "service_account_key" }
      : /^(s3|r2):\/\//.test(url)
        ? { bucket: "an s3:// or r2:// bucket", takes: "access_key_id and secret_access_key" }
        : undefined;
  if (wanted === undefined || wanted.takes.startsWith(given)) return undefined;
  return `${wanted.bucket} takes ${wanted.takes}, not ${given}`;
}

const store = z.strictObject({
  url: storeUrl.describe(
    "Where sessions go: s3://bucket/prefix, r2://bucket/prefix, az://container/prefix, gs://bucket/prefix, or file:///path for one machine.",
  ),
  credentials: bucketCredentials.optional(),
  region: z.string().min(1).optional().describe("The bucket's region (s3://)."),
  endpoint: z
    .string()
    .min(1)
    .optional()
    .describe(
      "An S3-compatible endpoint (MinIO, Backblaze, Wasabi…), which overrides the region; for az://, the blob endpoint, when not https://<account>.blob.core.windows.net (Azurite: http://127.0.0.1:10000/devstoreaccount1); for gs://, the JSON API root, when not https://storage.googleapis.com.",
    ),
  account_id: z.string().min(1).optional().describe("The Cloudflare account id (r2://)."),
  account_name: z
    .string()
    .min(1)
    .optional()
    .describe("The Azure storage account (az://). Falls back to AZURE_STORAGE_ACCOUNT."),
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

export const storeSection = store
  .superRefine((section, ctx) => {
    const mismatch = credentialsMismatch(section.url, section.credentials);
    if (mismatch) ctx.addIssue({ code: "custom", path: ["credentials"], message: mismatch });
  })
  .describe("The bucket: the source of truth (X6.1).");

export type StoreSection = z.output<typeof storeSection>;
