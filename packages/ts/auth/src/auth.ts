import { type Claims, type Fetch, Unauthorized, type Visibility } from "@seshi/model";
import { isOwner, type Store, type TokenKind, type TokenRecord } from "@seshi/store";
import type { JWTVerifyGetKey } from "jose";
import { idTokenClaims, pickClaims } from "./claims";
import { IdTokenError, OidcVerifier } from "./oidc";
import { isOpaqueToken, secretsEqual } from "./opaque";
import { claimOwner, isServiceOwner, OwnerAliases, serviceOwner, usernameOwner } from "./owner";
import type { Principal } from "./principal";
import { CREDENTIAL_SCOPES, type Role, type Scope, serviceScopesValid } from "./scopes";
import { looksLikeJwt, SESSION_TOKEN_SECONDS, SessionTokens } from "./session-token";
import type { AuthSettings } from "./settings";
import { type IssueOptions, TokenService } from "./tokens";

export const DEVICE_TOKEN_DAYS = 90;
export const USER_HEADER = "x-seshi-user";
export const OIDC_SCOPES = ["openid", "email", "profile"] as const;
export type OrgKeyOwner = "*";
export const ORG_KEY_OWNER: OrgKeyOwner = "*";

const MACHINE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function staticCredentialId(owner: string): string {
  return `static-${owner}`;
}

export interface AuthOptions {
  store: Store;
  deployment: string;
  now?: () => Date;
  fetch?: Fetch;
  oidcKeys?: JWTVerifyGetKey;
  sources?: readonly string[];
  tokenCacheMs?: number;
}

export interface AuthModes {
  org_key: boolean;
  oidc: {
    issuer: string;
    client_id: string;
    audience: string;
    scopes: string[];
  } | null;
  session_token_seconds: number;
  delete_fresh_seconds: number;
}

export interface ExchangeRequest {
  id_token: string;
  nonce?: string;
  machine?: { id: string; name?: string };
  visibility?: Visibility;
}

export interface ExchangeResult {
  session_token: string;
  expires_at: string;
  owner: string;
  role: Exclude<Role, "service">;
  scopes: Scope[];
  device_token?: { token: string; id: string; expires_at: string };
}

export interface TokenRequest {
  kind: TokenKind;
  owner?: string;
  service?: string;
  scopes?: Scope[];
  visibility?: Visibility;
  expires_at?: Date | null;
  label?: string;
}

export class AuthRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

export class AdminInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminInitError";
  }
}

/** `value` as a person's owner id, exactly as given (an IdP subject is case-sensitive);
 * undefined when it is not one. */
function personOwner(value: string | undefined): string | undefined {
  const owner = value?.trim();
  return owner && isOwner(owner) && !isServiceOwner(owner) ? owner : undefined;
}

export class Auth {
  readonly tokens: TokenService;
  readonly aliases: OwnerAliases;
  readonly sessions: SessionTokens | undefined;
  readonly oidc: OidcVerifier | undefined;
  private readonly now: () => Date;
  private sources: ReadonlySet<string> | undefined;

