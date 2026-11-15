/** S3's object API over `fetch` and SigV4, for runtimes without `Bun.S3Client` (Node). Keys
 * here are full bucket keys; `S3Store` adds its prefix. Virtual-hosted style against AWS,
 * path style against an explicit endpoint (R2, MinIO and most S3-compatible stores). */

import type { Fetch } from "@seshi/model";
import { encodeKeyPath, type SigningCredentials, sha256Hex, signRequest, uriEncode } from "./sigv4";

export interface FetchS3Options {
  bucket: string;
  region: string;
  /** `https://host[:port]`; absent for AWS, where the host is `<bucket>.s3.<region>.amazonaws.com`. */
  endpoint?: string;
  credentials: SigningCredentials;
  fetch?: Fetch;
}

/** An S3 answer that was not a success, with S3's error `Code` when the body carried one. */
export class S3HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "S3HttpError";
  }
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(decodeXml(m[1] as string));
  return out;
}

/** An ETag header without its quotes (and a weak `W/` prefix); undefined when absent. */
function unquote(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** An ETag as a conditional header wants it: quoted. */
function quote(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

export class FetchS3Client {
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: FetchS3Options) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private url(key: string, query: Record<string, string | undefined> = {}): URL {
    const { bucket, region, endpoint } = this.options;
    const path = key ? `/${encodeKeyPath(key)}` : "/";
    const base = endpoint
      ? `${endpoint.replace(/\/+$/, "")}/${uriEncode(bucket)}${path}`
      : `https://${bucket}.s3.${region}.amazonaws.com${path}`;
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    return url;
  }

  private async send(
    method: string,
    url: URL,
    body?: Uint8Array,
    headers: Record<string, string> = {},
    extra: { decompress?: false } = {},
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers,
      payloadHash: body ? await sha256Hex(body) : undefined,
      region: this.options.region,
      credentials: this.options.credentials,
    });
    return this.fetchImpl(url.toString(), {
      method,
      headers: signed,
      ...(body ? { body: body as BodyInit } : {}),
      // Bun's fetch option: hand over a `Content-Encoding` body as stored, not decoded.
      ...extra,
    } as RequestInit);
  }

  private static async fail(method: string, key: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    const code = xmlValues(text, "Code")[0];
    const message = xmlValues(text, "Message")[0];
    throw new S3HttpError(
      response.status,
      code,
      `${method} ${key || "/"}: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const response = await this.send("GET", this.url(key));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return FetchS3Client.fail("GET", key, response);
    const etag = unquote(response.headers.get("etag")) ?? "";
    return { body: new Uint8Array(await response.arrayBuffer()), etag };
  }

  /** PUT, with `If-Match` / `If-None-Match` when given (S3 and R2 honour both on PUT); a
   * failed condition is a 412 (or S3's 409 `ConditionalRequestConflict` when two conditional
   * writes race), thrown as `S3HttpError`. */
  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    condition: { ifMatch?: string; ifNoneMatch?: "*" } = {},
  ): Promise<{ etag?: string }> {
    const headers: Record<string, string> = { "content-type": contentType };
    if (condition.ifMatch !== undefined) headers["if-match"] = quote(condition.ifMatch);
    if (condition.ifNoneMatch !== undefined) headers["if-none-match"] = condition.ifNoneMatch;
    const response = await this.send("PUT", this.url(key), body, headers);
    if (!response.ok) return FetchS3Client.fail("PUT", key, response);
    await response.body?.cancel();
    const etag = unquote(response.headers.get("etag"));
    return etag ? { etag } : {};
  }

  async head(key: string): Promise<{ size: number; etag?: string } | null> {
    const response = await this.send("HEAD", this.url(key));
    if (response.status === 404) return null;
    if (!response.ok) return FetchS3Client.fail("HEAD", key, response);
    const etag = unquote(response.headers.get("etag"));
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      ...(etag ? { etag } : {}),
    };
  }

  /** DELETE, with `If-Match` when given. Which S3-compatible backends honour it on DELETE is
   * still to check (X6.5); one that ignores it deletes unconditionally. */
  async delete(key: string, condition: { ifMatch?: string } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (condition.ifMatch !== undefined) headers["if-match"] = quote(condition.ifMatch);
    const response = await this.send("DELETE", this.url(key), undefined, headers);
    if (!response.ok && response.status !== 404) {
      return FetchS3Client.fail("DELETE", key, response);
    }
    await response.body?.cancel();
  }

  async list(options: {
    prefix: string;
    maxKeys: number;
    startAfter?: string;
  }): Promise<{ keys: string[]; truncated: boolean }> {
    const url = this.url("", {
      "list-type": "2",
      prefix: options.prefix,
      "max-keys": String(options.maxKeys),
      "start-after": options.startAfter,
    });
    const response = await this.send("GET", url);
    if (!response.ok) return FetchS3Client.fail("LIST", options.prefix, response);
    const xml = await response.text();
    const keys = xmlValues(xml, "Contents").flatMap((c) => xmlValues(c, "Key"));
    return { keys, truncated: xmlValues(xml, "IsTruncated")[0] === "true" };
  }

  /** One page of ListObjectsV2 with what each object is: its size, ETag and last change, so a
   * poller can tell a new or changed object from the listing alone (F6.2). Pages continue
   * with `startAfter` (the last key of the page before) or S3's `continuationToken`. */
  async listObjects(options: {
    prefix: string;
    maxKeys: number;
    startAfter?: string;
    continuationToken?: string;
  }): Promise<ObjectListing> {
    const url = this.url("", {
      "list-type": "2",
      prefix: options.prefix,
      "max-keys": String(options.maxKeys),
      "start-after": options.startAfter,
      "continuation-token": options.continuationToken,
    });
    const response = await this.send("GET", url);
    if (!response.ok) return FetchS3Client.fail("LIST", options.prefix, response);
    const xml = await response.text();
    const objects: ListedObject[] = [];
    for (const contents of xmlValues(xml, "Contents")) {
      const key = xmlValues(contents, "Key")[0];
      if (key === undefined) continue;
      const size = Number(xmlValues(contents, "Size")[0] ?? 0);
      const etag = unquote(xmlValues(contents, "ETag")[0] ?? null) ?? "";
      const modified = xmlValues(contents, "LastModified")[0];
      objects.push({
        key,
        size: Number.isFinite(size) && size >= 0 ? size : 0,
        etag,
        ...(modified ? { last_modified: modified } : {}),
      });
    }
    const next = xmlValues(xml, "NextContinuationToken")[0];
    return {
      objects,
      truncated: xmlValues(xml, "IsTruncated")[0] === "true",
      ...(next ? { next_token: next } : {}),
    };
  }

  /** GET an object, or the part of it from byte `start` (a `Range` request), only while its
   * ETag is still `ifMatch` when given. Null when there is no object; a changed object is S3's
   * 412, thrown as `S3HttpError`. A backend that ignores `Range` answers the whole object
   * (status 200, `start` 0), which the caller handles the same way. The object's user
   * metadata (`x-amz-meta-*`) comes back with its prefix removed and names lower-cased. The
   * body is the bytes as stored: a `Content-Encoding` is reported, not undone (Bun's fetch
   * would otherwise inflate it without limit). */
  async getObject(
    key: string,
    options: { start?: number; ifMatch?: string } = {},
  ): Promise<FetchedObject | null> {
    const headers: Record<string, string> = {};
    if (options.start !== undefined && options.start > 0) {
      headers.range = `bytes=${options.start}-`;
    }
    if (options.ifMatch !== undefined) headers["if-match"] = quote(options.ifMatch);
    // Not decoded by fetch: a small object stored with `Content-Encoding: gzip` could inflate
    // without bound before anyone checked its size. The caller unzips with a limit.
    const response = await this.send("GET", this.url(key), undefined, headers, {
      decompress: false,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return FetchS3Client.fail("GET", key, response);
    const body = new Uint8Array(await response.arrayBuffer());
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("x-amz-meta-")) metadata[lower.slice("x-amz-meta-".length)] = value;
    });
    // `Content-Range: bytes <first>-<last>/<total>` on a 206.
    const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
    const partial = response.status === 206 && range !== null;
    const start = partial ? Number(range[1]) : 0;
    const total = partial && range[2] !== "*" ? Number(range[2]) : start + body.length;
    const encoding = response.headers.get("content-encoding");
    return {
      body,
      etag: unquote(response.headers.get("etag")) ?? "",
      start,
      size: total,
      metadata,
      ...(encoding ? { content_encoding: encoding } : {}),
    };
  }
}

/** One object in a listing. */
export interface ListedObject {
  /** The full bucket key. */
  key: string;
  size: number;
  /** Unquoted. */
  etag: string;
  /** ISO 8601, as S3 reports it. */
  last_modified?: string;
}

/** A page of `listObjects`. */
export interface ObjectListing {
  objects: ListedObject[];
  truncated: boolean;
  /** S3's token for the next page, when it sent one. */
  next_token?: string;
}

/** What `getObject` read. */
export interface FetchedObject {
  /** The bytes from `start` to the end of the object. */
  body: Uint8Array;
  /** Unquoted. */
  etag: string;
  /** The offset of `body`'s first byte in the object: 0 unless a range was honoured. */
  start: number;
  /** The whole object's size. */
  size: number;
  /** User metadata, `x-amz-meta-` removed, names lower-cased. */
  metadata: Record<string, string>;
  content_encoding?: string;
}
