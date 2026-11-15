/** Session tokens (X5.2, X5.9): what an IdP sign-in is exchanged for, for interactive commands.
 * A JWT the server signs with a key only it holds (`[auth.session_keys]`, HS256), one hour long,
 * checked without a bucket read. Each key has an id (`kid`), so a new key can sign while old
 * ones still verify until their tokens expire. The audience names the deployment (X1.4), so a
 * token from another deployment that happens to share a key is refused. Not stored, so not
 * revocable: removing a person from the IdP ends their interactive access within the hour
 * (X5.11). */

import { randomBytes } from "node:crypto";
import { errors, jwtVerify, SignJWT } from "jose";
import type { Role, Scope } from "./scopes";
import { isScope } from "./scopes";

/** One hour (X5.9). */
export const SESSION_TOKEN_SECONDS = 3600;
/** The least a signing key may be: an HMAC key shorter than its hash is a guessable one. */
export const MIN_SESSION_KEY_LENGTH = 32;
const ISSUER = "seshi";
const KID = /^[A-Za-z0-9._-]{1,64}$/;

export interface SessionClaims {
  /** The person's owner id (X5.8). */
  owner: string;
  role: Exclude<Role, "service">;
  scopes: Scope[];
  /** The token's id, recorded as the credential id of what it does (X5.5). */
  id: string;
  issued_at: Date;
  expires_at: Date;
  email?: string;
  name?: string;
}

export interface SessionTokenOptions {
  /** Key id to secret. */
  keys: Readonly<Record<string, string>>;
  /** The key that signs; the only key when there is one. */
  signingKeyId?: string;
  /** The deployment the tokens are for (`seshi.json`'s `deployment_id`). */
  deployment: string;
  now?: () => Date;
}

export class SessionTokens {
  private readonly keys: Map<string, Uint8Array>;
  private readonly signingKeyId: string;
  private readonly audience: string;
  private readonly now: () => Date;

  /** Throws for a key that is too short, a bad key id, or no key to sign with. */
  constructor(options: SessionTokenOptions) {
    this.keys = new Map();
    for (const [kid, secret] of Object.entries(options.keys)) {
      if (!KID.test(kid)) throw new Error(`auth.session_keys: '${kid}' is not a valid key id`);
      if (secret.length < MIN_SESSION_KEY_LENGTH) {
        throw new Error(
          `auth.session_keys.${kid} must be ${MIN_SESSION_KEY_LENGTH}+ characters (try: openssl rand -hex 32)`,
        );
      }
      this.keys.set(kid, new TextEncoder().encode(secret));
    }
    const kid =
      options.signingKeyId ?? (this.keys.size === 1 ? [...this.keys.keys()][0] : undefined);
    if (kid === undefined || !this.keys.has(kid)) {
      throw new Error("auth.session_key_id must name a key in auth.session_keys");
    }
    this.signingKeyId = kid;
    this.audience = `seshi:${options.deployment}`;
    this.now = options.now ?? (() => new Date());
  }

  /** A new session token for a signed-in person. */
  async sign(claims: {
    owner: string;
    role: Exclude<Role, "service">;
    scopes: readonly Scope[];
    email?: string;
    name?: string;
  }): Promise<{ token: string; id: string; expires_at: Date }> {
    const issued = Math.floor(this.now().getTime() / 1000);
    const id = randomBytes(12).toString("base64url");
    const exp = issued + SESSION_TOKEN_SECONDS;
    const token = await new SignJWT({
      role: claims.role,
      scope: claims.scopes.join(" "),
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.name ? { name: claims.name } : {}),
    })
      .setProtectedHeader({ alg: "HS256", kid: this.signingKeyId, typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(this.audience)
      .setSubject(claims.owner)
      .setJti(id)
      .setIssuedAt(issued)
      .setExpirationTime(exp)
      .sign(this.keys.get(this.signingKeyId) as Uint8Array);
    return { token, id, expires_at: new Date(exp * 1000) };
  }

  /** The claims of a token this server signed and that has not expired; undefined for anything
   * else. */
  async verify(token: string): Promise<SessionClaims | undefined> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid === undefined ? undefined : this.keys.get(header.kid);
          if (key === undefined) throw new errors.JWKSNoMatchingKey();
          return key;
        },
        {
          algorithms: ["HS256"],
          issuer: ISSUER,
          audience: this.audience,
          currentDate: this.now(),
          requiredClaims: ["sub", "exp", "iat", "jti"],
        },
      );
      const role = payload.role;
      if (role !== "member" && role !== "admin") return undefined;
      const scopes =
        typeof payload.scope === "string" ? payload.scope.split(" ").filter((s) => s !== "") : [];
      if (!scopes.every(isScope)) return undefined;
      return {
        owner: payload.sub as string,
        role,
        scopes: scopes as Scope[],
        id: payload.jti as string,
        issued_at: new Date((payload.iat as number) * 1000),
        expires_at: new Date((payload.exp as number) * 1000),
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

/** Whether a token looks like a JWT (three dot-separated parts), not an opaque token. */
export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}
