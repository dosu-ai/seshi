import { type ServerConfig, signingKeyId } from "@seshi/config";
import { isOwner } from "@seshi/store";
import { isServiceOwner, OwnerAliases } from "./owner";
import { MIN_SESSION_KEY_LENGTH } from "./session-token";

export const MIN_STATIC_TOKEN_LENGTH = 16;

export const PLACEHOLDER_TOKEN_PREFIX = "replace-with";

export interface OidcSettings {
  issuer: string;
  client_id: string;
  audience: string;
  owner_claim: string;
  admin_group?: string;
  groups_claim: string;
}

export interface AuthSettings {
  staticTokens: { token: string; owner: string }[];
  orgKey: boolean;
  oidc?: OidcSettings;
  admins: string[];
  aliases: Record<string, string>;
  sessionKeys: Record<string, string>;
  signingKeyId?: string;
}

export class AuthSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthSettingsError";
  }
}

function fail(message: string): never {
  throw new AuthSettingsError(message);
}

/** The settings from a loaded config whose secrets are resolved; `AuthSettingsError` for the
 * first one that cannot work. */
export function authSettings(config: ServerConfig): AuthSettings {
  const { auth } = config;
  const staticTokens = Object.entries(auth.tokens).map(([owner, secret]) => {
    if (!isOwner(owner) || isServiceOwner(owner)) {
      fail(
        `auth.tokens: '${owner}' is not a valid owner id: letters, digits and . _ - @ + (up to 128)`,
      );
    }
    const token = secret.reveal().trim();
    if (token.length < MIN_STATIC_TOKEN_LENGTH) {
      fail(
        `auth.tokens.${owner} must be ${MIN_STATIC_TOKEN_LENGTH}+ characters (try: openssl rand -hex 24)`,
      );
    }
    if (token.toLowerCase().startsWith(PLACEHOLDER_TOKEN_PREFIX)) {
      fail(
        `auth.tokens.${owner} is still the placeholder from .env.example: set a real token (try: openssl rand -hex 24)`,
      );
    }
    return { token, owner };
  });
  if (new Set(staticTokens.map((t) => t.token)).size !== staticTokens.length) {
    fail("auth.tokens: the same token is given to two owners");
  }
  try {
    new OwnerAliases(auth.owner_aliases);
  } catch (err) {
    fail((err as Error).message);
  }
  const sessionKeys = Object.fromEntries(
    Object.entries(auth.session_keys).map(([kid, secret]) => {
      const value = secret.reveal().trim();
      if (value.length < MIN_SESSION_KEY_LENGTH) {
        fail(
          `auth.session_keys.${kid} must be ${MIN_SESSION_KEY_LENGTH}+ characters (try: openssl rand -hex 32)`,
        );
      }
      return [kid, value];
    }),
  );
  const oidc = auth.oidc
    ? {
        issuer: auth.oidc.issuer,
        client_id: auth.oidc.client_id,
        audience: auth.oidc.audience ?? auth.oidc.client_id,
        owner_claim: auth.oidc.owner_claim,
        ...(auth.oidc.admin_group ? { admin_group: auth.oidc.admin_group } : {}),
        groups_claim: auth.oidc.groups_claim,
      }
    : undefined;
  const kid = signingKeyId(config);
  return {
    staticTokens,
    orgKey: auth.org_key.enabled,
    ...(oidc ? { oidc } : {}),
    admins: auth.admins.map((a) => a.trim().toLowerCase()),
    aliases: { ...auth.owner_aliases },
    sessionKeys,
    ...(kid ? { signingKeyId: kid } : {}),
  };
}
