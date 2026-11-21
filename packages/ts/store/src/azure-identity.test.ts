import { describe, expect, it } from "vitest";
import {
  AzureIdentityError,
  type IdentitySlot,
  workloadIdentity,
  workloadIdentityFromEnv,
} from "./azure-identity";

describe("workload identity", () => {
  function identity(
    answers: Response[],
    start = new Date("2026-11-20T09:00:00Z"),
    cache = new Map<string, IdentitySlot>(),
  ) {
    let now = start.getTime();
    const sent: { url: string; form: URLSearchParams }[] = [];
    let reads = 0;
    const token = workloadIdentity({
      tokenFile: "/var/run/secrets/azure/tokens/azure-identity-token",
      clientId: "client-1",
      tenantId: "tenant-1",
      authorityHost: "https://login.test",
      cache,
      read: async () => `federated-${++reads}\n`,
      now: () => new Date(now),
      fetch: async (input: string, init?: RequestInit) => {
        sent.push({ url: input, form: new URLSearchParams(String(init?.body)) });
        return answers.shift() as Response;
      },
    });
    return { token, sent, advance: (ms: number) => (now += ms) };
  }
  const issued = (token: string, seconds = 3600) =>
    new Response(JSON.stringify({ access_token: token, expires_in: seconds }));

  it("exchanges the federated token for a storage token, and keeps it until near expiry", async () => {
    const { token, sent, advance } = identity([issued("one"), issued("two")]);
    expect(await Promise.all([token(), token()])).toEqual(["one", "one"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://login.test/tenant-1/oauth2/v2.0/token");
    expect(Object.fromEntries(sent[0]?.form ?? [])).toEqual({
      client_id: "client-1",
      scope: "https://storage.azure.com/.default",
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: "federated-1",
    });
    advance(50 * 60 * 1000);
    expect(await token()).toBe("one");
    advance(6 * 60 * 1000);
    expect(await token()).toBe("two");
    // The kubelet rotates the file: each exchange reads it again.
    expect(sent[1]?.form.get("client_assertion")).toBe("federated-2");
  });

  it("throws Entra's error, and tries again on the next call", async () => {
    const { token } = identity([
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
      issued("ok"),
    ]);
    const err = await token().catch((e) => e);
    expect(err).toBeInstanceOf(AzureIdentityError);
    expect(err).toMatchObject({ status: 401, code: "invalid_client" });
    expect(await token()).toBe("ok");
  });

  it("shares one token among the functions made for the same identity", async () => {
    const cache = new Map<string, IdentitySlot>();
    const first = identity([issued("shared")], undefined, cache);
    const second = identity([issued("unused")], undefined, cache);
    expect(await first.token()).toBe("shared");
    expect(await second.token()).toBe("shared");
    expect(second.sent).toHaveLength(0);
  });

  it("is set up from the variables AKS injects, and only when all are there", () => {
    const env = {
      AZURE_FEDERATED_TOKEN_FILE: "/t",
      AZURE_CLIENT_ID: "c",
      AZURE_TENANT_ID: "t",
    };
    expect(workloadIdentityFromEnv(env)).toBeTypeOf("function");
    expect(workloadIdentityFromEnv({ ...env, AZURE_TENANT_ID: undefined })).toBeUndefined();
  });
});
