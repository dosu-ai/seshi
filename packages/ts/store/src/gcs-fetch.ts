import type { Fetch } from "@seshi/model";
import type { GcsTokenSource } from "./gcs-auth";
import { BucketHttpError } from "./http-error";
import type { FetchedObject, ListedObject } from "./s3-fetch";
import { uriEncode } from "./sigv4";

export const GCS_ENDPOINT = "https://storage.googleapis.com";

export interface FetchGcsOptions {
  bucket: string;
  /** `https://storage.googleapis.com` by default; an emulator's root otherwise
   * (`http://127.0.0.1:4443` for fake-gcs-server). */
  endpoint?: string;
  /** The bearer token for each request; none for an emulator. */
  token: GcsTokenSource;
  fetch?: Fetch;
}

/** A GCS JSON API answer that was not a success. `code` is the first error's `reason`
 * (`conditionNotMet`, `notFound`, `forbidden`…) when the body says. */
export class GcsHttpError extends BucketHttpError {
  constructor(status: number, code: string | undefined, message: string) {
    super(status, code, message);
    this.name = "GcsHttpError";
  }
}

/** The answer to a generation precondition that did not hold, made here: for an ETag that is no
 * generation, which no object can have, and for a read whose generation differs from the one
 * asked for (a service that ignores `ifGenerationMatch` on reads). */
function conditionNotMet(what: string): GcsHttpError {
  return new GcsHttpError(412, "conditionNotMet", `${what}: 412 conditionNotMet`);
}

/** A GCS generation, which is what this client reports as an object's ETag: a positive decimal
 * int64. */
function isGeneration(etag: string): boolean {
  return /^\d{1,19}$/.test(etag);
}

interface ObjectResource {
  name?: string;
  size?: string;
  generation?: string;
  updated?: string;
}

/** List pages are at most this long. */
const MAX_RESULTS = 1000;
const LIST_FIELDS = "items(name,size,generation,updated),nextPageToken";

/** The Cloud Storage JSON API over `fetch`, for one bucket: the same operations, with the same
 * shapes, as `FetchS3Client` and `FetchAzureBlobClient`, so a store or a source can sit on any
 * of them.
 *
 * GCS's conditions are on an object's generation, not its ETag (its XML API takes `If-Match`
 * only on reads), so this client reports the generation as the ETag and turns the conditions
 * into generation preconditions: `ifMatch` is `ifGenerationMatch=<generation>` and
 * `ifNoneMatch: "*"` is `ifGenerationMatch=0`. A failed one is GCS's 412 `conditionNotMet`,
 * thrown as `GcsHttpError`. */
export class FetchGcsClient {
  private readonly fetchImpl: Fetch;
  private readonly endpoint: string;

  constructor(private readonly options: FetchGcsOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.endpoint = (options.endpoint ?? GCS_ENDPOINT).replace(/\/+$/, "");
  }

