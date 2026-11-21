import { describe, expect, it } from "vitest";
import { AzureStore, parseAzureUrl, resolveAzureAccess } from "./azure";
import { openStore } from "./open";
import { AccessDenied, PreconditionFailed, StoreError } from "./store";

const KEY = Buffer.from("not-a-real-account-key").toString("base64");

describe("parseAzureUrl", () => {
  it("splits container and prefix", () => {
    expect(parseAzureUrl("az://c/p/q/")).toEqual({ container: "c", prefix: "p/q" });
    expect(parseAzureUrl("az://c")).toEqual({ container: "c", prefix: "" });
    expect(() => parseAzureUrl("s3://c")).toThrow(StoreError);
  });
});

describe("resolveAzureAccess", () => {
  const resolve = (env: Record<string, string>, options = {}) =>
    resolveAzureAccess("az://c", { env, ...options });

  it("takes the account and key from config before the environment", () => {
    expect(
      resolve(
        { AZURE_STORAGE_ACCOUNT: "envacct", AZURE_STORAGE_KEY: "envkey" },
        { account: "acct", credentials: { sasToken: "sv=1&sig=x" } },
      ),
    ).toEqual({ account: "acct", credentials: { sasToken: "sv=1&sig=x" } });
  });

  it("falls back to AZURE_STORAGE_ACCOUNT with AZURE_STORAGE_KEY, then AZURE_STORAGE_SAS_TOKEN", () => {
    expect(resolve({ AZURE_STORAGE_ACCOUNT: "a", AZURE_STORAGE_KEY: "k" })).toEqual({
      account: "a",
      credentials: { accountKey: "k" },
    });
    expect(resolve({ AZURE_STORAGE_ACCOUNT: "a", AZURE_STORAGE_SAS_TOKEN: "sig=s" })).toEqual({
      account: "a",
      credentials: { sasToken: "sig=s" },
    });
  });

  it("reads a connection string, with its blob endpoint or endpoint suffix", () => {
    expect(
      resolve({
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=http;AccountName=dev;AccountKey=a2V5==;BlobEndpoint=http://127.0.0.1:10000/dev;",
      }),
    ).toEqual({
      account: "dev",
      endpoint: "http://127.0.0.1:10000/dev",
      credentials: { accountKey: "a2V5==" },
    });
    expect(
      resolve({
        AZURE_STORAGE_CONNECTION_STRING:
          "AccountName=gov;SharedAccessSignature=sv=1&sig=x;EndpointSuffix=core.usgovcloudapi.net",
      }),
    ).toEqual({
      account: "gov",
      endpoint: "https://gov.blob.core.usgovcloudapi.net",
      credentials: { sasToken: "sv=1&sig=x" },
    });
  });

  it("reads UseDevelopmentStorage=true as Azurite", () => {
    const access = resolve({ AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true" });
    expect(access.account).toBe("devstoreaccount1");
    expect(access.endpoint).toBe("http://127.0.0.1:10000/devstoreaccount1");
    expect("accountKey" in access.credentials).toBe(true);
  });

  it("ignores a connection string for another account", () => {
    const env = {
      AZURE_STORAGE_CONNECTION_STRING:
        "AccountName=logs;AccountKey=bG9ncw==;BlobEndpoint=https://logs.example",
      AZURE_FEDERATED_TOKEN_FILE: "/t",
      AZURE_CLIENT_ID: "c",
      AZURE_TENANT_ID: "t",
    };
    const access = resolve(env, { account: "sessions" });
    expect(access.account).toBe("sessions");
    expect(access.endpoint).toBeUndefined();
    expect("token" in access.credentials).toBe(true);
  });

  it("uses workload identity when no key is given", () => {
    const access = resolve({
      AZURE_STORAGE_ACCOUNT: "a",
      AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/token",
      AZURE_CLIENT_ID: "client",
      AZURE_TENANT_ID: "tenant",
    });
    expect(access.account).toBe("a");
    expect("token" in access.credentials).toBe(true);
  });

  it("says what is missing", () => {
    expect(() => resolve({ AZURE_STORAGE_KEY: "k" })).toThrow(/storage account name/);
    expect(() => resolve({ AZURE_STORAGE_ACCOUNT: "a" })).toThrow(/needs credentials/);
  });
});

describe("AzureStore", () => {
  function store(respond: (method: string, url: URL) => Response) {
    const seen: string[] = [];
    const s = AzureStore.fromUrl("az://sessions/seshi", {
      account: "acct",
      endpoint: "http://azure.test/acct",
      credentials: { accountKey: KEY },
      env: {},
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return respond(init?.method ?? "GET", url);
      },
    });
    return { s, seen };
  }
  const error = (status: number, code: string) =>
    new Response(`<Error><Code>${code}</Code></Error>`, {
      status,
      headers: { "x-ms-error-code": code },
    });

  it("keys objects under its prefix, and lists them without it", async () => {
    const { s, seen } = store((method) =>
      method === "GET"
        ? new Response(
            "<EnumerationResults><Blobs><Blob><Name>seshi/a/b</Name><Properties><Last-Modified>Fri, 20 Nov 2026 08:00:00 GMT</Last-Modified><Etag>0x1</Etag><Content-Length>3</Content-Length></Properties></Blob></Blobs><NextMarker /></EnumerationResults>",
          )
        : new Response(null, { status: 201, headers: { etag: '"0x1"' } }),
    );
    expect(s.url).toBe("az://sessions/seshi");
    await s.put("a/b", new Uint8Array([1, 2, 3]));
    expect(await s.list("a/", { details: true })).toEqual({
      keys: ["a/b"],
      truncated: false,
      objects: [{ key: "a/b", size: 3, etag: "0x1", modified: "2026-11-20T08:00:00.000Z" }],
    });
    expect(seen).toEqual(["PUT /acct/sessions/seshi/a/b", "GET /acct/sessions"]);
  });

  it("turns a failed condition into PreconditionFailed: 412, and 409 BlobAlreadyExists", async () => {
    const exists = store(() => error(409, "BlobAlreadyExists")).s;
    await expect(exists.put("k", new Uint8Array(), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    const changed = store(() => error(412, "ConditionNotMet")).s;
    await expect(changed.put("k", new Uint8Array(), { ifMatch: "0x1" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    await expect(changed.delete("k", { ifMatch: "0x1" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
  });

  it("turns 403 into AccessDenied, and other failures into StoreError", async () => {
    const denied = store(() => error(403, "AuthorizationPermissionMismatch")).s;
    await expect(denied.get("k")).rejects.toBeInstanceOf(AccessDenied);
    await expect(denied.list("")).rejects.toBeInstanceOf(AccessDenied);
    const broken = store(() => error(500, "InternalError")).s;
    const err = await broken.stat("k").catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).not.toBeInstanceOf(AccessDenied);
  });

  it("says why in the message: the service's error code, a missing container", async () => {
    const wrongKey = store(() => error(403, "AuthenticationFailed")).s;
    await expect(wrongKey.get("seshi.json")).rejects.toThrow(
      "read seshi.json: access denied (AuthenticationFailed)",
    );
    const noContainer = store(() => error(404, "ContainerNotFound")).s;
    await expect(noContainer.get("seshi.json")).rejects.toThrow(
      "read seshi.json: GET sessions/seshi/seshi.json: 404 ContainerNotFound",
    );
    const unreachable = AzureStore.fromUrl("az://sessions", {
      account: "acct",
      credentials: { accountKey: KEY },
      env: {},
      fetch: async () => {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    });
    await expect(unreachable.list("owners/")).rejects.toThrow("list owners/: Unable to connect");
  });
});

describe("openStore with az://", () => {
  it("opens an Azure store and says where it is, never with the key", () => {
    const { store, storage } = openStore("az://sessions/prod", {
      accountName: "acct",
      credentials: { accountKey: KEY },
      env: {},
    });
    expect(store).toBeInstanceOf(AzureStore);
    expect(storage).toEqual({ url: "az://sessions/prod", account_name: "acct" });
  });

  it("refuses keys for the other kind of bucket", () => {
    expect(() =>
      openStore("az://c", {
        accountName: "a",
        credentials: { accessKeyId: "AKID", secretAccessKey: "s" },
        env: {},
      }),
    ).toThrow(/account key or SAS token/);
    expect(() => openStore("s3://b", { credentials: { accountKey: KEY }, env: {} })).toThrow(
      /access key id and secret access key/,
    );
  });

  it("lists every scheme when the URL has none of them", () => {
    expect(() => openStore("ftp://b")).toThrow("s3://, r2://, az://, gs:// or file://");
  });
});
