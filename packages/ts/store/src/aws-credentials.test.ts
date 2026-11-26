import { describe, expect, it } from "vitest";
import {
  AwsCredentialsError,
  containerCredentials,
  instanceCredentials,
  roleCredentials,
} from "./aws-credentials";
import { StoreError } from "./store";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MINUTE = 60 * 1000;

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function recorder(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const request = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    seen.push(request);
    return respond(request);
  };
  return { seen, fetch };
}

const keys = (id: string, expiration: string) =>
  new Response(
    JSON.stringify({
      AccessKeyId: id,
      SecretAccessKey: `secret-${id}`,
      Token: `token-${id}`,
      Expiration: expiration,
      RoleArn: "arn:aws:iam::123456789012:role/seshi",
    }),
  );

/** A clock the test moves. */
function clock() {
  let now = NOW.getTime();
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

describe("an ECS task's credentials", () => {
  const ecs = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" };

  it("are asked of ECS's agent at the relative URI, and kept until five minutes before they expire", async () => {
    const time = clock();
    let n = 0;
    const { seen, fetch } = recorder(() => keys(`ASIA${++n}`, at(60 * MINUTE)));
    const source = containerCredentials(ecs, { fetch, now: time.now });
    expect(await source?.()).toEqual({
      accessKeyId: "ASIA1",
      secretAccessKey: "secret-ASIA1",
      sessionToken: "token-ASIA1",
    });
    expect(seen).toEqual([
      { method: "GET", url: "http://169.254.170.2/v2/credentials/task-1", headers: {} },
    ]);

    time.advance(54 * MINUTE);
    expect((await source?.())?.accessKeyId).toBe("ASIA1");
    expect(seen).toHaveLength(1);

    time.advance(1 * MINUTE + 1);
    expect((await source?.())?.accessKeyId).toBe("ASIA2");
    expect(seen).toHaveLength(2);
  });

  it("are kept for half their life when they come with less than ten minutes left", async () => {
    const time = clock();
    let n = 0;
    const { seen, fetch } = recorder(() => keys(`ASIA${++n}`, at(4 * MINUTE)));
    const source = containerCredentials(ecs, { fetch, now: time.now });
    await source?.();
    time.advance(2 * MINUTE - 1);
    expect((await source?.())?.accessKeyId).toBe("ASIA1");
    time.advance(2);
    expect((await source?.())?.accessKeyId).toBe("ASIA2");
    expect(seen).toHaveLength(2);
  });

  it("are fetched once for callers that ask at the same time", async () => {
    const { seen, fetch } = recorder(() => keys("ASIA1", at(60 * MINUTE)));
    const source = containerCredentials(ecs, { fetch, now: () => NOW });
    const all = await Promise.all([source?.(), source?.(), source?.()]);
    expect(all.map((c) => c?.accessKeyId)).toEqual(["ASIA1", "ASIA1", "ASIA1"]);
    expect(seen).toHaveLength(1);
  });

  it("are asked for again on the next call after a failure", async () => {
    let fail = true;
    const { seen, fetch } = recorder(() =>
      fail ? new Response("agent starting", { status: 500 }) : keys("ASIA1", at(60 * MINUTE)),
    );
    const source = containerCredentials(ecs, { fetch, now: () => NOW });
    const err = await source?.().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsCredentialsError);
    expect(err).toBeInstanceOf(StoreError);
    expect(String((err as Error).message)).toContain("500: agent starting");
    fail = false;
    expect((await source?.())?.accessKeyId).toBe("ASIA1");
    expect(seen).toHaveLength(2);
  });

  it("say which endpoint did not answer", async () => {
    const source = containerCredentials(ecs, {
      fetch: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });
    await expect(source?.()).rejects.toThrow(/no answer from 169\.254\.170\.2 within 5 s/);
  });

  it("refuse an answer without keys, or one that is not JSON", async () => {
    const empty = containerCredentials(ecs, {
      fetch: async () => new Response(JSON.stringify({ Token: "t" })),
    });
    await expect(empty?.()).rejects.toThrow(/no AccessKeyId and SecretAccessKey/);
    const html = containerCredentials(ecs, { fetch: async () => new Response("<html>") });
    await expect(html?.()).rejects.toThrow(/not JSON/);
  });

  it("are not looked for without a container URI", () => {
    expect(containerCredentials({})).toBeUndefined();
  });
});