  private url(path: string, query: Record<string, string | undefined> = {}): string {
    const search = Object.entries(query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
      .join("&");
    return `${this.endpoint}${path}${search ? `?${search}` : ""}`;
  }

  private objectPath(key: string): string {
    return `/storage/v1/b/${uriEncode(this.options.bucket)}/o/${uriEncode(key)}`;
  }

  private async send(
    method: string,
    url: string,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
    extra: { decompress?: false } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    const { token } = this.options;
    if (token) headers.authorization = `Bearer ${await token()}`;
    return this.fetchImpl(url, {
      method,
      headers,
      ...(body ? { body: body as BodyInit } : {}),
      // Bun's fetch option: hand over a `Content-Encoding` body as stored, not decoded.
      ...extra,
    } as RequestInit);
  }

  private async fail(method: string, key: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = JSON.parse(text) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      code = body.error?.errors?.[0]?.reason;
      message = body.error?.message;
    } catch {
      message = text.trim().split("\n")[0] || undefined;
    }
    throw new GcsHttpError(
      response.status,
      code,
      `${method} ${this.options.bucket}/${key}: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
  }

  /** A 404 for the object, as opposed to the bucket: a missing bucket is an error, not an empty
   * store. GCS says "The specified bucket does not exist." for the latter. */
  private static async objectMissing(response: Response): Promise<boolean> {
    if (response.status !== 404) return false;
    const text = await response
      .clone()
      .text()
      .catch(() => "");
    return !/bucket does not exist/i.test(text);
  }

  /** Create the bucket; one that already exists is not an error. For tests against an
   * emulator: the store itself never creates its bucket. */
  async createBucket(project = "seshi-test"): Promise<void> {
    const response = await this.send(
      "POST",
      this.url("/storage/v1/b", { project }),
      new TextEncoder().encode(JSON.stringify({ name: this.options.bucket })),
      { "content-type": "application/json" },
    );
    if (!response.ok && response.status !== 409) return this.fail("CREATE", "", response);
    await response.body?.cancel();
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const response = await this.send("GET", this.url(this.objectPath(key), { alt: "media" }));
    if (await FetchGcsClient.objectMissing(response)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return this.fail("GET", key, response);
    const etag = response.headers.get("x-goog-generation") ?? "";
    return { body: new Uint8Array(await response.arrayBuffer()), etag };
  }

  /** A simple (media) upload, with `ifGenerationMatch` for the conditions. */
  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    condition: { ifMatch?: string; ifNoneMatch?: "*" } = {},
  ): Promise<{ etag?: string }> {
    let generation: string | undefined;
    if (condition.ifNoneMatch !== undefined) generation = "0";
    if (condition.ifMatch !== undefined) {
      if (!isGeneration(condition.ifMatch))
        throw conditionNotMet(`PUT ${this.options.bucket}/${key}`);
      generation = condition.ifMatch;
    }
    const url = this.url(`/upload/storage/v1/b/${uriEncode(this.options.bucket)}/o`, {
      uploadType: "media",
      name: key,
      ifGenerationMatch: generation,
      fields: "generation",
    });
    const response = await this.send("POST", url, body, { "content-type": contentType });
    if (!response.ok) return this.fail("PUT", key, response);
    const resource = (await response.json().catch(() => ({}))) as ObjectResource;
    return resource.generation ? { etag: resource.generation } : {};
  }

  async head(key: string): Promise<{ size: number; etag?: string; modified?: string } | null> {
    const response = await this.send(
      "GET",
      this.url(this.objectPath(key), { fields: "size,generation,updated" }),
    );
    if (await FetchGcsClient.objectMissing(response)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return this.fail("HEAD", key, response);
    const resource = (await response.json()) as ObjectResource;
    const at = Date.parse(resource.updated ?? "");
    return {
      size: Number(resource.size ?? 0),
      ...(resource.generation ? { etag: resource.generation } : {}),
      ...(Number.isFinite(at) ? { modified: new Date(at).toISOString() } : {}),
    };
  }

  /** Delete the live version, only while it is generation `ifMatch` when given. An object that
   * is not there is not an error. */
  async delete(key: string, condition: { ifMatch?: string } = {}): Promise<void> {
    if (condition.ifMatch !== undefined && !isGeneration(condition.ifMatch)) {
      throw conditionNotMet(`DELETE ${this.options.bucket}/${key}`);
    }
    const response = await this.send(
      "DELETE",
      this.url(this.objectPath(key), { ifGenerationMatch: condition.ifMatch }),
    );
    if (!response.ok && !(await FetchGcsClient.objectMissing(response))) {
      return this.fail("DELETE", key, response);
    }
    await response.body?.cancel();
  }

  async list(options: {
    prefix: string;
    maxKeys: number;
    startAfter?: string;
  }): Promise<{ keys: string[]; truncated: boolean }> {
    const listing = await this.listObjects(options);
    return { keys: listing.objects.map((o) => o.key), truncated: listing.truncated };
  }

  /** Objects under `prefix`, after `startAfter` (exclusive, as S3's `start-after`), at most
   * `maxKeys`. `startOffset` is inclusive, so a page asks for one more and drops the key
   * itself; pages are followed by their token until `maxKeys` are found or the listing ends.
   * Names come back in lexicographic byte order. */
  async listObjects(options: {
    prefix: string;
    maxKeys: number;
    startAfter?: string;
  }): Promise<{ objects: ListedObject[]; truncated: boolean }> {
    const { prefix, maxKeys, startAfter } = options;
    const objects: ListedObject[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const want = maxKeys - objects.length + (startAfter === undefined ? 0 : 1);
      const url = this.url(`/storage/v1/b/${uriEncode(this.options.bucket)}/o`, {
        prefix: prefix || undefined,
        maxResults: String(Math.min(MAX_RESULTS, Math.max(1, want))),
        pageToken,
        startOffset: startAfter,
        fields: LIST_FIELDS,
      });
      const response = await this.send("GET", url);
      if (!response.ok) return this.fail("LIST", prefix, response);
      const page = (await response.json()) as { items?: ObjectResource[]; nextPageToken?: string };
      for (const item of page.items ?? []) {
        const key = item.name;
        if (key === undefined || (startAfter !== undefined && key <= startAfter)) continue;
        const size = Number(item.size ?? 0);
        const at = Date.parse(item.updated ?? "");
        objects.push({
          key,
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          etag: item.generation ?? "",
          ...(Number.isFinite(at) ? { last_modified: new Date(at).toISOString() } : {}),
        });
      }
      pageToken = page.nextPageToken || undefined;
      if (objects.length > maxKeys) {
        objects.length = maxKeys;
        return { objects, truncated: true };
      }
      if (objects.length === maxKeys || pageToken === undefined) {
        return { objects, truncated: pageToken !== undefined };
      }
    }
  }

  /** The object, or the part of it from byte `start` (`Range`), only while its generation is
   * still `ifMatch` when given: as `FetchS3Client.getObject`. A changed object is 412; a `start`
   * past its end 416. The bytes are as stored (`Accept-Encoding: gzip` turns off GCS's
   * decompressive transcoding), with `content_encoding` saying how. User metadata
   * (`x-goog-meta-*`) comes back with its prefix removed. */
  async getObject(
    key: string,
    options: { start?: number; ifMatch?: string } = {},
  ): Promise<FetchedObject | null> {
    const what = `GET ${this.options.bucket}/${key}`;
    if (options.ifMatch !== undefined && !isGeneration(options.ifMatch)) {
      throw conditionNotMet(what);
    }
    const headers: Record<string, string> = { "accept-encoding": "gzip" };
    if (options.start !== undefined && options.start > 0) {
      headers.range = `bytes=${options.start}-`;
    }
    const response = await this.send(
      "GET",
      this.url(this.objectPath(key), { alt: "media", ifGenerationMatch: options.ifMatch }),
      undefined,
      headers,
      { decompress: false },
    );
    if (await FetchGcsClient.objectMissing(response)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return this.fail("GET", key, response);
    const generation = response.headers.get("x-goog-generation") ?? "";
    if (options.ifMatch !== undefined && generation !== "" && generation !== options.ifMatch) {
      await response.body?.cancel();
      throw conditionNotMet(what);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("x-goog-meta-")) metadata[lower.slice("x-goog-meta-".length)] = value;
    });
    const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
    const partial = response.status === 206 && range !== null;
    const start = partial ? Number(range[1]) : 0;
    const total = partial && range[2] !== "*" ? Number(range[2]) : start + body.length;
    const encoding = response.headers.get("content-encoding");
    return {
      body,
      etag: generation,
      start,
      size: total,
      metadata,
      ...(encoding ? { content_encoding: encoding } : {}),
    };
  }
}
