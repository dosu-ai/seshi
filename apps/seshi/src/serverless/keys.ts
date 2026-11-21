import { readFileSync } from "node:fs";
import { azureKeyFromEnv, type StoreCredentials } from "@seshi/store";
import type { SecretBackend } from "../account/secrets";

/** A bucket key as `seshi init --serverless` stores it (credential purpose `bucket`): an S3
 * access key for `s3://` and `r2://`, an account key or SAS token for `az://`, a service
 * account key (the JSON key file's contents) for `gs://`. */
export type BucketKey =
  | { access_key_id: string; secret_access_key: string; session_token?: string }
  | { account_key: string }
  | { sas_token: string }
  | { service_account_key: string };

/** The key as the store takes it. */
export function bucketKeyCredentials(key: BucketKey): StoreCredentials {
  if ("service_account_key" in key) return { serviceAccountKey: key.service_account_key };
  if ("account_key" in key) return { accountKey: key.account_key };
  if ("sas_token" in key) return { sasToken: key.sas_token };
  return {
    accessKeyId: key.access_key_id,
    secretAccessKey: key.secret_access_key,
    ...(key.session_token ? { sessionToken: key.session_token } : {}),
  };
}

function bucketName(url: string): string {
  return `bucket ${url}`;
}

function reviewName(provider: string): string {
  return `review ${provider}`;
}

export async function readBucketKey(
  secrets: SecretBackend,
  url: string,
): Promise<BucketKey | undefined> {
  const text = await secrets.get(bucketName(url));
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.access_key_id === "string" && typeof parsed.secret_access_key === "string") {
      return {
        access_key_id: parsed.access_key_id,
        secret_access_key: parsed.secret_access_key,
        ...(typeof parsed.session_token === "string"
          ? { session_token: parsed.session_token }
          : {}),
      };
    }
    if (typeof parsed.account_key === "string") return { account_key: parsed.account_key };
    if (typeof parsed.sas_token === "string") return { sas_token: parsed.sas_token };
    if (typeof parsed.service_account_key === "string") {
      return { service_account_key: parsed.service_account_key };
    }
  } catch {}
  return undefined;
}

export function saveBucketKey(secrets: SecretBackend, url: string, key: BucketKey): Promise<void> {
  return secrets.set(bucketName(url), JSON.stringify(key));
}

export function deleteBucketKey(secrets: SecretBackend, url: string): Promise<boolean> {
  return secrets.delete(bucketName(url));
}

/** The bucket key in the environment, as the store would find it (`AWS_*`, `S3_*`, `R2_*`;
 * for `az://`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_SAS_TOKEN` or the connection string's, when
 * it is for `account`; for `gs://`, the service account key file
 * `GOOGLE_APPLICATION_CREDENTIALS` names): what `seshi init --serverless --key-from-env`
 * stores. */
export function bucketKeyFromEnv(
  env: Record<string, string | undefined>,
  url: string,
  account?: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): BucketKey | undefined {
  if (url.startsWith("gs://")) {
    const path = env.GOOGLE_APPLICATION_CREDENTIALS;
    return path ? { service_account_key: read(path) } : undefined;
  }
  if (url.startsWith("az://")) {
    const key = azureKeyFromEnv(env, account);
    if (!key) return undefined;
    return "accountKey" in key ? { account_key: key.accountKey } : { sas_token: key.sasToken };
  }
  const r2 = url.startsWith("r2://");
  const id =
    (r2 ? env.R2_ACCESS_KEY_ID : undefined) ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secret =
    (r2 ? env.R2_SECRET_ACCESS_KEY : undefined) ??
    env.S3_SECRET_ACCESS_KEY ??
    env.AWS_SECRET_ACCESS_KEY;
  if (!id || !secret) return undefined;
  const token = env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN;
  return {
    access_key_id: id,
    secret_access_key: secret,
    ...(token ? { session_token: token } : {}),
  };
}

/** A model review key stored with `seshi review key set <provider>`. It fills a policy's
 * `api_key = { env = "…" }` for that provider when the variable is unset (F11). */
export function readReviewKey(secrets: SecretBackend, provider: string): Promise<string | null> {
  return secrets.get(reviewName(provider));
}

export function saveReviewKey(
  secrets: SecretBackend,
  provider: string,
  key: string,
): Promise<void> {
  return secrets.set(reviewName(provider), key);
}
