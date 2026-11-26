import { readFileSync } from "node:fs";
import type { Fetch } from "@seshi/model";
import { type Renewable, renewAt, renewing } from "./renewing";
import type { SigningCredentials } from "./sigv4";
import { StoreError } from "./store";

/** The keys to sign the next request with: asked before each one, so they can be renewed. */
export type AwsCredentialSource = () => Promise<SigningCredentials>;

type Env = Readonly<Record<string, string | undefined>>;

/** Where ECS's agent serves a task's role credentials (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
 * is a path on it). */
const ECS_HOST = "http://169.254.170.2";
/** The hosts `AWS_CONTAINER_CREDENTIALS_FULL_URI` may name over plain HTTP, as the AWS SDKs
 * allow: ECS's agent, EKS Pod Identity's agent (IPv4 and IPv6), and the machine itself. */
const CONTAINER_HOSTS = new Set(["169.254.170.2", "169.254.170.23", "[fd00:ec2::23]", "localhost"]);
const IMDS_IPV4 = "http://169.254.169.254";
const IMDS_IPV6 = "http://[fd00:ec2::254]";
/** How long IMDS's session token lasts, in seconds; seshi asks for a new one each renewal. */
const IMDS_TOKEN_TTL = "21600";
/** How long ECS's or EKS's credentials agent has to answer. */
const CONTAINER_TIMEOUT_MS = 5000;
/** How long IMDS has to answer, as the AWS SDKs wait: off AWS its address may route nowhere,
 * and a CLI without keys would stall on every command. */
const IMDS_TIMEOUT_MS = 1000;
/** Why IMDS may not answer, said when it does not. */
const IMDS_HINT =
  "off EC2, give keys; in a container on EC2, the instance's metadata hop limit must be 2 or more";

/** Getting the role's keys failed. Not a `BucketHttpError`: the bucket never answered, so it
 * says nothing about what the bucket does (the storage test throws it on). */
export class AwsCredentialsError extends StoreError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "AwsCredentialsError";
  }
}

export interface AwsCredentialOptions {
  fetch?: Fetch;
  now?: () => Date;
  /** How long a credentials endpoint has to answer; 5 s for a container agent, 1 s for IMDS,
   * by default. */
  timeoutMs?: number;
  /** Reads `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`; `readFileSync` by default. */
  readFile?: (path: string) => string;
}

/** The JSON both ECS's agent and IMDS answer with. */
interface RoleCredentials {
  Code?: string;
  Message?: string;
  AccessKeyId?: unknown;
  SecretAccessKey?: unknown;
  Token?: unknown;
  Expiration?: unknown;
}

function parse(text: string, what: string, now: () => Date): Renewable<SigningCredentials> {
  let body: RoleCredentials;
  try {
    body = JSON.parse(text) as RoleCredentials;
  } catch {
    throw new AwsCredentialsError(`${what}: the answer is not JSON`);
  }
  if (body.Code !== undefined && body.Code !== "Success") {
    throw new AwsCredentialsError(
      `${what}: ${body.Code}${body.Message ? `: ${body.Message}` : ""}`,
    );
  }
  const { AccessKeyId, SecretAccessKey, Token, Expiration } = body;
  if (typeof AccessKeyId !== "string" || typeof SecretAccessKey !== "string") {
    throw new AwsCredentialsError(`${what}: no AccessKeyId and SecretAccessKey in the answer`);
  }
  const credentials: SigningCredentials = {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    ...(typeof Token === "string" && Token ? { sessionToken: Token } : {}),
  };
  const at = now().getTime();
  const expires = typeof Expiration === "string" ? Date.parse(Expiration) : Number.NaN;
  // Keys without an expiry are kept for an hour, then asked for again.
  const lifetime = Number.isFinite(expires) ? expires - at : 60 * 60 * 1000;
  return { value: credentials, renewAt: renewAt(at, lifetime) };
}

async function call(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  what: string,
  timeout: number,
  hint?: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const host = new URL(url).host;
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const failure = timedOut
      ? `${host} did not answer within ${timeout / 1000} s`
      : `could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`;
    throw new AwsCredentialsError(`${what}: ${failure}${hint ? ` (${hint})` : ""}`, err);
  }
}

async function text(response: Response, what: string): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new AwsCredentialsError(
      `${what}: ${response.status}${body ? `: ${body.trim().slice(0, 200)}` : ""}`,
    );
  }
  return body;
}

function containerUrl(env: Env): string | undefined {
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (relative) return `${ECS_HOST}${relative.startsWith("/") ? "" : "/"}${relative}`;
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (!full) return undefined;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    throw new StoreError(`AWS_CONTAINER_CREDENTIALS_FULL_URI is not a URL: ${full}`);
  }
  const loopback = /^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(CONTAINER_HOSTS.has(url.hostname) || loopback)) {
    throw new StoreError(
      `AWS_CONTAINER_CREDENTIALS_FULL_URI must be https, or http to ECS's or EKS's credentials agent or this machine: ${full}`,
    );
  }
  return full;
}

