import type { Fetch } from "@seshi/model";
import { BucketHttpError } from "./http-error";
import type { FetchedObject, ListedObject } from "./s3-fetch";
import { encodeKeyPath, uriEncode } from "./sigv4";
import { quote, unquote, xmlValues } from "./wire";

/** The Blob service version every request asks for. 2023-05-03 is the first with `startFrom`
 * on List Blobs, which `listObjects` needs to start after a key the way S3's `start-after`
 * does. */
export const AZURE_API_VERSION = "2023-11-03";

/** How a request to the Blob service proves who it is:
 *
 * - `accountKey`: the storage account's shared key; every request is signed (Shared Key).
 * - `sasToken`: a shared access signature, sent as the query string of every request.
 * - `token`: a Microsoft Entra access token for `https://storage.azure.com/`, sent as a bearer
 *   token (workload identity, `azure-identity.ts`); asked for before each request, so it can be
 *   renewed. */
export type AzureCredentials =
  | { accountKey: string }
  | { sasToken: string }
  | { token: () => Promise<string> };

export interface FetchAzureBlobOptions {
  /** The storage account's name. Shared Key signs with it. */
  account: string;
  container: string;
  /** The account's blob endpoint, `https://<account>.blob.core.windows.net` by default. For
   * Azurite and other path-style endpoints the account is part of it:
   * `http://127.0.0.1:10000/devstoreaccount1`. */
  endpoint?: string;
  credentials: AzureCredentials;
  fetch?: Fetch;
  /** The request time Shared Key signs; now by default. */
  now?: () => Date;
}

export class AzureHttpError extends BucketHttpError {
  constructor(status: number, code: string | undefined, message: string) {
    super(status, code, message);
    this.name = "AzureHttpError";
  }
}

const encoder = new TextEncoder();
/** List Blobs answers at most this many per page. */
const MAX_RESULTS = 5000;

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

/** The Shared Key `Authorization` header for a request (Blob service, version 2009-09-19 and
 * later): an HMAC-SHA256, under the base64-decoded account key, of the method, the standard
 * headers in their fixed order, the `x-ms-*` headers and the resource. `headers` are lowercase
 * and are what is sent; `contentLength` is the body's (0 or none signs as empty). */
export async function sharedKeyAuthorization(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  contentLength: number;
  account: string;
  accountKey: string;
}): Promise<string> {
  const { method, url, headers, contentLength, account } = input;
  const standard = [
    "content-encoding",
    "content-language",
    "content-length",
    "content-md5",
    "content-type",
    "date",
    "if-modified-since",
    "if-match",
    "if-none-match",
    "if-unmodified-since",
    "range",
  ].map((name) =>
    name === "content-length"
      ? contentLength > 0
        ? String(contentLength)
        : ""
      : (headers[name] ?? ""),
  );
  const msHeaders = Object.entries(headers)
    .filter(([name]) => name.startsWith("x-ms-"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
  const params = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    const lower = name.toLowerCase();
    params.set(lower, [...(params.get(lower) ?? []), value]);
  }
  const query = [...params.keys()]
    .sort()
    .map((name) => `\n${name}:${(params.get(name) as string[]).sort().join(",")}`)
    .join("");
  const resource = `/${account}${url.pathname}${query}`;
  const toSign = `${method}\n${standard.join("\n")}\n${msHeaders}${resource}`;
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(input.accountKey, "base64") as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(toSign));
  return `SharedKey ${account}:${base64(signature)}`;
}

/** The Azure Blob Storage REST API over `fetch`, for one container: the same operations, with
 * the same shapes, as `FetchS3Client`, so a store or a source can sit on either. Conditional
 * writes and deletes are `If-Match` / `If-None-Match` as on S3; a failed condition is Azure's
 * 412 `ConditionNotMet`, or 409 `BlobAlreadyExists` for a create over an existing blob, thrown
 * as `AzureHttpError`. */
export class FetchAzureBlobClient {
  private readonly fetchImpl: Fetch;
  private readonly endpoint: string;

  constructor(private readonly options: FetchAzureBlobOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.endpoint = (
      options.endpoint ?? `https://${options.account}.blob.core.windows.net`
    ).replace(/\/+$/, "");
  }

