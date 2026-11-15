/** The IdP flows against a stand-in IdP: an in-memory `fetch` that answers the discovery,
 * device and token endpoints the way RFC 8628, RFC 7636 and OIDC Core document them. Nothing
 * here reaches a real IdP. */

import { describe, expect, it } from "vitest";
import {
  browserFlow,
  type DeviceCode,
  type Discovery,
  deviceFlow,
  discover,
  peekClaims,
  pkceChallenge,
  refreshIdToken,
  SignInError,
  signInScopes,
} from "./oidc";

const ISSUER = "https://idp.test";
const DISCOVERY: Discovery = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`,
  authorization_endpoint: `${ISSUER}/authorize`,
  scopes_supported: ["openid", "email", "profile", "offline_access"],
};

/** An unsigned JWT-shaped token with these claims (the CLI never checks signatures). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

type Handler = (url: URL, body: URLSearchParams) => [number, unknown] | undefined;

function fakeFetch(handler: Handler, seen: { url: string; body: URLSearchParams }[] = []) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    seen.push({ url: url.toString(), body });
    const answer = handler(url, body) ?? [404, { error: "not_found" }];
    return new Response(JSON.stringify(answer[1]), { status: answer[0] });
  };
}

describe("discovery", () => {
  it("reads the document and checks the issuer", async () => {
    const ok = fakeFetch((url) =>
      url.pathname === "/.well-known/openid-configuration" ? [200, DISCOVERY] : undefined,
    );
    expect(await discover(`${ISSUER}/`, ok)).toEqual(DISCOVERY);
    const other = fakeFetch(() => [200, { ...DISCOVERY, issuer: "https://evil.test" }]);
    await expect(discover(ISSUER, other)).rejects.toThrow(/another issuer/);
    await expect(
      discover(
        ISSUER,
        fakeFetch(() => [500, {}]),
      ),
    ).rejects.toThrow(/answered 500/);
    const noToken = fakeFetch(() => [200, { issuer: ISSUER }]);
    await expect(discover(ISSUER, noToken)).rejects.toThrow(/token_endpoint/);
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(discover(ISSUER, down)).rejects.toMatchObject({ code: "idp_unreachable" });
  });

  it("refuses an endpoint that is not https (or http on this machine), and opens nothing", async () => {
    const keys = ["authorization_endpoint", "token_endpoint", "device_authorization_endpoint"];
    for (const bad of [
      "file:///etc/passwd",
      "smb://evil.test/share",
      "x-evil:run",
      "http://idp.test/a",
    ]) {
      for (const key of keys) {
        const doc = fakeFetch(() => [200, { ...DISCOVERY, [key]: bad }]);
        const opened: string[] = [];
        const signIn = discover(ISSUER, doc).then((discovery) =>
          browserFlow({
            discovery,
            clientId: "seshi-cli",
            scopes: ["openid"],
            fetch: doc,
            open: async (url) => {
              opened.push(url);
              return true;
            },
            prompt: () => {},
            timeoutMs: 10,
          }),
        );
        await expect(signIn).rejects.toThrow(new RegExp(`${key} that is not https`));
        expect(opened).toEqual([]);
      }
    }
    // An IdP on this machine may answer on plain http (development).
    const local = {
      ...DISCOVERY,
      issuer: "http://127.0.0.1:8080",
      authorization_endpoint: "http://127.0.0.1:8080/authorize",
      token_endpoint: "http://localhost:8080/token",
      device_authorization_endpoint: "http://[::1]:8080/device",
    };
    const ok = fakeFetch(() => [200, local]);
    expect(await discover("http://127.0.0.1:8080", ok)).toEqual(local);
  });

  it("asks for offline_access only where the IdP lists it", () => {
    const base = ["openid", "email", "profile"];
    expect(signInScopes(base, DISCOVERY)).toEqual([...base, "offline_access"]);
    expect(signInScopes(base, { ...DISCOVERY, scopes_supported: undefined })).toEqual(base);
  });
});

describe("the device flow (RFC 8628)", () => {
  it("shows the code, waits while pending, slows down when told, and returns the tokens", async () => {
    const polls: string[] = ["authorization_pending", "slow_down", "authorization_pending"];
    const slept: number[] = [];
    const shown: DeviceCode[] = [];
    const seen: { url: string; body: URLSearchParams }[] = [];
    const idToken = fakeIdToken({ sub: "alice" });
    const tokens = await deviceFlow({
      discovery: DISCOVERY,
      clientId: "seshi-cli",
      scopes: ["openid", "offline_access"],
      fetch: fakeFetch((url, body) => {
        if (url.pathname === "/device") {
          return [
            200,
            {
              device_code: "dc",
              user_code: "ABCD-EFGH",
              verification_url: `${ISSUER}/activate`,
              interval: 2,
              expires_in: 600,
            },
          ];
        }
        if (url.pathname === "/token") {
          expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
          expect(body.get("device_code")).toBe("dc");
          const next = polls.shift();
          return next ? [400, { error: next }] : [200, { id_token: idToken, refresh_token: "rt" }];
        }
        return undefined;
      }, seen),
      prompt: (code) => {
        shown.push(code);
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(tokens).toEqual({ id_token: idToken, refresh_token: "rt" });
    expect(shown).toEqual([
      { user_code: "ABCD-EFGH", verification_uri: `${ISSUER}/activate`, expires_in: 600 },
    ]);
    expect(slept).toEqual([2000, 2000, 7000, 7000]);
    expect(seen[0]?.body.get("scope")).toBe("openid offline_access");
    expect(seen[0]?.body.get("client_id")).toBe("seshi-cli");
  });

  it("stops when the person declines, the code expires, or the IdP refuses", async () => {
    const start = (error: string, status = 400) =>
      fakeFetch((url) =>
        url.pathname === "/device"
          ? [200, { device_code: "dc", user_code: "X", verification_uri: "u", interval: 0 }]
          : [status, { error }],
      );
    const run = (fetch: ReturnType<typeof fakeFetch>, now?: () => number) =>
      deviceFlow({
        discovery: DISCOVERY,
        clientId: "c",
        scopes: ["openid"],
        fetch,
        prompt: () => {},
        sleep: async () => {},
        ...(now ? { now } : {}),
      });
    await expect(run(start("access_denied"))).rejects.toMatchObject({ code: "denied" });
    await expect(run(start("expired_token"))).rejects.toMatchObject({ code: "expired" });
    await expect(run(start("invalid_client"))).rejects.toThrow(/invalid_client/);
    let t = 0;
    const clock = () => {
      t += 400_000;
      return t;
    };
    await expect(run(start("authorization_pending"), clock)).rejects.toMatchObject({
      code: "expired",
    });
    const refused = fakeFetch(() => [400, { error: "unauthorized_client" }]);
    await expect(run(refused)).rejects.toThrow(/refused the device sign-in: unauthorized_client/);
    await expect(
      deviceFlow({
        discovery: { ...DISCOVERY, device_authorization_endpoint: undefined },
        clientId: "c",
        scopes: [],
        fetch: refused,
        prompt: () => {},
      }),
    ).rejects.toThrow(/no device authorization endpoint/);
    const noId = fakeFetch((url) =>
      url.pathname === "/device"
        ? [200, { device_code: "dc", user_code: "X", verification_uri: "u", interval: 0 }]
        : [200, { access_token: "a" }],
    );
    await expect(run(noId)).rejects.toThrow(/without an ID token/);
  });
});

describe("the browser flow (PKCE, loopback redirect)", () => {
  it("sends the challenge, takes the redirect, and exchanges the code with the verifier", async () => {
    let authorizeUrl: URL | undefined;
    let tokenBody: URLSearchParams | undefined;
    const signedIn = await browserFlow({
      discovery: DISCOVERY,
      clientId: "seshi-cli",
      scopes: ["openid", "email"],
      fetch: fakeFetch((url, body) => {
        if (url.pathname !== "/token") return undefined;
        tokenBody = body;
        return [200, { id_token: fakeIdToken({ nonce: authorizeUrl?.searchParams.get("nonce") }) }];
      }),
      prompt: (url) => {
        authorizeUrl = new URL(url);
      },
      // The "browser": the person signs in, the IdP redirects back with the code.
      open: async (url) => {
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get("redirect_uri") as string);
        // A redirect for another sign-in is ignored.
        const stray = new URL(back);
        stray.searchParams.set("state", "not-ours");
        stray.searchParams.set("code", "x");
        expect((await fetch(stray)).status).toBe(400);
        back.searchParams.set("state", asked.searchParams.get("state") as string);
        back.searchParams.set("code", "the-code");
        const page = await fetch(back);
        expect(await page.text()).toContain("Signed in");
        return true;
      },
    });
    const asked = authorizeUrl as URL;
    expect(asked.origin + asked.pathname).toBe(`${ISSUER}/authorize`);
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(asked.searchParams.get("scope")).toBe("openid email");
    expect(tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(tokenBody?.get("code")).toBe("the-code");
    expect(pkceChallenge(tokenBody?.get("code_verifier") as string)).toBe(
      asked.searchParams.get("code_challenge"),
    );
    expect(signedIn.nonce).toBe(asked.searchParams.get("nonce"));
    expect(peekClaims(signedIn.id_token).nonce).toBe(signedIn.nonce);
  });

  it("reports the IdP's error, and gives up when the browser never comes back", async () => {
    const back = async (url: string, params: Record<string, string>) => {
      const asked = new URL(url);
      const target = new URL(asked.searchParams.get("redirect_uri") as string);
      target.searchParams.set("state", asked.searchParams.get("state") as string);
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      await fetch(target);
      return true;
    };
    const common = {
      discovery: DISCOVERY,
      clientId: "c",
      scopes: ["openid"],
      fetch: fakeFetch(() => [400, { error: "invalid_grant" }]),
      prompt: () => {},
    };
    await expect(
      browserFlow({ ...common, open: (url) => back(url, { error: "access_denied" }) }),
    ).rejects.toThrow(/access_denied/);
    await expect(
      browserFlow({ ...common, open: (url) => back(url, { code: "c" }) }),
    ).rejects.toThrow(/refused the code: invalid_grant/);
    await expect(
      browserFlow({ ...common, open: async () => false, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(SignInError);
  });
});

describe("refresh", () => {
  it("returns a new ID token, and says when the IdP refuses the refresh token", async () => {
    const id = fakeIdToken({ sub: "alice", nonce: "n1" });
    const ok = fakeFetch((_url, body) =>
      body.get("refresh_token") === "rt"
        ? [200, { id_token: id, refresh_token: "rt2" }]
        : undefined,
    );
    const options = { tokenEndpoint: `${ISSUER}/token`, clientId: "c", fetch: ok };
    expect(await refreshIdToken({ ...options, refreshToken: "rt" })).toEqual({
      id_token: id,
      refresh_token: "rt2",
    });
    const refused = fakeFetch(() => [400, { error: "invalid_grant" }]);
    await expect(
      refreshIdToken({ ...options, fetch: refused, refreshToken: "old" }),
    ).rejects.toMatchObject({ code: "refresh_refused" });
    expect(peekClaims(id)).toEqual({ sub: "alice", nonce: "n1" });
    expect(peekClaims("garbage")).toEqual({});
  });
});
