import { generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { IdTokenError, OidcVerifier } from "./oidc";
import { FakeIdp } from "./testing";

const at = new Date("2026-11-14T09:00:00.000Z");
let idp: FakeIdp;

beforeAll(async () => {
  idp = await FakeIdp.create({ now: () => at });
});

const verifier = (options: Partial<ConstructorParameters<typeof OidcVerifier>[0]> = {}) =>
  new OidcVerifier({
    issuer: idp.issuer,
    audience: idp.audience,
    keys: idp.keys,
    now: () => at,
    ...options,
  });

describe("ID token checks (X5.2)", () => {
  it("accept a token signed by the IdP for this audience, with its nonce", async () => {
    const token = await idp.idToken({ email: "alice@acme.com", nonce: "n-1" });
    const claims = await verifier().verify(token, "n-1");
    expect(claims).toMatchObject({ sub: "00uAlice", email: "alice@acme.com" });
  });

  it("find the keys through the discovery document, once", async () => {
    const requests: string[] = [];
    const v = new OidcVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      fetch: idp.fetcher(requests),
      now: () => at,
    });
    await v.verify(await idp.idToken());
    await v.verify(await idp.idToken());
    expect(requests).toEqual([
      `${idp.issuer}/.well-known/openid-configuration`,
      `${idp.issuer}/jwks`,
    ]);
  });

  it("refuse a discovery document that names another issuer, and try again later", async () => {
    let calls = 0;
    const v = new OidcVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      fetch: async (url) => {
        calls++;
        if (calls === 1)
          return Response.json({ issuer: "https://evil.test", jwks_uri: "https://evil.test/k" });
        return idp.fetcher()(url);
      },
      now: () => at,
    });
    await expect(v.verify(await idp.idToken())).rejects.toThrow("names another issuer");
    await expect(v.verify(await idp.idToken())).resolves.toBeDefined();
  });

  it("refuse the wrong issuer, audience, an expired token, another key, or HS256", async () => {
    const v = verifier();
    const refused = async (token: string) => {
      await expect(v.verify(token)).rejects.toBeInstanceOf(IdTokenError);
    };
    await refused(await idp.idToken({ iss: "https://other.test" }));
    await refused(await idp.idToken({ aud: "another-deployment" }));
    await refused(await idp.idToken({}, { ttlSeconds: -120 }));
    const { privateKey } = await generateKeyPair("RS256");
    await refused(await idp.idToken({}, { key: privateKey }));
    await refused(
      await idp.idToken(
        {},
        { alg: "HS256", key: new TextEncoder().encode("x".repeat(32)) as unknown as CryptoKey },
      ),
    );
    await refused("not.a.token");
  });

  it("allow a minute of clock skew", async () => {
    await expect(
      verifier().verify(await idp.idToken({}, { ttlSeconds: -30 })),
    ).resolves.toBeDefined();
  });

  it("match the nonce when either side has one", async () => {
    const v = verifier();
    await expect(v.verify(await idp.idToken({ nonce: "a" }), "b")).rejects.toThrow("nonce");
    await expect(v.verify(await idp.idToken({ nonce: "a" }))).rejects.toThrow("nonce");
    await expect(v.verify(await idp.idToken(), "a")).rejects.toThrow("nonce");
    // The device flow has no nonce on either side.
    await expect(v.verify(await idp.idToken())).resolves.toBeDefined();
  });
});
