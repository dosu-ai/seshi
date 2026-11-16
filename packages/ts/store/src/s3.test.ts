import { describe, expect, it } from "vitest";
import { parseS3Url, S3Store } from "./s3";
import { AccessDenied } from "./store";

describe("parseS3Url", () => {
  it("splits scheme, bucket and prefix", () => {
    expect(parseS3Url("s3://b/p/q/")).toEqual({ scheme: "s3", bucket: "b", prefix: "p/q" });
    expect(parseS3Url("r2://b")).toEqual({ scheme: "r2", bucket: "b", prefix: "" });
    expect(() => parseS3Url("gs://b")).toThrow();
  });
});

describe("a 403 for an object that may not be there (F11)", () => {
  const denied = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
  const listing = (keys: string[]) =>
    new Response(
      `<ListBucketResult><IsTruncated>false</IsTruncated>${keys
        .map((k) => `<Contents><Key>${k}</Key></Contents>`)
        .join("")}</ListBucketResult>`,
    );

  function store(respond: (method: string, url: URL) => Response) {
    const seen: string[] = [];
    const s = new S3Store({
      bucket: "b",
      prefix: "seshi",
      endpoint: "http://s3.test",
      region: "us-east-1",
      credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        seen.push(`${init?.method ?? "GET"} ${url.pathname}${url.search ? "?list" : ""}`);
        return respond(init?.method ?? "GET", url);
      },
    });
    return { s, seen };
  }

  it("reads as missing when a listing of the key is allowed and finds nothing", async () => {
    const { s, seen } = store((_m, url) =>
      url.searchParams.has("list-type") ? listing([]) : denied(),
    );
    expect(await s.get("owners/alice/x.json")).toBeNull();
    expect(await s.stat("owners/alice/x.json")).toBeNull();
    expect(seen).toEqual([
      "GET /b/seshi/owners/alice/x.json",
      "GET /b/?list",
      "HEAD /b/seshi/owners/alice/x.json",
      "GET /b/?list",
    ]);
  });

  it("stays a refusal when the listing is refused too, or finds the object", async () => {
    const both = store(() => denied());
    await expect(both.s.get("owners/bob/x.json")).rejects.toBeInstanceOf(AccessDenied);
    const there = store((_m, url) =>
      url.searchParams.has("list-type") ? listing(["seshi/owners/bob/x.json"]) : denied(),
    );
    await expect(there.s.stat("owners/bob/x.json")).rejects.toBeInstanceOf(AccessDenied);
  });
});
