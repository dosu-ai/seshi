import type { Fetch } from "@seshi/model";
import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

/** Asymmetric algorithms only: an ID token signed with a shared secret could have been made by
 * anyone holding the client secret, and a public client has none. */
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

const CLOCK_TOLERANCE_SECONDS = 60;

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdTokenError";
  }
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  fetch?: Fetch;
  keys?: JWTVerifyGetKey;
  now?: () => Date;
}

export class OidcVerifier {
  private keys: Promise<JWTVerifyGetKey> | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: OidcVerifierOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.keys) this.keys = Promise.resolve(options.keys);
  }

  /** The IdP's keys, from the `jwks_uri` of its discovery document; fetched once, and again
   * after a failure. jose refetches the key set itself when a token names a key it lacks. */
  private keySet(): Promise<JWTVerifyGetKey> {
    this.keys ??= this.discover().catch((err) => {
      this.keys = undefined;
      throw err;
    });
    return this.keys;
  }

  private async discover(): Promise<JWTVerifyGetKey> {
    const fetchImpl = this.options.fetch ?? ((input, init) => fetch(input, init));
    const url = `${this.options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new IdTokenError(`the IdP's discovery document answered ${response.status}`);
    }
    const doc = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
    if (doc.issuer !== this.options.issuer) {
      throw new IdTokenError("the IdP's discovery document names another issuer");
    }
    if (typeof doc.jwks_uri !== "string" || !doc.jwks_uri.startsWith("https://")) {
      throw new IdTokenError("the IdP's discovery document has no https jwks_uri");
    }
    return createRemoteJWKSet(new URL(doc.jwks_uri), {
      [customFetch]: (input, init) => fetchImpl(input, init),
    });
  }

  /** The ID token's claims when it is valid for this deployment. `nonce` is the one the CLI
   * sent in its sign-in request: when either side has one, both must, and they must match.
   * Throws `IdTokenError` saying what was wrong (the API answers 401 without the detail). */
  async verify(idToken: string, nonce?: string): Promise<JWTPayload> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, await this.keySet(), {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALGORITHMS,
        currentDate: this.now(),
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp", "iat"],
      }));
    } catch (err) {
      if (err instanceof IdTokenError) throw err;
      throw new IdTokenError(`ID token refused: ${err instanceof Error ? err.message : err}`);
    }
    const given = payload.nonce;
    if ((nonce !== undefined || given !== undefined) && given !== nonce) {
      throw new IdTokenError("ID token refused: the nonce does not match the sign-in request");
    }
    return payload;
  }
}
