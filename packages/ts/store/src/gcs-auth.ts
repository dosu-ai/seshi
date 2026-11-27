import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@seshi/model";
import { type Renewable, renewAt, renewing } from "./renewing";
import { StoreError } from "./store";

/** Read and write objects: what the store and a source both ask for. A source only reads, but
 * on GKE and with a service account key the bucket's IAM decides, not the scope. */
export const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** How long the metadata server has to answer: off Google Cloud its name may resolve to a host
 * that never does, and every request would wait for the connection to time out. */
const METADATA_TIMEOUT_MS = 10_000;

/** How the GCS client gets the bearer token it sends: asked before each request, so it can be
 * renewed. `undefined` sends none (an emulator). */
export type GcsTokenSource = (() => Promise<string>) | undefined;

/** Getting an access token failed. Not a `BucketHttpError`: the bucket never answered, so it
 * says nothing about what the bucket does (the storage test throws it on). */
export class GcsAuthError extends StoreError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GcsAuthError";
  }
}

/** A Google credentials file: a service account key, or the user credentials `gcloud auth
 * application-default login` writes. The other kinds (`external_account`,
 * `impersonated_service_account`) are refused by name. */
type CredentialsFile =
  | {
      type: "service_account";
      client_email: string;
      private_key: string;
      private_key_id?: string;
      token_uri?: string;
    }
  | { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string };

/** Parse a credentials file's JSON; `label` says where it came from in errors. */
export function parseCredentialsFile(text: string, label: string): CredentialsFile {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StoreError(`${label} is not a Google credentials JSON file`);
  }
  const has = (...names: string[]) => names.every((n) => typeof parsed[n] === "string");
  if (parsed.type === "service_account" && has("client_email", "private_key")) {
    return parsed as unknown as CredentialsFile;
  }
  if (parsed.type === "authorized_user" && has("client_id", "client_secret", "refresh_token")) {
    return parsed as unknown as CredentialsFile;
  }
  if (typeof parsed.type === "string") {
    throw new StoreError(
      `${label}: credentials of type ${parsed.type} are not supported; use a service account key, gcloud's application-default user credentials, or the metadata server (GKE Workload Identity)`,
    );
  }
  throw new StoreError(`${label} is not a Google credentials JSON file (no type)`);
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** The signed JWT a service account exchanges for an access token (RFC 7523). */
export function serviceAccountAssertion(
  key: { client_email: string; private_key: string; private_key_id?: string; token_uri?: string },
  now: Date,
  scope = GCS_SCOPE,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(key.private_key_id ? { kid: key.private_key_id } : {}),
  };
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? DEFAULT_TOKEN_URI,
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

async function tokenFrom(
  response: Response,
  what: string,
  now: () => Date,
): Promise<Renewable<string>> {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let detail = "";
    try {
      const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      detail = [body.error, body.error_description].filter((v) => typeof v === "string").join(": ");
    } catch {}
    throw new GcsAuthError(
      response.status,
      `${what}: ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  let body: { access_token?: unknown; expires_in?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {}
  if (typeof body.access_token !== "string") {
    throw new GcsAuthError(response.status, `${what}: no access_token in the answer`);
  }
  const lifetime = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
  // The metadata server hands out its cached token until about five minutes are left.
  return { value: body.access_token, renewAt: renewAt(now().getTime(), lifetime) };
}

export interface TokenOptions {
  fetch?: Fetch;
  now?: () => Date;
  /** How long the metadata server has to answer; 10 s by default. */
  metadataTimeoutMs?: number;
}

/** Access tokens from a credentials file: a service account key signs a JWT for one; user
 * credentials trade their refresh token for one. */
export function credentialsFileToken(
  file: CredentialsFile,
  options: TokenOptions = {},
): () => Promise<string> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  if (file.type === "service_account") {
    const uri = file.token_uri ?? DEFAULT_TOKEN_URI;
    return renewing(
      async () =>
        tokenFrom(
          await fetchImpl(
            uri,
            form({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion: serviceAccountAssertion(file, now()),
            }),
          ),
          `token for service account ${file.client_email}`,
          now,
        ),
      now,
    );
  }
  return renewing(
    async () =>
      tokenFrom(
        await fetchImpl(
          DEFAULT_TOKEN_URI,
          form({
            grant_type: "refresh_token",
            client_id: file.client_id,
            client_secret: file.client_secret,
            refresh_token: file.refresh_token,
          }),
        ),
        "token for gcloud's application-default user credentials",
        now,
      ),
    now,
  );
}

/** Access tokens from the metadata server: on GKE with Workload Identity, the token of the
 * Google service account the pod's Kubernetes service account is bound to; on Compute Engine,
 * Cloud Run and the like, the instance's. `GCE_METADATA_HOST` overrides the host. */
export function metadataServerToken(
  env: Readonly<Record<string, string | undefined>>,
  options: TokenOptions = {},
): () => Promise<string> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const host = env.GCE_METADATA_HOST ?? env.GCE_METADATA_IP ?? "metadata.google.internal";
  const timeout = options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS;
  const url = `http://${host}/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(GCS_SCOPE)}`;
  return renewing(async () => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "metadata-flavor": "Google" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new StoreError(
        `no Google credentials: the metadata server (${host}) did not answer within ${timeout / 1000} s. Give a service account key ([store] credentials.service_account_key or GOOGLE_APPLICATION_CREDENTIALS), run gcloud auth application-default login, or run on GKE with Workload Identity`,
        err,
      );
    }
    return tokenFrom(response, `token from the metadata server (${host})`, now);
  }, now);
}

/** Where gcloud keeps application-default credentials. */
function wellKnownFile(env: Readonly<Record<string, string | undefined>>): string {
  if (env.CLOUDSDK_CONFIG) return join(env.CLOUDSDK_CONFIG, "application_default_credentials.json");
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "gcloud", "application_default_credentials.json");
  }
  return join(env.HOME ?? homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/** Application Default Credentials, in Google's order: the file `GOOGLE_APPLICATION_CREDENTIALS`
 * names, else gcloud's well-known file, else the metadata server (GKE Workload Identity, GCE).
 * A file is read now, so a bad path fails at once; the metadata server is asked on first use. */
export function applicationDefaultToken(
  env: Readonly<Record<string, string | undefined>>,
  options: TokenOptions & {
    read?: (path: string) => string;
    exists?: (path: string) => boolean;
  } = {},
): () => Promise<string> {
  const read = options.read ?? ((path: string) => readFileSync(path, "utf8"));
  const exists = options.exists ?? existsSync;
  const named = env.GOOGLE_APPLICATION_CREDENTIALS;
  const path = named || (exists(wellKnownFile(env)) ? wellKnownFile(env) : undefined);
  if (path) {
    let text: string;
    try {
      text = read(path);
    } catch (err) {
      throw new StoreError(`cannot read Google credentials ${path}`, err);
    }
    return credentialsFileToken(parseCredentialsFile(text, path), options);
  }
  return metadataServerToken(env, options);
}
