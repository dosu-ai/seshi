import { describe, expect, it } from "vitest";
import { FetchGcsClient, GcsHttpError } from "./gcs-fetch";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

function client(respond: (seen: Seen) => Response, token?: () => Promise<string>) {
  const seen: Seen[] = [];
  const c = new FetchGcsClient({
    bucket: "sessions",
    token,
    fetch: async (input: string, init?: RequestInit) => {
      const request: Seen = {
        method: init?.method ?? "GET",
        url: new URL(input),
        headers: init?.headers as Record<string, string>,
        ...(init?.body ? { body: new TextDecoder().decode(init.body as Uint8Array) } : {}),
      };
      seen.push(request);
      return respond(request);
    },
  });
  return { c, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const gcsError = (status: number, reason: string, message: string) =>
  json({ error: { code: status, message, errors: [{ reason, message }] } }, status);
const notMet = () => gcsError(412, "conditionNotMet", "At least one of the pre-conditions failed.");

describe("FetchGcsClient requests", () => {
  it("sends the bearer token and encodes the whole key, slashes too", async () => {
    const { c, seen } = client(
      () => new Response("hi", { headers: { "x-goog-generation": "17" } }),
      async () => "tok",
    );
    expect(await c.get("owners/a b/x.json")).toEqual({
      body: new TextEncoder().encode("hi"),
      etag: "17",
    });
    expect(seen[0]?.url.toString()).toBe(
      "https://storage.googleapis.com/storage/v1/b/sessions/o/owners%2Fa%20b%2Fx.json?alt=media",
    );
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
  });

  it("sends no Authorization to an emulator (no token source)", async () => {
    const { c, seen } = client(() => new Response("hi", { headers: { "x-goog-generation": "1" } }));
    await c.get("k");
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("uploads with ifGenerationMatch: 0 to create, the generation to replace", async () => {
    const { c, seen } = client(() => json({ generation: "42" }));
    expect(await c.put("a/k", new Uint8Array([1]), "text/plain", { ifNoneMatch: "*" })).toEqual({
      etag: "42",
    });
    await c.put("a/k", new Uint8Array([1]), "text/plain", { ifMatch: "41" });
    await c.put("a/k", new Uint8Array([1]), "text/plain");
    const [create, replace, plain] = seen;
    expect(create?.method).toBe("POST");
    expect(create?.url.pathname).toBe("/upload/storage/v1/b/sessions/o");
    expect(Object.fromEntries(create?.url.searchParams ?? [])).toEqual({
      uploadType: "media",
      name: "a/k",
      ifGenerationMatch: "0",
      fields: "generation",
    });
    expect(create?.headers["content-type"]).toBe("text/plain");
    expect(replace?.url.searchParams.get("ifGenerationMatch")).toBe("41");
    expect(plain?.url.searchParams.has("ifGenerationMatch")).toBe(false);
  });

  it("refuses an If-Match that is no generation without asking GCS", async () => {
    const { c, seen } = client(() => json({ generation: "1" }));
    const err = await c
      .put("k", new Uint8Array(), "text/plain", { ifMatch: "0123456789abcdef" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GcsHttpError);
    expect(err).toMatchObject({ status: 412, code: "conditionNotMet" });
    await expect(c.delete("k", { ifMatch: "W/x" })).rejects.toMatchObject({ status: 412 });
    expect(seen).toEqual([]);
  });

  it("throws GCS's 412 conditionNotMet with its reason", async () => {
    const { c } = client(notMet);
    await expect(c.put("k", new Uint8Array(), "x", { ifMatch: "5" })).rejects.toMatchObject({
      status: 412,
      code: "conditionNotMet",
      message: "PUT sessions/k: 412 conditionNotMet: At least one of the pre-conditions failed.",
    });
  });

  it("deletes with ifGenerationMatch, and a missing object is not an error", async () => {
    const { c, seen } = client((r) =>
      r.url.searchParams.get("ifGenerationMatch") === "9"
        ? notMet()
        : gcsError(404, "notFound", "No such object: sessions/k"),
    );
    await c.delete("k");
    await expect(c.delete("k", { ifMatch: "9" })).rejects.toMatchObject({ status: 412 });
    expect(seen.map((s) => [s.method, s.url.search])).toEqual([
      ["DELETE", ""],
      ["DELETE", "?ifGenerationMatch=9"],
    ]);
  });

  it("tells a missing object from a missing bucket", async () => {
    const { c } = client((r) =>
      r.url.pathname.includes("/b/sessions/o/")
        ? gcsError(404, "notFound", "The specified bucket does not exist.")
        : json({}),
    );
    await expect(c.get("k")).rejects.toMatchObject({ status: 404, code: "notFound" });
    await expect(c.head("k")).rejects.toBeInstanceOf(GcsHttpError);
    await expect(c.delete("k")).rejects.toBeInstanceOf(GcsHttpError);
    const { c: present } = client(() => gcsError(404, "notFound", "No such object: sessions/k"));
    expect(await present.get("k")).toBeNull();
    expect(await present.head("k")).toBeNull();
  });

  it("fails on a 404 that no Cloud Storage API sent (a wrong endpoint path)", async () => {
    const { c } = client(() => new Response("Not Found", { status: 404 }));
    await expect(c.get("k")).rejects.toMatchObject({ status: 404 });
    await expect(c.getObject("k")).rejects.toMatchObject({ status: 404 });
    await expect(c.head("k")).rejects.toMatchObject({ status: 404 });
    await expect(c.delete("k")).rejects.toMatchObject({ status: 404 });
  });

  it("asks the metadata when a download's 404 is unclear, as fake-gcs-server's is", async () => {
    const { c, seen } = client((r) =>
      r.url.searchParams.get("alt") === "media"
        ? new Response("Not Found", { status: 404 })
        : gcsError(404, "notFound", "Not Found"),
    );
    expect(await c.get("k")).toBeNull();
    expect(await c.getObject("k")).toBeNull();
    expect(seen[1]?.url.searchParams.get("fields")).toBe("name");
  });

  it("refuses generation 0 as an ETag: ifGenerationMatch=0 means no object", async () => {
    const { c, seen } = client(() => json({ generation: "1" }));
    await expect(c.put("k", new Uint8Array(), "x", { ifMatch: "0" })).rejects.toMatchObject({
      status: 412,
    });
    await expect(c.delete("k", { ifMatch: "0" })).rejects.toMatchObject({ status: 412 });
    await expect(c.getObject("k", { ifMatch: "0" })).rejects.toMatchObject({ status: 412 });
    expect(seen).toEqual([]);
  });

  it("stats from the object resource: size, generation, updated", async () => {
    const { c, seen } = client(() =>
      json({ size: "5", generation: "77", updated: "2026-11-20T09:00:00.123Z" }),
    );
    expect(await c.head("k")).toEqual({
      size: 5,
      etag: "77",
      modified: "2026-11-20T09:00:00.123Z",
    });
    expect(seen[0]?.url.searchParams.get("fields")).toBe("size,generation,updated");
  });
});

describe("FetchGcsClient listing", () => {
  const item = (name: string, generation = "1", size = "3") => ({
    name,
    generation,
    size,
    updated: "2026-11-20T09:00:00Z",
  });

  it("starts at the key, drops it, and asks for one more", async () => {
    const { c, seen } = client(() => json({ items: [item("a/1"), item("a/2"), item("a/3")] }));
    const page = await c.listObjects({ prefix: "a/", maxKeys: 2, startAfter: "a/1" });
    expect(page).toEqual({
      objects: [
        { key: "a/2", size: 3, etag: "1", last_modified: "2026-11-20T09:00:00.000Z" },
        { key: "a/3", size: 3, etag: "1", last_modified: "2026-11-20T09:00:00.000Z" },
      ],
      truncated: false,
    });
    const query = Object.fromEntries(seen[0]?.url.searchParams ?? []);
    expect(query).toMatchObject({ prefix: "a/", maxResults: "3", startOffset: "a/1" });
  });

  it("drops keys up to startAfter in GCS's UTF-8 byte order, not UTF-16's", async () => {
    // U+FF01 is EF BC 81 in UTF-8, before an emoji's F0 …; in UTF-16 it is after D83D.
    const { c } = client(() => json({ items: [item("a/\uFF01"), item("a/\u{1F600}")] }));
    const page = await c.listObjects({ prefix: "a/", maxKeys: 5, startAfter: "a/\uFF01" });
    expect(page.objects.map((o) => o.key)).toEqual(["a/\u{1F600}"]);
  });

  it("follows page tokens until enough keys are found, and says when more remain", async () => {
    const { c, seen } = client((r) =>
      r.url.searchParams.get("pageToken") === null
        ? json({ items: [item("a/1")], nextPageToken: "t1" })
        : json({ items: [item("a/2"), item("a/3")], nextPageToken: "t2" }),
    );
    const page = await c.listObjects({ prefix: "a/", maxKeys: 2 });
    expect(page.objects.map((o) => o.key)).toEqual(["a/1", "a/2"]);
    expect(page.truncated).toBe(true);
    expect(seen[1]?.url.searchParams.get("pageToken")).toBe("t1");
    expect(seen[1]?.url.searchParams.has("startOffset")).toBe(false);
  });

  it("ends without a token", async () => {
    const { c } = client(() => json({}));
    expect(await c.list({ prefix: "", maxKeys: 10 })).toEqual({ keys: [], truncated: false });
  });
});

describe("FetchGcsClient getObject", () => {
  it("reads a range as stored, on the generation listed, with user metadata", async () => {
    const { c, seen } = client(
      () =>
        new Response("two\n", {
          status: 206,
          headers: {
            "content-range": "bytes 4-7/8",
            "x-goog-generation": "55",
            "x-goog-meta-session": "s1",
            "content-encoding": "gzip",
          },
        }),
    );
    const read = await c.getObject("a.jsonl", { start: 4, ifMatch: "55" });
    expect(read).toEqual({
      body: new TextEncoder().encode("two\n"),
      etag: "55",
      start: 4,
      size: 8,
      metadata: { session: "s1" },
      content_encoding: "gzip",
    });
    expect(seen[0]?.headers).toMatchObject({ range: "bytes=4-", "accept-encoding": "gzip" });
    expect(seen[0]?.url.searchParams.get("ifGenerationMatch")).toBe("55");
  });

  it("is 412 when another generation answers, even from a service that ignores the condition", async () => {
    const { c } = client(() => new Response("x", { headers: { "x-goog-generation": "56" } }));
    await expect(c.getObject("k", { ifMatch: "55" })).rejects.toMatchObject({ status: 412 });
    const { c: honours } = client(notMet);
    await expect(honours.getObject("k", { ifMatch: "55" })).rejects.toMatchObject({
      status: 412,
    });
  });

  it("is null for a missing object", async () => {
    const { c } = client(() => gcsError(404, "notFound", "No such object: sessions/k"));
    expect(await c.getObject("k", { ifMatch: "1" })).toBeNull();
  });
});