  private url(key: string | undefined, query: Record<string, string | undefined> = {}): URL {
    const container = uriEncode(this.options.container);
    const url = new URL(
      `${this.endpoint}/${container}${key === undefined ? "" : `/${encodeKeyPath(key)}`}`,
    );
    // Percent-encoded, never `+` for a space (`URLSearchParams`' form encoding): the Blob
    // service reads a `+` in the query as itself.
    url.search = Object.entries(query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
      .join("&");
    return url;
  }

  private async send(
    method: string,
    url: URL,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
    extra: { decompress?: false } = {},
  ): Promise<Response> {
    const { credentials } = this.options;
    const headers: Record<string, string> = {
      ...extraHeaders,
      "x-ms-date": (this.options.now?.() ?? new Date()).toUTCString(),
      "x-ms-version": AZURE_API_VERSION,
    };
    if ("sasToken" in credentials) {
      // As issued: its signature is over these exact values.
      const sas = credentials.sasToken.replace(/^\?/, "");
      url.search = url.search ? `${url.search}&${sas}` : `?${sas}`;
    } else if ("token" in credentials) {
      headers.authorization = `Bearer ${await credentials.token()}`;
    } else {
      headers.authorization = await sharedKeyAuthorization({
        method,
        url,
        headers,
        contentLength: body?.length ?? 0,
        account: this.options.account,
        accountKey: credentials.accountKey,
      });
    }
    try {
      return await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(body ? { body: body as BodyInit } : {}),
        // Bun's fetch option: hand over a `Content-Encoding` body as stored, not decoded.
        ...extra,
      } as RequestInit);
    } catch (err) {
      if (!("sasToken" in credentials)) throw err;
      // A network error may carry the URL, and with it the SAS signature: say what failed
      // without the query string, and leave the original (and its URL) behind.
      const message = (err instanceof Error ? err.message : String(err)).replace(
        /([?&]sig=)[^&\s"']*/gi,
        "$1[redacted]",
      );
      throw new Error(`${method} ${url.origin}${url.pathname}: ${message}`);
    }
  }

