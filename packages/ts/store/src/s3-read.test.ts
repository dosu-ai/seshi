/** The read side a poller needs from a bucket (F6.2): listings with each object's size and
 * ETag, and ranged, conditional GETs with user metadata. */

import { describe, expect, it } from "vitest";
import { FetchS3Client, S3HttpError } from "./s3-fetch";
import { signRequest } from "./sigv4";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function client(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const request = {
      method: init?.method ?? "GET",
      url: input,
      headers: init?.headers as Record<string, string>,
    };
    seen.push(request);
    return respond(request);
  };
  const c = new FetchS3Client({
    bucket: "src",
    region: "eu-west-1",
    endpoint: "http://s3.test",
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    fetch,
  });
  return { c, seen };
}

describe("listObjects", () => {
  it("returns key, size, unquoted ETag and change time, and the next token", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>p/a&amp;b.jsonl</Key><LastModified>2026-11-01T09:00:00.000Z</LastModified>
        <ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents>
      <Contents><Key>p/c.json</Key><ETag>"def-2"</ETag><Size>7</Size></Contents>
      <NextContinuationToken>tok/en=</NextContinuationToken></ListBucketResult>`;
    const { c, seen } = client(() => new Response(xml));
    expect(
      await c.listObjects({ prefix: "p/", maxKeys: 2, startAfter: "p/0", continuationToken: "t" }),
    ).toEqual({
      objects: [
        { key: "p/a&b.jsonl", size: 12, etag: "abc", last_modified: "2026-11-01T09:00:00.000Z" },
        { key: "p/c.json", size: 7, etag: "def-2" },
      ],
      truncated: true,
      next_token: "tok/en=",
    });
    const url = new URL(seen[0]?.url as string);
    expect(url.pathname).toBe("/src/");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("p/");
    expect(url.searchParams.get("start-after")).toBe("p/0");
    expect(url.searchParams.get("continuation-token")).toBe("t");
    expect(url.searchParams.get("max-keys")).toBe("2");
  });

  it("reports an empty, complete page and S3's errors", async () => {
    const empty = client(
      () => new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"),
    );
    expect(await empty.c.listObjects({ prefix: "", maxKeys: 10 })).toEqual({
      objects: [],
      truncated: false,
    });
    const denied = client(
      () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
    );
    const err = await denied.c.listObjects({ prefix: "", maxKeys: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3HttpError);
    expect((err as S3HttpError).status).toBe(403);
    expect((err as S3HttpError).code).toBe("AccessDenied");
  });
});

describe("getObject", () => {
  it("reads a whole object with its metadata, conditional on the ETag", async () => {
    const { c, seen } = client(
      () =>
        new Response("hello", {
          headers: {
            etag: '"e1"',
            "x-amz-meta-seshi-session": "s1",
            "X-Amz-Meta-Seshi-Email": "a@x.io",
            "content-encoding": "gzip",
          },
        }),
    );
    expect(await c.getObject("p/k", { ifMatch: "e1" })).toEqual({
      body: new TextEncoder().encode("hello"),
      etag: "e1",
      start: 0,
      size: 5,
      metadata: { "seshi-session": "s1", "seshi-email": "a@x.io" },
      content_encoding: "gzip",
    });
    expect(seen[0]?.headers["if-match"]).toBe('"e1"');
    expect(seen[0]?.headers.range).toBeUndefined();
    expect(seen[0]?.headers.authorization).toContain("if-match");
  });

  it("asks for the tail with Range and reads Content-Range", async () => {
    const { c, seen } = client(
      () =>
        new Response("lo", {
          status: 206,
          headers: { etag: '"e1"', "content-range": "bytes 3-4/5" },
        }),
    );
    const read = await c.getObject("k", { start: 3 });
    expect(read?.start).toBe(3);
    expect(read?.size).toBe(5);
    expect(new TextDecoder().decode(read?.body)).toBe("lo");
    expect(seen[0]?.headers.range).toBe("bytes=3-");
  });

  it("takes a 200 to a Range as the whole object", async () => {
    const { c } = client(() => new Response("hello", { headers: { etag: "e1" } }));
    const read = await c.getObject("k", { start: 3 });
    expect(read?.start).toBe(0);
    expect(read?.size).toBe(5);
  });

  it("is null for a missing object and throws S3's 412 for a changed one", async () => {
    const answers = [
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }),
    ];
    const { c } = client(() => answers.shift() as Response);
    expect(await c.getObject("gone")).toBeNull();
    const err = await c.getObject("k", { ifMatch: "old" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3HttpError);
    expect((err as S3HttpError).status).toBe(412);
  });
});

describe("signing for another service", () => {
  it("scopes the signature to the service named", async () => {
    const base = {
      method: "POST",
      url: new URL("https://sts.amazonaws.com/"),
      region: "us-east-1",
      credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
      date: new Date("2026-11-14T00:00:00Z"),
    };
    const s3 = await signRequest(base);
    const sts = await signRequest({ ...base, service: "sts" });
    expect(s3.authorization).toContain("/20261114/us-east-1/s3/aws4_request");
    expect(sts.authorization).toContain("/20261114/us-east-1/sts/aws4_request");
    expect(sts.authorization).not.toBe(s3.authorization);
  });
});
