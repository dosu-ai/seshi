/** The body of `POST /otlp/v1/traces`, under the OTLP caps (F4.1, `[limits]`):
 *
 * - `limits.max_otlp_bytes` (64 MiB) on the wire. A `Content-Length` past it is refused before
 *   anything is read; otherwise the body is read as a stream and refused at the first chunk past
 *   it, so a chunked body is never held whole first.
 * - `limits.max_otlp_inflated_bytes` (256 MiB) after gunzip. A gzipped body is inflated as a
 *   stream while it arrives and stopped at the first chunk past the cap, so a small body that
 *   inflates to gigabytes (a gzip bomb) costs the cap, not what it would inflate to.
 *
 * Past either cap the request is answered 413 with a message naming the key. */

import { createGunzip } from "node:zlib";

/** A refused body: the receiver answers it with `status`. */
export class OtlpBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OtlpBodyError";
  }
}

export interface OtlpBodyCaps {
  /** `limits.max_otlp_bytes`. */
  wire: number;
  /** `limits.max_otlp_inflated_bytes`. */
  inflated: number;
}

function tooLarge(key: string, max: number, what: string): OtlpBodyError {
  return new OtlpBodyError(
    413,
    "too_large",
    `${what} exceeds limits.${key} (${max} bytes); send smaller export batches`,
  );
}

/** Reads `stream` whole, refusing it at the first chunk that takes it past `max`. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  refuse: () => OtlpBodyError,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      throw refuse();
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** `stream` gunzipped, read a chunk at a time and each chunk inflated before the next is read.
 * Refused at the first chunk sent past `caps.wire` or inflated past `caps.inflated`: inflating
 * stops there, and the rest of the body is never read. */
async function inflateCapped(
  stream: ReadableStream<Uint8Array>,
  caps: OtlpBodyCaps,
): Promise<Uint8Array> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let length = 0;
  let failed: Error | undefined;
  gunzip.on("data", (chunk: Buffer) => {
    if (failed) return;
    length += chunk.length;
    if (length > caps.inflated) {
      failed = tooLarge("max_otlp_inflated_bytes", caps.inflated, "inflated request body");
      gunzip.destroy();
    } else {
      chunks.push(chunk);
    }
  });
  gunzip.on("error", (err) => {
    failed ??= err;
  });
  const closed = new Promise<void>((resolve) => gunzip.on("close", () => resolve()));
  const reader = stream.getReader();
  let sent = 0;
  for (;;) {
    if (failed) break;
    const { value, done } = await reader.read();
    if (done) break;
    sent += value.byteLength;
    if (sent > caps.wire) {
      failed = tooLarge("max_otlp_bytes", caps.wire, "request body");
      break;
    }
    // Inflated, and counted, before the next chunk is read. A destroyed stream never calls
    // back, so `close` ends the wait too.
    await Promise.race([new Promise((resolve) => gunzip.write(value, resolve)), closed]);
  }
  if (failed) {
    gunzip.destroy();
    await reader.cancel().catch(() => {});
  } else {
    gunzip.end();
  }
  await closed;
  if (failed instanceof OtlpBodyError) throw failed;
  if (failed) throw new OtlpBodyError(400, "bad_encoding", "body is not valid gzip");
  return new Uint8Array(Buffer.concat(chunks, length));
}

/** The request's body, gunzipped when sent gzipped, within `caps` (see the module comment).
 * Throws `OtlpBodyError`: 413 past a cap, 400 for a body that is not gzip, 415 for another
 * `Content-Encoding`. */
export async function readOtlpBody(request: Request, caps: OtlpBodyCaps): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > caps.wire) {
    throw tooLarge("max_otlp_bytes", caps.wire, "request body");
  }
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  const gzip = encoding === "gzip" || encoding === "x-gzip";
  if (encoding && encoding !== "identity" && !gzip) {
    throw new OtlpBodyError(
      415,
      "unsupported_encoding",
      `Content-Encoding ${encoding} not supported`,
    );
  }
  const body = request.body;
  if (!body) return new Uint8Array();
  if (!gzip) {
    return readCapped(body, caps.wire, () => tooLarge("max_otlp_bytes", caps.wire, "request body"));
  }
  return inflateCapped(body, caps);
}