  private async fail(method: string, key: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    const code = response.headers.get("x-ms-error-code") ?? xmlValues(text, "Code")[0];
    const message = xmlValues(text, "Message")[0]?.split("\n")[0];
    throw new AzureHttpError(
      response.status,
      code ?? undefined,
      `${method} ${this.options.container}/${key}: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
  }

  /** A 404 for the blob, as opposed to the container: a missing container is an error, not an
   * empty store. */
  private static blobMissing(response: Response): boolean {
    return (
      response.status === 404 && response.headers.get("x-ms-error-code") !== "ContainerNotFound"
    );
  }

  /** Create the container; one that already exists is not an error. For tests and set-up:
   * the store itself never creates its container. */
  async createContainer(): Promise<void> {
    const response = await this.send("PUT", this.url(undefined, { restype: "container" }));
    if (!response.ok && response.headers.get("x-ms-error-code") !== "ContainerAlreadyExists") {
      return this.fail("CREATE", "", response);
    }
    await response.body?.cancel();
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const response = await this.send("GET", this.url(key));
    if (FetchAzureBlobClient.blobMissing(response)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return this.fail("GET", key, response);
    const etag = unquote(response.headers.get("etag")) ?? "";
    return { body: new Uint8Array(await response.arrayBuffer()), etag };
  }

  /** Put Blob (a block blob, in one request), with `If-Match` / `If-None-Match` when given. */
  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    condition: { ifMatch?: string; ifNoneMatch?: "*" } = {},
  ): Promise<{ etag?: string }> {
    const headers: Record<string, string> = {
      "content-type": contentType,
      "x-ms-blob-type": "BlockBlob",
    };
    if (condition.ifMatch !== undefined) headers["if-match"] = quote(condition.ifMatch);
    if (condition.ifNoneMatch !== undefined) headers["if-none-match"] = condition.ifNoneMatch;
    const response = await this.send("PUT", this.url(key), body, headers);
    if (!response.ok) return this.fail("PUT", key, response);
    await response.body?.cancel();
    const etag = unquote(response.headers.get("etag"));
    return etag ? { etag } : {};
  }

  async head(key: string): Promise<{ size: number; etag?: string; modified?: string } | null> {
    const response = await this.send("HEAD", this.url(key));
    if (FetchAzureBlobClient.blobMissing(response)) return null;
    if (!response.ok) return this.fail("HEAD", key, response);
    const etag = unquote(response.headers.get("etag"));
    const at = Date.parse(response.headers.get("last-modified") ?? "");
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      ...(etag ? { etag } : {}),
      ...(Number.isFinite(at) ? { modified: new Date(at).toISOString() } : {}),
    };
  }

  /** Delete Blob, with its snapshots (seshi makes none, but a blob with some cannot be deleted
   * alone). A blob that is not there is not an error. */
  async delete(key: string, condition: { ifMatch?: string } = {}): Promise<void> {
    const headers: Record<string, string> = { "x-ms-delete-snapshots": "include" };
    if (condition.ifMatch !== undefined) headers["if-match"] = quote(condition.ifMatch);
    const response = await this.send("DELETE", this.url(key), undefined, headers);
    if (!response.ok && !FetchAzureBlobClient.blobMissing(response)) {
      return this.fail("DELETE", key, response);
    }
    await response.body?.cancel();
  }

  /** Blobs under `prefix`, after `startAfter` (exclusive, as S3's `start-after`), at most
   * `maxKeys`. List Blobs' `startFrom` is inclusive, so a page asks for one more and drops the
   * key itself; pages are followed by their marker until `maxKeys` are found or the listing
   * ends, so a service that ignores `startFrom` gives the same answer, more slowly. Names come
   * back in UTF-16 code-unit order, which is JavaScript's string order. */
  async listObjects(options: {
    prefix: string;
    maxKeys: number;
    startAfter?: string;
  }): Promise<{ objects: ListedObject[]; truncated: boolean }> {
    const { prefix, maxKeys, startAfter } = options;
    const objects: ListedObject[] = [];
    let marker: string | undefined;
    for (;;) {
      const want = maxKeys - objects.length + (startAfter === undefined ? 0 : 1);
      const url = this.url(undefined, {
        restype: "container",
        comp: "list",
        prefix: prefix || undefined,
        maxresults: String(Math.min(MAX_RESULTS, Math.max(1, want))),
        marker,
        startFrom: startAfter !== undefined && marker === undefined ? startAfter : undefined,
      });
      const response = await this.send("GET", url);
      if (!response.ok) return this.fail("LIST", prefix, response);
      const xml = await response.text();
      for (const blob of xmlValues(xml, "Blob")) {
        const key = xmlValues(blob, "Name")[0];
        if (key === undefined || (startAfter !== undefined && key <= startAfter)) continue;
        const size = Number(xmlValues(blob, "Content-Length")[0] ?? 0);
        const etag = unquote(xmlValues(blob, "Etag")[0] ?? null) ?? "";
        const at = Date.parse(xmlValues(blob, "Last-Modified")[0] ?? "");
        objects.push({
          key,
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          etag,
          ...(Number.isFinite(at) ? { last_modified: new Date(at).toISOString() } : {}),
        });
      }
      marker = xmlValues(xml, "NextMarker")[0] || undefined;
      if (objects.length > maxKeys) {
        objects.length = maxKeys;
        return { objects, truncated: true };
      }
      if (objects.length === maxKeys || marker === undefined) {
        return { objects, truncated: marker !== undefined };
      }
    }
  }

  /** Get Blob, or the part of it from byte `start` (`x-ms-range`), only while its ETag is still
   * `ifMatch` when given: as `FetchS3Client.getObject`. A changed blob is 412; a `start` past
   * its end 416. User metadata (`x-ms-meta-*`) comes back with its prefix removed. */
  async getObject(
    key: string,
    options: { start?: number; ifMatch?: string } = {},
  ): Promise<FetchedObject | null> {
    const headers: Record<string, string> = {};
    if (options.start !== undefined && options.start > 0) {
      headers["x-ms-range"] = `bytes=${options.start}-`;
    }
    if (options.ifMatch !== undefined) headers["if-match"] = quote(options.ifMatch);
    const response = await this.send("GET", this.url(key), undefined, headers, {
      decompress: false,
    });
    if (FetchAzureBlobClient.blobMissing(response)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return this.fail("GET", key, response);
    const body = new Uint8Array(await response.arrayBuffer());
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("x-ms-meta-")) metadata[lower.slice("x-ms-meta-".length)] = value;
    });
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
