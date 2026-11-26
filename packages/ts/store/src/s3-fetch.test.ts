import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3Store } from "./s3";
import { PreconditionFailed, StoreError, updateObject } from "./store";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A fetch that records each request and answers from `respond`. */
function fakeFetch(respond: (seen: Seen) => Response) {
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
  return { fetch, seen };
}

const credentials = { accessKeyId: "AKID", secretAccessKey: "secret" };

describe("S3Store over fetch", () => {
  it("addresses AWS virtual-hosted, signed for the region", async () => {
    const { fetch, seen } = fakeFetch(() => new Response("hi"));
    const store = S3Store.fromUrl("s3://acme/archive", { region: "eu-west-1", credentials, fetch });
    expect(await store.get("owners/a/x.json")).toEqual({
      body: new TextEncoder().encode("hi"),
      etag: "",
    });
    expect(seen[0]?.url).toBe("https://acme.s3.eu-west-1.amazonaws.com/archive/owners/a/x.json");
    expect(seen[0]?.headers.authorization).toContain("/eu-west-1/s3/aws4_request");
  });

  it("addresses R2 path-style on the account's endpoint, signed for region auto", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(null, { status: 200 }));
    const store = S3Store.fromUrl("r2://acme/p", { accountId: "abc123", credentials, fetch });
    await store.put("k.json", new TextEncoder().encode("{}"), { contentType: "application/json" });
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url).toBe("https://abc123.r2.cloudflarestorage.com/acme/p/k.json");
    expect(seen[0]?.headers.authorization).toContain("/auto/s3/aws4_request");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
  });

  it("addresses an explicit endpoint path-style", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(null, { status: 404 }));
    const store = S3Store.fromUrl("s3://b", {
      endpoint: "http://127.0.0.1:9000/",
      credentials,
      fetch,
    });
    expect(await store.get("missing")).toBeNull();
    expect(seen[0]?.url).toBe("http://127.0.0.1:9000/b/missing");
  });

  it("stats with the unquoted etag, null when absent", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.endsWith("/there")
        ? new Response(null, { headers: { etag: '"abc"', "content-length": "5" } })
        : new Response(null, { status: 404 }),
    );
    const store = S3Store.fromUrl("s3://b", { credentials, fetch });
    expect(await store.stat("there")).toEqual({ size: 5, etag: "abc" });
    expect(await store.stat("gone")).toBeNull();
  });

  it("lists with ListObjectsV2, strips the prefix and decodes keys", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>p/owners/a/1&amp;2.json</Key></Contents>
      <Contents><Key>p/owners/a/3.json</Key></Contents></ListBucketResult>`;
    const { fetch, seen } = fakeFetch(() => new Response(xml));
    const store = S3Store.fromUrl("s3://b/p", { credentials, fetch });
    expect(await store.list("owners/a/", { startAfter: "owners/a/0.json", limit: 2 })).toEqual({
      keys: ["owners/a/1&2.json", "owners/a/3.json"],
      truncated: true,
    });
    const url = new URL(seen[0]?.url as string);
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("p/owners/a/");
    expect(url.searchParams.get("start-after")).toBe("p/owners/a/0.json");
    expect(url.searchParams.get("max-keys")).toBe("2");
  });

  it("treats a missing object on delete as done", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(S3Store.fromUrl("s3://b", { credentials, fetch }).delete("x")).resolves.toBe(
      undefined,
    );
  });

  it("reports S3's error code as a StoreError", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("<Error><Code>AccessDenied</Code><Message>nope</Message></Error>", {
          status: 403,
        }),
    );
    const err = await S3Store.fromUrl("s3://b", { credentials, fetch })
      .put("k", new Uint8Array())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(String((err as StoreError).cause)).toContain("403 AccessDenied: nope");
  });

  it("refuses to start without credentials, and reads them from the env it is given", async () => {
    expect(() =>
      S3Store.fromUrl("r2://b", { accountId: "a", fetch: async () => new Response(), env: {} }),
    ).toThrow(/R2_ACCESS_KEY_ID/);
    const { fetch, seen } = fakeFetch(() => new Response(null, { status: 404 }));
    const store = S3Store.fromUrl("r2://b", {
      accountId: "a",
      fetch,
      env: { R2_ACCESS_KEY_ID: "R2KEY", R2_SECRET_ACCESS_KEY: "s" },
    });
    await store.get("k");
    expect(seen[0]?.headers.authorization).toContain("Credential=R2KEY/");
  });
});

describe("S3Store as the role it runs as", () => {
  const ECS = "http://169.254.170.2/v2/credentials/task-1";
  const roleKeys = (id: string, expiresInMs: number) =>
    new Response(
      JSON.stringify({
        AccessKeyId: id,
        SecretAccessKey: "secret",
        Token: `token-${id}`,
        Expiration: new Date(Date.now() + expiresInMs).toISOString(),
      }),
    );
  const keyId = (seen: Seen) => /Credential=(\w+)\//.exec(seen.headers.authorization ?? "")?.[1];

  it("signs with an ECS task role's keys when it is given none, and asks again when they are due", async () => {
    let issued = 0;
    // The first keys are already due for renewal; the second last an hour.
    const { fetch, seen } = fakeFetch(({ url }) =>
      url === ECS
        ? roleKeys(`ASIA${++issued}`, issued === 1 ? 0 : 3_600_000)
        : new Response(null, { status: 404 }),
    );
    const store = S3Store.fromUrl("s3://acme/archive", {
      region: "us-east-2",
      fetch,
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" },
    });
    await store.get("a");
    await store.get("b");
    await store.get("c");
    expect(seen.map((s) => (s.url === ECS ? "ecs" : "bucket"))).toEqual([
      "ecs",
      "bucket",
      "ecs",
      "bucket",
      "bucket",
    ]);
    const toBucket = seen.filter((s) => s.url !== ECS);
    expect(toBucket.map(keyId)).toEqual(["ASIA1", "ASIA2", "ASIA2"]);
    expect(toBucket[0]?.headers["x-amz-security-token"]).toBe("token-ASIA1");
    expect(toBucket[0]?.headers.authorization).toContain("/us-east-2/s3/aws4_request");
  });

  it("signs with the EC2 instance role's keys when there is no container URI", async () => {
    const { fetch, seen } = fakeFetch(({ method, url }) => {
      if (url.startsWith("http://169.254.169.254/")) {
        if (method === "PUT") return new Response("session");
        if (url.endsWith("/security-credentials/")) return new Response("seshi");
        return roleKeys("ASIAEC2", 3_600_000);
      }
      return new Response(null, { status: 404 });
    });
    await S3Store.fromUrl("s3://acme", { region: "us-east-1", fetch, env: {} }).get("k");
    const last = seen.at(-1);
    expect(last && keyId(last)).toBe("ASIAEC2");
  });

  it("prefers keys in the environment to a role, as the AWS SDKs do", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(null, { status: 404 }));
    await S3Store.fromUrl("s3://acme", {
      fetch,
      env: {
        AWS_ACCESS_KEY_ID: "AKIAENV",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1",
      },
    }).get("k");
    expect(seen.map((s) => s.url)).toEqual(["https://acme.s3.us-east-1.amazonaws.com/k"]);
    expect(seen[0] && keyId(seen[0])).toBe("AKIAENV");
  });

  it("reports a role it cannot get keys for as a store failure, not the bucket's answer", async () => {
    const { fetch } = fakeFetch(() => new Response("no", { status: 500 }));
    const err = await S3Store.fromUrl("s3://acme", {
      fetch,
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" },
    })
      .get("k")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(String((err as StoreError).cause)).toContain("task role's credentials (ECS): 500");
  });

  it("does not send a role's keys to an S3-compatible endpoint, but does to a VPC endpoint", async () => {
    const { fetch, seen } = fakeFetch(({ url }) =>
      url === ECS ? roleKeys("ASIA1", 3_600_000) : new Response(null, { status: 404 }),
    );
    const env = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" };
    expect(() =>
      S3Store.fromUrl("s3://b", { endpoint: "http://127.0.0.1:9000", fetch, env }),
    ).toThrow(/a role's keys are not sent to http:\/\/127\.0\.0\.1:9000/);
    expect(() =>
      S3Store.fromUrl("s3://b", { fetch, env: { ...env, S3_ENDPOINT: "https://minio.internal" } }),
    ).toThrow(/not sent to https:\/\/minio\.internal/);
    expect(seen).toEqual([]);
    await S3Store.fromUrl("s3://b", {
      endpoint: "https://bucket.vpce-0a1b.s3.us-east-1.vpce.amazonaws.com",
      fetch,
      env,
    }).get("k");
    expect(seen.at(-1) && keyId(seen.at(-1) as Seen)).toBe("ASIA1");
  });

  it("refuses to start with no keys and no role to ask, and never asks one for r2://", () => {
    const fetch = async () => new Response();
    expect(() =>
      S3Store.fromUrl("s3://b", { fetch, env: { AWS_EC2_METADATA_DISABLED: "true" } }),
    ).toThrow(/ECS task role or EC2 instance role/);
    expect(() =>
      S3Store.fromUrl("r2://b", {
        accountId: "a",
        fetch,
        env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" },
      }),
    ).toThrow(/R2_ACCESS_KEY_ID/);
  });
});

describe("S3Store conditional writes", () => {
  it("returns the etag with the object and from a PUT", async () => {
    const { fetch } = fakeFetch(({ method }) =>
      method === "GET"
        ? new Response("hi", { headers: { etag: '"abc"' } })
        : new Response(null, { headers: { etag: 'W/"def"' } }),
    );
    const store = S3Store.fromUrl("s3://b", { credentials, fetch });
    expect((await store.get("k"))?.etag).toBe("abc");
    expect(await store.put("k", new Uint8Array())).toEqual({ etag: "def" });
  });

  it("sends If-None-Match and If-Match (quoted), signed with the request", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(null));
    const store = S3Store.fromUrl("s3://b", { credentials, fetch });
    await store.put("a", new Uint8Array(), { ifNoneMatch: "*" });
    await store.put("b", new Uint8Array(), { ifMatch: "abc" });
    await store.delete("c", { ifMatch: "def" });
    await store.put("d", new Uint8Array());
    expect(seen[0]?.headers["if-none-match"]).toBe("*");
    expect(seen[0]?.headers.authorization).toContain("if-none-match");
    expect(seen[1]?.headers["if-match"]).toBe('"abc"');
    expect(seen[2]?.headers["if-match"]).toBe('"def"');
    expect(seen[3]?.headers["if-match"]).toBeUndefined();
    expect(seen[3]?.headers["if-none-match"]).toBeUndefined();
  });

  it("turns 412, and S3's 409 ConditionalRequestConflict, into PreconditionFailed", async () => {
    const answers = [
      new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }),
      new Response("<Error><Code>ConditionalRequestConflict</Code></Error>", { status: 409 }),
      new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }),
      new Response("<Error><Code>OperationAborted</Code></Error>", { status: 409 }),
    ];
    const { fetch } = fakeFetch(() => answers.shift() as Response);
    const store = S3Store.fromUrl("s3://b", { credentials, fetch });
    await expect(store.put("k", new Uint8Array(), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await expect(store.put("k", new Uint8Array(), { ifMatch: "x" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await expect(store.delete("k", { ifMatch: "x" })).rejects.toBeInstanceOf(PreconditionFailed);
    const other = await store.put("k", new Uint8Array()).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(StoreError);
    expect(other).not.toBeInstanceOf(PreconditionFailed);
  });

  it("reads S3's 404 NoSuchKey on an If-Match PUT as a failed condition, and only then", async () => {
    const answers = [
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
    ];
    const { fetch } = fakeFetch(() => answers.shift() as Response);
    const store = S3Store.fromUrl("s3://b", { credentials, fetch });
    await expect(store.put("k", new Uint8Array(), { ifMatch: "x" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    const plain = await store.put("k", new Uint8Array()).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(StoreError);
    expect(plain).not.toBeInstanceOf(PreconditionFailed);
  });

  it("runs read-modify-write against a bucket that honours the conditions", async () => {
    const bucket = new Map<string, Uint8Array>();
    const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
    const fetch = async (input: string, init?: RequestInit) => {
      const key = new URL(input).pathname;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const current = bucket.get(key);
      const tag = current ? `"${md5(current)}"` : undefined;
      if (init?.method === "GET") {
        return current
          ? new Response(current as BodyInit, { headers: { etag: tag as string } })
          : new Response(null, { status: 404 });
      }
      if (headers["if-none-match"] === "*" && current) return new Response(null, { status: 412 });
      if (headers["if-match"] !== undefined && headers["if-match"] !== tag) {
        return new Response(null, { status: 412 });
      }
      await new Promise((r) => setTimeout(r, Math.random() * 2));
      const body = new Uint8Array(init?.body as Uint8Array);
      // Re-check after the delay, as a bucket applies the condition atomically.
      const now = bucket.get(key);
      if ((now ? `"${md5(now)}"` : undefined) !== tag) return new Response(null, { status: 412 });
      bucket.set(key, body);
      return new Response(null, { headers: { etag: `"${md5(body)}"` } });
    };
    const store = S3Store.fromUrl("s3://b", { credentials, fetch, endpoint: "http://s3.test" });
    const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : "0");
    await Promise.all(
      Array.from({ length: 8 }, () =>
        updateObject(
          store,
          "n",
          (current) => new TextEncoder().encode(String(Number(dec(current?.body)) + 1)),
          { retries: 50, sleep: () => new Promise((r) => setTimeout(r, Math.random() * 2)) },
        ),
      ),
    );
    expect(dec((await store.get("n"))?.body)).toBe("8");
  });
});
