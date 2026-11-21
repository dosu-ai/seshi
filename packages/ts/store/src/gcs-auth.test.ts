import { createVerify, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applicationDefaultToken,
  credentialsFileToken,
  GCS_SCOPE,
  GcsAuthError,
  metadataServerToken,
  parseCredentialsFile,
  serviceAccountAssertion,
} from "./gcs-auth";
import { StoreError } from "./store";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = new Date("2026-11-20T09:00:00.000Z");

const serviceAccount = {
  type: "service_account",
  client_email: "seshi@proj.iam.gserviceaccount.com",
  private_key: PEM,
  private_key_id: "kid-1",
  token_uri: "https://oauth2.example/token",
};

interface Seen {
  url: string;
  init?: RequestInit;
}

function recorder(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const request = { url, ...(init ? { init } : {}) };
    seen.push(request);
    return respond(request);
  };
  return { seen, fetch };
}

const tokenAnswer = (token: string, expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }));

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("a service account key", () => {
  it("signs an RS256 JWT for the storage scope, to the key's token URI", () => {
    const jwt = serviceAccountAssertion(serviceAccount, NOW);
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(decode(claims)).toEqual({
      iss: serviceAccount.client_email,
      scope: GCS_SCOPE,
      aud: "https://oauth2.example/token",
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 3600,
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("exchanges the JWT for a token, keeps it until near expiry, and shares one exchange", async () => {
    let now = NOW;
    let n = 0;
    const { seen, fetch } = recorder(() => tokenAnswer(`t${++n}`));
    const token = credentialsFileToken(
      parseCredentialsFile(JSON.stringify(serviceAccount), "key"),
      { fetch, now: () => now },
    );
    expect(await Promise.all([token(), token()])).toEqual(["t1", "t1"]);
    now = new Date(NOW.getTime() + 50 * 60 * 1000);
    expect(await token()).toBe("t1");
    now = new Date(NOW.getTime() + 56 * 60 * 1000);
    expect(await token()).toBe("t2");
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe("https://oauth2.example/token");
    const form = new URLSearchParams(seen[0]?.init?.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
  });

  it("says why an exchange was refused", async () => {
    const { fetch } = recorder(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad key" }), {
          status: 400,
        }),
    );
    const token = credentialsFileToken(parseCredentialsFile(JSON.stringify(serviceAccount), "k"), {
      fetch,
    });
    const err = await token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GcsAuthError);
    expect((err as Error).message).toBe(
      "token for service account seshi@proj.iam.gserviceaccount.com: 400 invalid_grant: bad key",
    );
  });
});

describe("a credentials file", () => {
  it("takes gcloud's user credentials, trading the refresh token", async () => {
    const { seen, fetch } = recorder(() => tokenAnswer("user-token"));
    const file = parseCredentialsFile(
      JSON.stringify({
        type: "authorized_user",
        client_id: "cid",
        client_secret: "cs",
        refresh_token: "rt",
      }),
      "adc",
    );
    expect(await credentialsFileToken(file, { fetch })()).toBe("user-token");
    expect(seen[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.init?.body as string))).toEqual({
      grant_type: "refresh_token",
      client_id: "cid",
      client_secret: "cs",
      refresh_token: "rt",
    });
  });

  it("refuses other kinds by name, and what is not one", () => {
    expect(() =>
      parseCredentialsFile(JSON.stringify({ type: "external_account" }), "/k.json"),
    ).toThrow(/\/k\.json: credentials of type external_account are not supported/);
    expect(() => parseCredentialsFile("{", "/k.json")).toThrow(
      "/k.json is not a Google credentials JSON file",
    );
    expect(() =>
      parseCredentialsFile(JSON.stringify({ type: "service_account" }), "/k.json"),
    ).toThrow(StoreError);
  });
});

describe("the metadata server", () => {
  it("asks with Metadata-Flavor: Google, at GCE_METADATA_HOST when set", async () => {
    const { seen, fetch } = recorder(() => tokenAnswer("wi-token"));
    expect(await metadataServerToken({ GCE_METADATA_HOST: "10.0.0.9:8080" }, { fetch })()).toBe(
      "wi-token",
    );
    expect(seen[0]?.url).toBe(
      `http://10.0.0.9:8080/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(GCS_SCOPE)}`,
    );
    expect(seen[0]?.init?.headers).toEqual({ "metadata-flavor": "Google" });
  });

  it("says where credentials can come from when it does not answer", async () => {
    const token = metadataServerToken(
      {},
      {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      },
    );
    await expect(token()).rejects.toThrow(/no Google credentials: the metadata server/);
  });
});

describe("Application Default Credentials", () => {
  const files: Record<string, string> = {
    "/keys/sa.json": JSON.stringify(serviceAccount),
    [join("/home/me", ".config", "gcloud", "application_default_credentials.json")]: JSON.stringify(
      { type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" },
    ),
  };
  const read = (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  };
  const exists = (path: string) => path in files;
  const urlOf = async (env: Record<string, string>) => {
    const { seen, fetch } = recorder(() => tokenAnswer("t"));
    await applicationDefaultToken(env, { fetch, read, exists })();
    return seen[0]?.url;
  };

  it("takes GOOGLE_APPLICATION_CREDENTIALS, then gcloud's file, then the metadata server", async () => {
    expect(await urlOf({ GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json", HOME: "/home/me" })).toBe(
      "https://oauth2.example/token",
    );
    expect(await urlOf({ HOME: "/home/me" })).toBe("https://oauth2.googleapis.com/token");
    expect(await urlOf({ HOME: "/nobody" })).toContain(
      "http://metadata.google.internal/computeMetadata/v1/",
    );
  });

  it("fails at once when GOOGLE_APPLICATION_CREDENTIALS names no readable file", () => {
    expect(() =>
      applicationDefaultToken({ GOOGLE_APPLICATION_CREDENTIALS: "/keys/none.json" }, { read }),
    ).toThrow("cannot read Google credentials /keys/none.json");
  });
});
