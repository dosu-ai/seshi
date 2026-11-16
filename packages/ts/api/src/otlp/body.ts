import { createGunzip } from "node:zlib";

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
  wire: number;
  inflated: number;
}

function tooLarge(key: string, max: number, what: string): OtlpBodyError {
  return new OtlpBodyError(
    413,
    "too_large",
    `${what} exceeds limits.${key} (${max} bytes); send smaller export batches`,
  );
}

export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  refuse: () => Error,
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

export interface InflateRefusals {
  wire: () => Error;
  inflated: () => Error;
  invalid: () => Error;
}

export async function inflateCapped(
  stream: ReadableStream<Uint8Array>,
  caps: OtlpBodyCaps,
  refuse: InflateRefusals,
): Promise<Uint8Array> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let length = 0;
  let refused: Error | undefined;
  let broken = false;
  let failed = false;
  gunzip.on("data", (chunk: Buffer) => {
    if (failed) return;
    length += chunk.length;
    if (length > caps.inflated) {
      refused = refuse.inflated();
      failed = true;
      gunzip.destroy();
    } else {
      chunks.push(chunk);
    }
  });
  gunzip.on("error", () => {
    broken = true;
    failed = true;
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
      refused = refuse.wire();
      failed = true;
      break;
    }
    await Promise.race([new Promise((resolve) => gunzip.write(value, resolve)), closed]);
  }
  if (failed) {
    gunzip.destroy();
    await reader.cancel().catch(() => {});
  } else {
    gunzip.end();
  }
  await closed;
  if (refused) throw refused;
  if (broken) throw refuse.invalid();
  return new Uint8Array(Buffer.concat(chunks, length));
}

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
  return inflateCapped(body, caps, {
    wire: () => tooLarge("max_otlp_bytes", caps.wire, "request body"),
    inflated: () => tooLarge("max_otlp_inflated_bytes", caps.inflated, "inflated request body"),
    invalid: () => new OtlpBodyError(400, "bad_encoding", "body is not valid gzip"),
  });
}