describe("container credentials at a full URI (EKS Pod Identity)", () => {
  const eks = { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials" };

  it("send the token from the token file, read again at each renewal", async () => {
    const time = clock();
    let file = "token-1\n";
    const { seen, fetch } = recorder(() => keys("ASIA1", at(10 * MINUTE)));
    const source = containerCredentials(
      { ...eks, AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/token" },
      {
        fetch,
        now: time.now,
        readFile: (path) => {
          expect(path).toBe("/var/run/token");
          return file;
        },
      },
    );
    await source?.();
    file = "token-2";
    time.advance(6 * MINUTE);
    await source?.();
    expect(seen.map((s) => [s.url, s.headers.authorization])).toEqual([
      ["http://169.254.170.23/v1/credentials", "token-1"],
      ["http://169.254.170.23/v1/credentials", "token-2"],
    ]);
  });

  it("send AWS_CONTAINER_AUTHORIZATION_TOKEN when there is no token file", async () => {
    const { seen, fetch } = recorder(() => keys("ASIA1", at(60 * MINUTE)));
    await containerCredentials(
      { ...eks, AWS_CONTAINER_AUTHORIZATION_TOKEN: "Basic abc" },
      { fetch },
    )?.();
    expect(seen[0]?.headers.authorization).toBe("Basic abc");
  });

  it("take https anywhere, and plain http only to the agents or this machine", () => {
    const uri = (value: string) => ({ AWS_CONTAINER_CREDENTIALS_FULL_URI: value });
    for (const ok of [
      "https://creds.example/x",
      "http://169.254.170.2/x",
      "http://[fd00:ec2::23]/x",
      "http://127.0.0.1:51679/x",
      "http://localhost:8080/x",
      "http://[::1]/x",
    ]) {
      expect(containerCredentials(uri(ok))).toBeTypeOf("function");
    }
    expect(() => containerCredentials(uri("http://creds.example/x"))).toThrow(/must be https/);
    expect(() => containerCredentials(uri("not a url"))).toThrow(/is not a URL/);
  });

  it("are the relative URI's when both are set, as the AWS SDKs do", async () => {
    const { seen, fetch } = recorder(() => keys("ASIA1", at(60 * MINUTE)));
    await containerCredentials(
      { ...eks, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x" },
      { fetch },
    )?.();
    expect(seen[0]?.url).toBe("http://169.254.170.2/v2/credentials/x");
  });
});

describe("an EC2 instance's credentials (IMDSv2)", () => {
  function imds(role = "seshi-role", expiration = at(6 * 60 * MINUTE)) {
    let n = 0;
    return recorder(({ method, url }) => {
      if (method === "PUT" && url.endsWith("/latest/api/token")) {
        return new Response(`session-${++n}`);
      }
      if (url.endsWith("/security-credentials/")) {
        return role ? new Response(`${role}\n`) : new Response("", { status: 404 });
      }
      if (url.endsWith(`/security-credentials/${role}`)) {
        return new Response(
          JSON.stringify({
            Code: "Success",
            Type: "AWS-HMAC",
            AccessKeyId: `ASIA${n}`,
            SecretAccessKey: "s",
            Token: "t",
            Expiration: expiration,
          }),
        );
      }
      return new Response("", { status: 404 });
    });
  }

  it("take a session token, find the role, then fetch its keys with the token", async () => {
    const { seen, fetch } = imds();
    const source = instanceCredentials({}, { fetch, now: () => NOW });
    expect(await source?.()).toEqual({
      accessKeyId: "ASIA1",
      secretAccessKey: "s",
      sessionToken: "t",
    });
    expect(seen).toEqual([
      {
        method: "PUT",
        url: "http://169.254.169.254/latest/api/token",
        headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
      },
      {
        method: "GET",
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        headers: { "x-aws-ec2-metadata-token": "session-1" },
      },
      {
        method: "GET",
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/seshi-role",
        headers: { "x-aws-ec2-metadata-token": "session-1" },
      },
    ]);
  });

  it("are renewed with a new session token five minutes before they expire", async () => {
    const time = clock();
    const { seen, fetch } = imds("seshi-role", at(60 * MINUTE));
    const source = instanceCredentials({}, { fetch, now: time.now });
    await source?.();
    time.advance(56 * MINUTE);
    expect((await source?.())?.accessKeyId).toBe("ASIA2");
    expect(seen.filter((s) => s.method === "PUT")).toHaveLength(2);
  });

  it("say so when the instance has no role", async () => {
    const { fetch } = imds("");
    await expect(instanceCredentials({}, { fetch })?.()).rejects.toThrow(/has no IAM role/);
  });

  it("refuse an answer whose Code is not Success", async () => {
    const source = instanceCredentials(
      {},
      {
        fetch: async (url: string, init?: RequestInit) => {
          if (init?.method === "PUT") return new Response("session");
          if (url.endsWith("/")) return new Response("seshi-role");
          return new Response(JSON.stringify({ Code: "AssumeRoleUnauthorizedAccess" }));
        },
      },
    );
    await expect(source?.()).rejects.toThrow(/AssumeRoleUnauthorizedAccess/);
  });

  it("go to the endpoint the environment names, or IMDS's IPv6 address", async () => {
    const custom = imds();
    await instanceCredentials(
      { AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://imds.test:1338/" },
      { fetch: custom.fetch },
    )?.();
    expect(custom.seen[0]?.url).toBe("http://imds.test:1338/latest/api/token");
    const v6 = imds();
    await instanceCredentials(
      { AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: "IPv6" },
      { fetch: v6.fetch },
    )?.();
    expect(v6.seen[0]?.url).toBe("http://[fd00:ec2::254]/latest/api/token");
  });

  it("are not looked for when instance metadata is turned off", () => {
    expect(instanceCredentials({ AWS_EC2_METADATA_DISABLED: "true" })).toBeUndefined();
  });
});

describe("a role's credentials", () => {
  it("are the container's when there is a container URI, else the instance's", async () => {
    const { seen, fetch } = recorder(({ method }) =>
      method === "PUT" ? new Response("session") : keys("ASIA1", at(60 * MINUTE)),
    );
    await roleCredentials({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/x" }, { fetch })?.();
    expect(seen.map((s) => s.url)).toEqual(["http://169.254.170.2/v2/x"]);
    expect(roleCredentials({})).toBeTypeOf("function");
    expect(roleCredentials({ AWS_EC2_METADATA_DISABLED: "true" })).toBeUndefined();
  });

  it("refuse a web identity rather than fall through to the node's instance role", () => {
    const irsa = {
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/seshi",
    };
    expect(() => roleCredentials(irsa)).toThrow(/AWS_WEB_IDENTITY_TOKEN_FILE.*not support/);
    expect(() =>
      roleCredentials({ ...irsa, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/x" }),
    ).toThrow(/EKS Pod Identity/);
  });
});
