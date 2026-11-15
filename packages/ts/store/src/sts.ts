/** AWS STS `AssumeRole` over `fetch` and SigV4, with no AWS SDK: how a poller reads a bucket
 * through a role the bucket's owner grants (F6.1, "a role to assume with an external ID"). The
 * temporary keys it returns sign S3 requests like static ones, with their session token. */

import type { Fetch } from "@seshi/model";
import { S3HttpError } from "./s3-fetch";
import { type SigningCredentials, sha256Hex, signRequest } from "./sigv4";

export interface AssumeRoleOptions {
  /** The role to assume (`arn:aws:iam::123456789012:role/seshi-read`). */
  roleArn: string;
  /** Names the session in the bucket owner's CloudTrail (`seshi-<source id>`). */
  sessionName: string;
  /** The external id the role's trust policy requires. */
  externalId?: string;
  /** How long the keys last, in seconds; 3600 by default (STS allows 900 to the role's max). */
  durationSeconds?: number;
  /** The keys that may assume the role. */
  credentials: SigningCredentials;
  /** The STS region; the regional endpoint is used when set, the global one otherwise. */
  region?: string;
  /** An explicit STS endpoint (`https://sts.example.test`), for tests and partitions. */
  endpoint?: string;
  fetch?: Fetch;
  now?: () => Date;
}

/** Temporary keys from STS, and when they stop working. */
export interface AssumedCredentials extends SigningCredentials {
  sessionToken: string;
  expiration: Date;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1]
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Call `AssumeRole` and return the role's temporary keys. A refusal (no permission, a wrong
 * external id) is an `S3HttpError` with STS's error code. */
export async function assumeRole(options: AssumeRoleOptions): Promise<AssumedCredentials> {
  const region = options.region ?? "us-east-1";
  const endpoint =
    options.endpoint ??
    (options.region ? `https://sts.${options.region}.amazonaws.com` : "https://sts.amazonaws.com");
  const url = new URL(`${endpoint.replace(/\/+$/, "")}/`);
  const form = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: options.roleArn,
    RoleSessionName: options.sessionName,
    DurationSeconds: String(options.durationSeconds ?? 3600),
  });
  if (options.externalId !== undefined) form.set("ExternalId", options.externalId);
  const body = new TextEncoder().encode(form.toString());
  const headers = await signRequest({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    payloadHash: await sha256Hex(body),
    region,
    credentials: options.credentials,
    service: "sts",
    ...(options.now ? { date: options.now() } : {}),
  });
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers,
    body: body as BodyInit,
  });
  const text = await response.text();
  if (!response.ok) {
    const code = xmlValue(text, "Code");
    const message = xmlValue(text, "Message");
    throw new S3HttpError(
      response.status,
      code,
      `AssumeRole ${options.roleArn}: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
  }
  const accessKeyId = xmlValue(text, "AccessKeyId");
  const secretAccessKey = xmlValue(text, "SecretAccessKey");
  const sessionToken = xmlValue(text, "SessionToken");
  const expiration = xmlValue(text, "Expiration");
  const expires = expiration ? new Date(expiration) : undefined;
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expires || Number.isNaN(+expires)) {
    throw new S3HttpError(response.status, undefined, "AssumeRole answered without credentials");
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiration: expires };
}
