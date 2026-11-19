import { createGzip, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { OtlpBodyError, readOtlpBody } from "./body";

const CAPS = { wire: 1000, inflated: 4000 };

function request(
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://seshi.test/otlp/v1/traces", {
    method: "POST",
    headers,
    body: body as BodyInit,
    // A stream body needs it; a byte body ignores it.
    duplex: "half",
  } as RequestInit);
}

/** A body sent as a stream in `size`-byte chunks, with no Content-Length (chunked), that
 * counts how many bytes the reader pulled. */
function streamed(bytes: Uint8Array, size = 64) {
  const pulled = { bytes: 0 };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.slice(at, at + size);
        at += chunk.length;
        pulled.bytes += chunk.length;
        controller.enqueue(chunk);
      },
    },
    // Nothing is pulled until the reader asks.
    { highWaterMark: 0 },
  );
  return { stream, pulled };
}

/** `bytes` gzipped: a gzip bomb when it is many zeros. */
async function gzipOf(total: number): Promise<Uint8Array> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise((resolve) => gzip.on("end", resolve));
  const block = Buffer.alloc(1024 * 1024);
  for (let left = total; left > 0; left -= block.length) {
    gzip.write(left >= block.length ? block : block.subarray(0, left));
  }
  gzip.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

async function refused(promise: Promise<unknown>): Promise<OtlpBodyError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OtlpBodyError);
    return err as OtlpBodyError;
  }
  throw new Error("expected the body to be refused");
}

describe("readOtlpBody", () => {
  it("takes a body of exactly limits.max_otlp_bytes and refuses one byte more, naming the key", async () => {
    const at = new Uint8Array(CAPS.wire).fill(1);
    expect(await readOtlpBody(request(at), CAPS)).toEqual(at);
    const over = new Uint8Array(CAPS.wire + 1).fill(1);
    const err = await refused(readOtlpBody(request(over), CAPS));
    expect(err.status).toBe(413);
    expect(err.message).toContain("limits.max_otlp_bytes");
    expect(err.message).toContain("smaller export batches");
  });

  it("refuses a declared Content-Length past the cap before reading anything", async () => {
    const { stream, pulled } = streamed(new Uint8Array(10));
    const err = await refused(
      readOtlpBody(request(stream, { "content-length": String(CAPS.wire + 1) }), CAPS),
    );
    expect(err.status).toBe(413);
    expect(err.message).toContain("limits.max_otlp_bytes");
    expect(pulled.bytes).toBe(0);
  });

  it("stops reading a chunked body at the first chunk past the cap", async () => {
    const { stream, pulled } = streamed(new Uint8Array(100_000), 100);
    const err = await refused(readOtlpBody(request(stream), CAPS));
    expect(err.status).toBe(413);
    expect(err.message).toContain("limits.max_otlp_bytes");
    // The cap and a chunk or two in flight, never the whole body.
    expect(pulled.bytes).toBeLessThan(CAPS.wire + 1000);
  });

  it("inflates a gzipped body to exactly limits.max_otlp_inflated_bytes, and refuses one byte more", async () => {
    const at = new Uint8Array(CAPS.inflated).fill(7);
    expect(await readOtlpBody(request(gzipSync(at), { "content-encoding": "gzip" }), CAPS)).toEqual(
      at,
    );
    const over = new Uint8Array(CAPS.inflated + 1).fill(7);
    const err = await refused(
      readOtlpBody(request(gzipSync(over), { "content-encoding": "gzip" }), CAPS),
    );
    expect(err.status).toBe(413);
    expect(err.message).toContain("limits.max_otlp_inflated_bytes");
  });

  it("holds a gzipped body to the wire cap as sent, just under and just over", async () => {
    // Random bytes do not compress: the gzipped body is a little larger than what it holds.
    const random = new Uint8Array(900);
    crypto.getRandomValues(random);
    const sent = gzipSync(random);
    const caps = { wire: sent.length, inflated: 10_000 };
    expect(await readOtlpBody(request(sent, { "content-encoding": "gzip" }), caps)).toEqual(random);
    const err = await refused(
      readOtlpBody(request(sent, { "content-encoding": "gzip" }), {
        ...caps,
        wire: sent.length - 1,
      }),
    );
    expect(err.status).toBe(413);
    expect(err.message).toContain("limits.max_otlp_bytes");
  });

  it("stops a gzip bomb at the inflated cap instead of inflating it whole", async () => {
    // 64 MiB of zeros in about 64 KB.
    const bomb = await gzipOf(64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(100_000);
    const { stream, pulled } = streamed(bomb, 256);
    const caps = { wire: 1024 * 1024, inflated: 64 * 1024 };
    const err = await refused(readOtlpBody(request(stream, { "content-encoding": "gzip" }), caps));
    expect(err.status).toBe(413);
    expect(err.message).toContain("limits.max_otlp_inflated_bytes");
    // Inflating stopped near the cap: only the start of the bomb was read off the wire.
    expect(pulled.bytes).toBeLessThan(bomb.length / 4);
  });

  it("refuses a body that is not gzip, and an encoding it does not know", async () => {
    const bad = await refused(
      readOtlpBody(request(new Uint8Array([1, 2, 3]), { "content-encoding": "gzip" }), CAPS),
    );
    expect(bad.status).toBe(400);
    const other = await refused(
      readOtlpBody(request(new Uint8Array([1]), { "content-encoding": "br" }), CAPS),
    );
    expect(other.status).toBe(415);
  });

  it("reads an empty body as empty", async () => {
    expect(await readOtlpBody(request(new Uint8Array()), CAPS)).toEqual(new Uint8Array());
  });
});
