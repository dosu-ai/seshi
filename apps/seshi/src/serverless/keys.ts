import type { SecretBackend } from "../account/secrets";

/** A bucket key as `seshi init --serverless` stores it (credential purpose `bucket`). */
export interface BucketKey {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
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
    const parsed = JSON.parse(text) as Partial<BucketKey>;
    if (typeof parsed.access_key_id === "string" && typeof parsed.secret_access_key === "string") {
      return {
        access_key_id: parsed.access_key_id,
        secret_access_key: parsed.secret_access_key,
        ...(typeof parsed.session_token === "string"
          ? { session_token: parsed.session_token }
          : {}),
      };
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

/** The bucket key in the environment, as the store would find it (`AWS_*`, `S3_*`, `R2_*`):
 * what `seshi init --serverless --key-from-env` stores. */
export function bucketKeyFromEnv(
  env: Record<string, string | undefined>,
  url: string,
): BucketKey | undefined {
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
