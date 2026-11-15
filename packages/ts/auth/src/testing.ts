/** A stand-in IdP for tests (`@seshi/auth/testing`): an RS256 key pair, its key set, a `fetch`
 * that serves the discovery document and the keys, and ID tokens signed with the key. Nothing
 * here talks to a real IdP. */

import type { Fetch } from "@seshi/model";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";

export interface FakeIdpOptions {
  issuer?: string;
  /** The audience its ID tokens carry by default. */
  audience?: string;
  now?: () => Date;
}

export class FakeIdp {
  readonly issuer: string;
  readonly audience: string;
  private readonly now: () => Date;

  private constructor(
    private readonly privateKey: CryptoKey,
    readonly jwks: JSONWebKeySet,
    options: FakeIdpOptions,
  ) {
    this.issuer = options.issuer ?? "https://idp.test";
    this.audience = options.audience ?? "seshi-cli";
    this.now = options.now ?? (() => new Date());
  }

  static async create(options: FakeIdpOptions = {}): Promise<FakeIdp> {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    return new FakeIdp(privateKey, { keys: [jwk] }, options);
  }

  /** The key set as `OidcVerifier` takes it. */
  get keys(): JWTVerifyGetKey {
    return createLocalJWKSet(this.jwks);
  }

  /** Serves `<issuer>/.well-known/openid-configuration` and `<issuer>/jwks`; 404 otherwise.
   * `requests` records each URL asked for. */
  fetcher(requests: string[] = []): Fetch {
    return async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === `${this.issuer}/.well-known/openid-configuration`) {
        return Response.json({ issuer: this.issuer, jwks_uri: `${this.issuer}/jwks` });
      }
      if (url === `${this.issuer}/jwks`) return Response.json(this.jwks);
      return new Response("not found", { status: 404 });
    };
  }

  /** An ID token: `sub`, `iss`, `aud`, `iat` and `exp` (5 minutes) set, overridable by
   * `claims`; `{ key }` signs with another private key. */
  async idToken(
    claims: JWTPayload & Record<string, unknown> = {},
    options: { key?: CryptoKey; alg?: string; ttlSeconds?: number } = {},
  ): Promise<string> {
    const iat = Math.floor(this.now().getTime() / 1000);
    const { iss, aud, sub, exp, iat: iatClaim, ...rest } = claims;
    return new SignJWT(rest)
      .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "test-key" })
      .setIssuer(iss ?? this.issuer)
      .setAudience(aud ?? this.audience)
      .setSubject(sub ?? "00uAlice")
      .setIssuedAt(iatClaim ?? iat)
      .setExpirationTime(exp ?? iat + (options.ttlSeconds ?? 300))
      .sign(options.key ?? this.privateKey);
  }
}