  constructor(
    readonly settings: AuthSettings,
    options: AuthOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.tokens = new TokenService(options.store, {
      now: this.now,
      ...(options.tokenCacheMs !== undefined ? { cacheMs: options.tokenCacheMs } : {}),
    });
    this.aliases = new OwnerAliases(settings.aliases);
    this.sessions =
      Object.keys(settings.sessionKeys).length > 0
        ? new SessionTokens({
            keys: settings.sessionKeys,
            signingKeyId: settings.signingKeyId,
            deployment: options.deployment,
            now: this.now,
          })
        : undefined;
    if (settings.oidc && this.sessions === undefined) {
      throw new Error("auth.oidc needs a key in auth.session_keys to sign session tokens");
    }
    this.oidc = settings.oidc
      ? new OidcVerifier({
          issuer: settings.oidc.issuer,
          audience: settings.oidc.audience,
          now: this.now,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.oidcKeys ? { keys: options.oidcKeys } : {}),
        })
      : undefined;
    this.sources = options.sources ? new Set(options.sources) : undefined;
  }

  /** The configured source ids a writing service token may act for (a config reload). */
  setSources(ids: readonly string[]): void {
    this.sources = new Set(ids);
  }

  modes(): AuthModes {
    const { oidc } = this.settings;
    return {
      org_key: this.settings.orgKey,
      oidc: oidc
        ? {
            issuer: oidc.issuer,
            client_id: oidc.client_id,
            audience: oidc.audience,
            scopes: [...OIDC_SCOPES],
          }
        : null,
      session_token_seconds: SESSION_TOKEN_SECONDS,
      delete_fresh_seconds: 600,
    };
  }

  /** The principal a bearer token stands for. `user` is the `X-Seshi-User` header, which an
   * org-key caller must send (X5.12) and anyone else may leave out. Throws `Unauthorized` for
   * anything it does not accept, with no detail beyond what the caller can fix. */
  async authenticate(token: string | undefined, user?: string): Promise<Principal> {
    if (!token) throw new Unauthorized();
    const fixed = this.settings.staticTokens.find((t) => secretsEqual(t.token, token));
    if (fixed) return this.staticPrincipal(fixed.owner);
    if (isOpaqueToken(token)) {
      const record = await this.tokens.verify(token);
      if (!record) throw new Unauthorized();
      return this.recordPrincipal(record, user);
    }
    if (looksLikeJwt(token) && this.sessions) {
      const claims = await this.sessions.verify(token);
      if (!claims) throw new Unauthorized();
      return {
        kind: claims.role === "admin" ? "admin" : "person",
        owner: claims.owner,
        owner_basis: "verified",
        role: claims.role,
        scopes: new Set(claims.scopes),
        credential: "session",
        credential_id: claims.id,
        issued_at: claims.issued_at,
        expires_at: claims.expires_at,
        claims: {
          ...(claims.email ? { email: claims.email } : {}),
          ...(claims.name ? { name: claims.name } : {}),
        },
      };
    }
    throw new Unauthorized();
  }

  private staticPrincipal(owner: string): Principal {
    return {
      kind: "static",
      owner,
      owner_basis: "verified",
      role: "member",
      scopes: new Set(CREDENTIAL_SCOPES.static),
      credential: "static",
      credential_id: staticCredentialId(owner),
      claims: {},
    };
  }

  private recordPrincipal(record: TokenRecord, user: string | undefined): Principal {
    const common = {
      scopes: new Set(record.scopes as Scope[]),
      credential_id: record.id,
      ...(record.visibility ? { visibility: record.visibility } : {}),
      ...(record.expires_at ? { expires_at: new Date(record.expires_at) } : {}),
    };
    switch (record.kind) {
      case "org": {
        if (!this.settings.orgKey) throw new Unauthorized("the org key is turned off");
        const owner = user === undefined ? undefined : usernameOwner(user);
        if (owner === undefined) {
          throw new Unauthorized("the org key needs the username in the X-Seshi-User header");
        }
        return {
          ...common,
          kind: "person",
          owner,
          owner_basis: "claimed",
          role: "member",
          credential: "org_key",
          claims: pickClaims({ username: user }) ?? {},
        };
      }
      case "admin":
        return {
          ...common,
          kind: "admin",
          owner: record.owner,
          owner_basis: "verified",
          role: "admin",
          credential: "admin",
          claims: record.claims ?? {},
        };
      case "device":
        return {
          ...common,
          kind: "device",
          owner: record.owner,
          owner_basis: record.owner_basis ?? "verified",
          role: "member",
          credential: "device",
          claims: record.claims ?? {},
        };
      case "service":
        return {
          ...common,
          kind: "service",
          owner: record.owner,
          owner_basis: "service",
          role: "service",
          credential: "service",
          claims: {},
        };
      default:
        throw new Unauthorized();
    }
  }

  /** Check an IdP ID token and answer a session token, and a device token when the request
   * names a machine (its first sign-in there, or a renewal: earlier device tokens for that
   * machine are revoked). Throws `AuthRequestError` (`no_idp`) without an IdP, `Unauthorized`
   * for a token that does not check out. */
  async exchange(request: ExchangeRequest): Promise<ExchangeResult> {
    const { oidc } = this.settings;
    if (!oidc || !this.oidc || !this.sessions) {
      throw new AuthRequestError("no_idp", "this server has no IdP; sign in with the org key");
    }
    if (request.machine !== undefined && !MACHINE_ID.test(request.machine.id)) {
      throw new AuthRequestError(
        "bad_field",
        "machine.id must be 1-128 letters, digits and . _ : -",
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = await this.oidc.verify(request.id_token, request.nonce);
    } catch (err) {
      if (err instanceof IdTokenError) throw new Unauthorized(err.message);
      throw err;
    }
    if (oidc.owner_claim === "email" && payload.email_verified === false) {
      throw new Unauthorized(
        "the ID token's email is not verified, and owner ids come from the email (owner_claim)",
      );
    }
    const owner = claimOwner(payload, oidc.owner_claim);
    if (owner === undefined) {
      throw new Unauthorized(
        `the ID token has no ${oidc.owner_claim} claim to take the owner from`,
      );
    }
    const claims = idTokenClaims(payload);
    const role = this.idpRole(payload, claims);
    const scopes = [
      ...(role === "admin" ? CREDENTIAL_SCOPES.admin : CREDENTIAL_SCOPES.member_session),
    ];
    const session = await this.sessions.sign({
      owner,
      role,
      scopes,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.name ? { name: claims.name } : {}),
    });
    const result: ExchangeResult = {
      session_token: session.token,
      expires_at: session.expires_at.toISOString(),
      owner,
      role,
      scopes,
    };
    if (request.machine) {
      const machine = request.machine;
      for (const old of await this.tokens.list({ owner, kind: "device" })) {
        if (old.machine?.id === machine.id) await this.tokens.revoke(old.id);
      }
      const device = await this.tokens.issue({
        kind: "device",
        owner,
        scopes: CREDENTIAL_SCOPES.device,
        owner_basis: "verified",
        ...(request.visibility ? { visibility: request.visibility } : {}),
        expires_at: new Date(this.now().getTime() + DEVICE_TOKEN_DAYS * DAY_MS),
        machine: { id: machine.id, ...(machine.name ? { name: machine.name.slice(0, 128) } : {}) },
        ...(machine.name ? { label: machine.name.slice(0, 128) } : {}),
        created_by: { kind: "person", principal: owner, credential_id: session.id },
        claims,
      });
      result.device_token = {
        token: device.token,
        id: device.record.id,
        expires_at: device.record.expires_at as string,
      };
    }
    return result;
  }

  /** Admin when the ID token lists `admin_group` in its groups claim, or names a verified
   * email on the admins list (Google's ID tokens carry no groups) (X5.3). */
  private idpRole(payload: Record<string, unknown>, claims: Claims): "admin" | "member" {
    const { oidc, admins } = this.settings;
    const groups = oidc ? payload[oidc.groups_claim] : undefined;
    if (oidc?.admin_group && Array.isArray(groups) && groups.includes(oidc.admin_group)) {
      return "admin";
    }
    if (claims.email && admins.includes(claims.email)) return "admin";
    return "member";
  }

  /** Issue a stored token as an admin asked for it. Throws `AuthRequestError` for a request
   * that does not make sense. */
  async issue(
    request: TokenRequest,
    by: Principal,
  ): Promise<{ token: string; record: TokenRecord }> {
    const base: Pick<IssueOptions, "visibility" | "expires_at" | "label" | "created_by"> = {
      ...(request.visibility ? { visibility: request.visibility } : {}),
      ...(request.label ? { label: request.label.slice(0, 128) } : {}),
      created_by: { kind: by.kind, principal: by.owner, credential_id: by.credential_id },
    };
    const expires = request.expires_at;
    if (expires && expires.getTime() <= this.now().getTime()) {
      throw new AuthRequestError("bad_field", "expires_at must be in the future");
    }
    switch (request.kind) {
      case "org":
        if (!this.settings.orgKey) {
          throw new AuthRequestError("bad_field", "the org key is turned off (auth.org_key)");
        }
        return this.tokens.issue({
          ...base,
          kind: "org",
          owner: ORG_KEY_OWNER,
          scopes: CREDENTIAL_SCOPES.org,
          owner_basis: "claimed",
          expires_at: expires ?? null,
        });
      case "admin":
      case "device": {
        const owner = personOwner(request.owner);
        if (owner === undefined) {
          throw new AuthRequestError(
            "bad_field",
            `a ${request.kind} token needs owner: a person's owner id (X5.8)`,
          );
        }
        const scopes =
          request.kind === "admin" ? CREDENTIAL_SCOPES.admin : CREDENTIAL_SCOPES.device;
        const defaultExpiry =
          request.kind === "device"
            ? new Date(this.now().getTime() + DEVICE_TOKEN_DAYS * DAY_MS)
            : null;
        return this.tokens.issue({
          ...base,
          kind: request.kind,
          owner,
          scopes,
          owner_basis: "verified",
          expires_at: expires === undefined ? defaultExpiry : expires,
        });
      }
      case "service": {
        const scopes = request.scopes ?? [...CREDENTIAL_SCOPES.service_read];
        if (!serviceScopesValid(scopes)) {
          throw new AuthRequestError(
            "bad_field",
            "a service token reads (sessions:read, search) or writes (sessions:write), not both",
          );
        }
        if (request.service === undefined) {
          throw new AuthRequestError(
            "bad_field",
            "a service token needs service: its name or source id",
          );
        }
        let owner: string;
        try {
          owner = serviceOwner(request.service);
        } catch {
          throw new AuthRequestError(
            "bad_field",
            "service must be words of a-z and 0-9 joined by -",
          );
        }
        if (
          scopes.includes("sessions:write") &&
          this.sources &&
          !this.sources.has(request.service)
        ) {
          throw new AuthRequestError(
            "bad_field",
            `a service token that writes acts for a configured source; no source has id '${request.service}' (X5.4)`,
          );
        }
        return this.tokens.issue({
          ...base,
          kind: "service",
          owner,
          scopes,
          owner_basis: "service",
          expires_at: expires ?? null,
        });
      }
      default:
        throw new AuthRequestError("bad_field", "kind must be org, admin, device or service");
    }
  }

  async initAdmin(options: { owner: string; force?: boolean; rotateOrgKey?: boolean }): Promise<{
    admin?: { token: string; record: TokenRecord };
    org_key?: { token: string; record: TokenRecord };
    revoked: TokenRecord[];
  }> {
    const owner = personOwner(options.owner);
    if (owner === undefined) {
      throw new AdminInitError(
        "--owner must be a person's owner id: letters, digits and . _ - @ + (up to 128)",
      );
    }
    const admins = await this.tokens.list({ kind: "admin" });
    const orgKeys = await this.tokens.list({ kind: "org" });
    const makeAdmin = admins.length === 0 || options.force === true;
    if (options.rotateOrgKey && !this.settings.orgKey) {
      throw new AdminInitError("the org key is turned off (auth.org_key.enabled = false)");
    }
    const makeOrgKey =
      this.settings.orgKey && (orgKeys.length === 0 || options.rotateOrgKey === true);
    if (!makeAdmin && !makeOrgKey) {
      throw new AdminInitError(
        `already set up: ${admins.length} admin token(s)${this.settings.orgKey ? " and an org key" : ""} exist. --force makes another admin token; --rotate-org-key replaces the org key`,
      );
    }
    const by = { kind: "admin", principal: "seshi admin init" };
    const result: Awaited<ReturnType<Auth["initAdmin"]>> = { revoked: [] };
    if (makeAdmin) {
      result.admin = await this.tokens.issue({
        kind: "admin",
        owner,
        scopes: CREDENTIAL_SCOPES.admin,
        owner_basis: "verified",
        expires_at: null,
        label: "first admin (seshi admin init)",
        created_by: by,
      });
    }
    if (makeOrgKey) {
      for (const old of orgKeys) {
        const revoked = await this.tokens.revoke(old.id);
        if (revoked) result.revoked.push(revoked);
      }
      result.org_key = await this.tokens.issue({
        kind: "org",
        owner: ORG_KEY_OWNER,
        scopes: CREDENTIAL_SCOPES.org,
        owner_basis: "claimed",
        expires_at: null,
        label: "org key (seshi admin init)",
        created_by: by,
      });
    }
    return result;
  }
}