/** The role credentials of an ECS task (Fargate or EC2), or an EKS pod with Pod Identity:
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, else `AWS_CONTAINER_CREDENTIALS_FULL_URI` with the
 * token in `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` (read each time; EKS rotates it) or
 * `AWS_CONTAINER_AUTHORIZATION_TOKEN`. Undefined when neither URI is set. */
export function containerCredentials(
  env: Env,
  options: AwsCredentialOptions = {},
): AwsCredentialSource | undefined {
  const url = containerUrl(env);
  if (!url) return undefined;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const timeout = options.timeoutMs ?? CONTAINER_TIMEOUT_MS;
  const what = "the task role's credentials (ECS)";
  return renewing(async () => {
    const tokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
    let token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (tokenFile) {
      try {
        token = readFile(tokenFile).trim();
      } catch (err) {
        throw new AwsCredentialsError(
          `cannot read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ${tokenFile}`,
          err,
        );
      }
    }
    const response = await call(
      fetchImpl,
      url,
      { headers: token ? { authorization: token } : {} },
      what,
      timeout,
    );
    return parse(await text(response, what), what, now);
  }, now);
}

/** The role credentials of an EC2 instance's profile, from IMDSv2: a session token, the role's
 * name, then its keys. `AWS_EC2_METADATA_SERVICE_ENDPOINT` (or `_ENDPOINT_MODE=IPv6`) moves it;
 * `AWS_EC2_METADATA_DISABLED=true` turns it off (undefined). */
export function instanceCredentials(
  env: Env,
  options: AwsCredentialOptions = {},
): AwsCredentialSource | undefined {
  if (env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === "true") return undefined;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const timeout = options.timeoutMs ?? IMDS_TIMEOUT_MS;
  const root = (
    env.AWS_EC2_METADATA_SERVICE_ENDPOINT ||
    (env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE?.toLowerCase() === "ipv6" ? IMDS_IPV6 : IMDS_IPV4)
  ).replace(/\/+$/, "");
  const what = "the instance role's credentials (EC2 instance metadata)";
  return renewing(async () => {
    const session = (
      await text(
        await call(
          fetchImpl,
          `${root}/latest/api/token`,
          { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": IMDS_TOKEN_TTL } },
          what,
          timeout,
          IMDS_HINT,
        ),
        what,
      )
    ).trim();
    const headers = { "x-aws-ec2-metadata-token": session };
    const base = `${root}/latest/meta-data/iam/security-credentials/`;
    const listed = await call(fetchImpl, base, { headers }, what, timeout);
    if (listed.status === 404) {
      await listed.body?.cancel();
      throw new AwsCredentialsError(`${what}: the instance has no IAM role (instance profile)`);
    }
    const role = (await text(listed, what)).split("\n")[0]?.trim();
    if (!role) throw new AwsCredentialsError(`${what}: the instance has no IAM role`);
    // As listed: IAM role names are letters, digits and `+=,.@_-`, all fine in a URL path.
    const response = await call(fetchImpl, `${base}${role}`, { headers }, what, timeout);
    return parse(await text(response, what), `${what} for ${role}`, now);
  }, now);
}

/** Whether `endpoint` is AWS's own: absent, or a host under `amazonaws.com` (or
 * `amazonaws.com.cn`), which takes in regional, FIPS, dual-stack and VPC endpoints. A role's
 * keys are for AWS; an S3-compatible service is given keys of its own. */
export function isAwsEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    return /(^|\.)amazonaws\.com(\.cn)?$/.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/** Where the AWS SDKs find a role's keys when none are given as keys: an ECS task's (or EKS
 * Pod Identity's) container credentials, else EC2's instance metadata. Undefined when neither
 * applies (no container URI, and instance metadata turned off). Keys in `AWS_*` variables are
 * the caller's to check first, as the SDKs do.
 *
 * A profile (`AWS_PROFILE`) and a web identity (`AWS_WEB_IDENTITY_TOKEN_FILE`: EKS's IAM roles
 * for service accounts) come before both in the SDKs, and seshi cannot use either yet: they are
 * refused rather than passed over, since what comes after may be the instance's role, another
 * identity entirely. */
export function roleCredentials(
  env: Env,
  options: AwsCredentialOptions = {},
): AwsCredentialSource | undefined {
  const profile = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE;
  if (profile) {
    throw new StoreError(
      `AWS_PROFILE is set (${profile}), and seshi does not read profiles from ~/.aws yet: give keys (credentials, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), or unset it to use the ECS task's or EC2 instance's role`,
    );
  }
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    throw new StoreError(
      "AWS_WEB_IDENTITY_TOKEN_FILE is set (EKS IAM roles for service accounts), which seshi does not support yet: give keys, or use EKS Pod Identity",
    );
  }
  const container = containerCredentials(env, options);
  if (container) return container;
  const instance = instanceCredentials(env, options);
  if (!instance) return undefined;
  // The last place looked: when it fails, say what else would have done.
  return async () => {
    try {
      return await instance();
    } catch (err) {
      throw new AwsCredentialsError(
        `no keys (credentials, or AWS_* / S3_* in the environment) and no ECS task role, and ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    }
  };
}
