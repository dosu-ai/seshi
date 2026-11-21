import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AZURE_API_VERSION,
  type AzureCredentials,
  AzureHttpError,
  FetchAzureBlobClient,
  sharedKeyAuthorization,
} from "./azure-fetch";

const KEY = Buffer.from("not-a-real-account-key-0123456789").toString("base64");
const NOW = new Date("2026-11-20T09:00:00.000Z");

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

function client(
  respond: (seen: Seen) => Response,
  credentials: AzureCredentials = { accountKey: KEY },
) {
  const seen: Seen[] = [];
  const c = new FetchAzureBlobClient({
    account: "acct",
    container: "sessions",
    credentials,
    now: () => NOW,
    fetch: async (input: string, init?: RequestInit) => {
      const request = {
        method: init?.method ?? "GET",
        url: new URL(input),
        headers: init?.headers as Record<string, string>,
      };
      seen.push(request);
      return respond(request);
    },
  });
  return { c, seen };
}

const blob = (name: string, etag: string, size: number, modified?: string) =>
  `<Blob><Name>${name}</Name><Properties>${
    modified ? `<Last-Modified>${modified}</Last-Modified>` : ""
  }<Etag>${etag}</Etag><Content-Length>${size}</Content-Length></Properties></Blob>`;
const listing = (blobs: string[], next = "") =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${blobs.join("")}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`,
  );

describe("Shared Key", () => {
  it("signs the method, standard headers, x-ms-* headers and the resource with its query", async () => {
    const url = new URL(
      "https://acct.blob.core.windows.net/sessions?restype=container&comp=list&prefix=a%2Fb",
    );
    const headers = {
      "if-match": '"0x1"',
      "x-ms-version": AZURE_API_VERSION,
      "x-ms-date": NOW.toUTCString(),
    };
    const auth = await sharedKeyAuthorization({
      method: "GET",
      url,
      headers,
      contentLength: 0,
      account: "acct",
      accountKey: KEY,
    });
    const toSign = [
      "GET",
      "", // Content-Encoding
      "", // Content-Language
      "", // Content-Length: empty for no body
      "", // Content-MD5
      "", // Content-Type
      "", // Date: x-ms-date is sent instead
      "", // If-Modified-Since
      '"0x1"', // If-Match
      "", // If-None-Match
      "", // If-Unmodified-Since
      "", // Range
      `x-ms-date:${NOW.toUTCString()}\nx-ms-version:${AZURE_API_VERSION}\n/acct/sessions\ncomp:list\nprefix:a/b\nrestype:container`,
    ].join("\n");
    const want = createHmac("sha256", Buffer.from(KEY, "base64")).update(toSign).digest("base64");
    expect(auth).toBe(`SharedKey acct:${want}`);
  });

  it("signs a body's length and type, and a path-style (Azurite) endpoint's account twice", async () => {
    const auth = await sharedKeyAuthorization({
      method: "PUT",
      url: new URL("http://127.0.0.1:10000/devstoreaccount1/c/a%20b.json"),
      headers: { "content-type": "application/json", "x-ms-blob-type": "BlockBlob" },
      contentLength: 5,
      account: "devstoreaccount1",
      accountKey: KEY,
    });
    const toSign = `PUT\n\n\n5\n\napplication/json\n\n\n\n\n\n\nx-ms-blob-type:BlockBlob\n/devstoreaccount1/devstoreaccount1/c/a%20b.json`;
    const want = createHmac("sha256", Buffer.from(KEY, "base64")).update(toSign).digest("base64");
    expect(auth).toBe(`SharedKey devstoreaccount1:${want}`);
  });
});

describe("FetchAzureBlobClient", () => {
  it("puts a block blob with its conditions, and reports the ETag unquoted", async () => {
    const { c, seen } = client(
      () => new Response(null, { status: 201, headers: { etag: '"0x8DC0"' } }),
    );
    const body = new TextEncoder().encode("hello");
    expect(await c.put("a/b c.json", body, "application/json", { ifNoneMatch: "*" })).toEqual({
      etag: "0x8DC0",
    });
    await c.put("a/b c.json", body, "application/json", { ifMatch: "0x8DC0" });
    const [create, replace] = seen;
    expect(create?.url.toString()).toBe("https://acct.blob.core.windows.net/sessions/a/b%20c.json");
    expect(create?.headers).toMatchObject({
      "content-type": "application/json",
      "x-ms-blob-type": "BlockBlob",
      "if-none-match": "*",
      "x-ms-version": AZURE_API_VERSION,
      "x-ms-date": NOW.toUTCString(),
    });
    expect(create?.headers.authorization).toMatch(/^SharedKey acct:/);
    expect(replace?.headers["if-match"]).toBe('"0x8DC0"');
  });

  it("sends a SAS token as the query string, and a bearer token as a header", async () => {
    const sas = client(() => new Response("x", { headers: { etag: '"0x1"' } }), {
      sasToken: "?sv=2023-11-03&sp=rwdl&sig=abc%2B%3D",
    });
    await sas.c.get("k");
    expect(sas.seen[0]?.url.searchParams.get("sig")).toBe("abc+=");
    expect(sas.seen[0]?.url.searchParams.get("sp")).toBe("rwdl");
    expect(sas.seen[0]?.headers.authorization).toBeUndefined();

    let asked = 0;
    const bearer = client(() => new Response("x", { headers: { etag: '"0x1"' } }), {
      token: async () => `t${++asked}`,
    });
    await bearer.c.get("k");
    await bearer.c.get("k");
    expect(bearer.seen.map((s) => s.headers.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("reads a missing blob as null, but a missing container as an error", async () => {
    const missing = (code: string) =>
      client(
        () =>
          new Response(`<Error><Code>${code}</Code><Message>gone</Message></Error>`, {
            status: 404,
            headers: { "x-ms-error-code": code },
          }),
      ).c;
    expect(await missing("BlobNotFound").get("k")).toBeNull();
    expect(await missing("BlobNotFound").head("k")).toBeNull();
    await missing("BlobNotFound").delete("k");
    const error = await missing("ContainerNotFound")
      .get("k")
      .catch((err) => err);
    expect(error).toBeInstanceOf(AzureHttpError);
    expect(error).toMatchObject({ status: 404, code: "ContainerNotFound" });
  });

  it("stats size, ETag and change time; deletes with snapshots and If-Match", async () => {
    const { c, seen } = client(({ method }) =>
      method === "HEAD"
        ? new Response(null, {
            headers: {
              "content-length": "12",
              etag: '"0x2"',
              "last-modified": "Fri, 20 Nov 2026 08:00:00 GMT",
            },
          })
        : new Response(null, { status: 202 }),
    );
    expect(await c.head("k")).toEqual({
      size: 12,
      etag: "0x2",
      modified: "2026-11-20T08:00:00.000Z",
    });
    await c.delete("k", { ifMatch: "0x2" });
    expect(seen[1]?.headers).toMatchObject({
      "if-match": '"0x2"',
      "x-ms-delete-snapshots": "include",
    });
  });

  it("lists after a key with startFrom, drops the key itself, and follows markers", async () => {
    const pages = [
      listing(
        [blob("p/b", "0xB", 2, "Fri, 20 Nov 2026 08:00:00 GMT"), blob("p/c&amp;d", '"0xC"', 3)],
        "marker-1",
      ),
      listing([blob("p/e", "0xE", 4)], "marker-2"),
    ];
    const { c, seen } = client(() => pages.shift() as Response);
    expect(await c.listObjects({ prefix: "p/", maxKeys: 2, startAfter: "p/b" })).toEqual({
      objects: [
        { key: "p/c&d", size: 3, etag: "0xC" },
        { key: "p/e", size: 4, etag: "0xE" },
      ],
      truncated: true,
    });
    const [first, second] = seen.map((s) => Object.fromEntries(s.url.searchParams));
    expect(first).toMatchObject({
      restype: "container",
      comp: "list",
      prefix: "p/",
      maxresults: "3",
      startFrom: "p/b",
    });
    expect(second).toMatchObject({ marker: "marker-1" });
    expect(second?.startFrom).toBeUndefined();
    expect(seen[0]?.url.search).toContain("prefix=p%2F");
  });

  it("percent-encodes a space in the query, never as +", async () => {
    const { c, seen } = client(() => listing([]));
    await c.list({ prefix: "a b/", maxKeys: 1 });
    expect(seen[0]?.url.search).toContain("prefix=a%20b%2F");
    expect(seen[0]?.url.search).not.toContain("+");
  });

  it("filters a page a service answered without honouring startFrom", async () => {
    const { c } = client(() =>
      listing([blob("a", "0x1", 1), blob("b", "0x2", 1), blob("c", "0x3", 1)]),
    );
    expect(await c.list({ prefix: "", maxKeys: 5, startAfter: "a" })).toEqual({
      keys: ["b", "c"],
      truncated: false,
    });
  });

  it("stops at maxKeys, saying the listing is truncated", async () => {
    const { c } = client(() => listing([blob("a", "0x1", 1), blob("b", "0x2", 1)], "more"));
    const page = await c.listObjects({ prefix: "", maxKeys: 1 });
    expect(page.objects.map((o) => o.key)).toEqual(["a"]);
    expect(page.truncated).toBe(true);
    const last = await client(() => listing([blob("a", "0x1", 1)])).c.listObjects({
      prefix: "",
      maxKeys: 1,
    });
    expect(last.truncated).toBe(false);
  });

  it("gets a range of a blob only while its ETag holds, with its metadata", async () => {
    const { c, seen } = client(
      () =>
        new Response("llo", {
          status: 206,
          headers: {
            etag: '"0x5"',
            "content-range": "bytes 2-4/5",
            "x-ms-meta-Session": "s1",
            "content-encoding": "gzip",
          },
        }),
    );
    expect(await c.getObject("k", { start: 2, ifMatch: "0x5" })).toEqual({
      body: new TextEncoder().encode("llo"),
      etag: "0x5",
      start: 2,
      size: 5,
      metadata: { session: "s1" },
      content_encoding: "gzip",
    });
    expect(seen[0]?.headers).toMatchObject({ "x-ms-range": "bytes=2-", "if-match": '"0x5"' });
  });

  it("throws Azure's status and error code", async () => {
    const { c } = client(
      () =>
        new Response("<Error><Code>ConditionNotMet</Code><Message>no\nmore</Message></Error>", {
          status: 412,
        }),
    );
    const error = await c
      .put("k", new Uint8Array(), "text/plain", { ifMatch: "0x0" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(AzureHttpError);
    expect(error).toMatchObject({ status: 412, code: "ConditionNotMet" });
    expect(error.message).toBe("PUT sessions/k: 412 ConditionNotMet: no");
  });
});
