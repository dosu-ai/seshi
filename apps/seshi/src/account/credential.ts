import { exchangeIdToken, ServerError } from "@seshi/client";
import type { LoginProfile, Logins } from "./logins";
import { peekClaims, refreshIdToken, SignInError } from "./oidc";
import { resolveUser } from "./user";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a credential is for: reading (and changing) sessions, deleting one, or uploading. */
export type Purpose = "read" | "delete" | "upload";

/** There is no usable credential for the server: never signed in, or it ran out. */
export class NotSignedIn extends Error {
  constructor(
    readonly server: string | undefined,
    reason?: string,
  ) {
    super(
      server === undefined
        ? "not signed in: run seshi login --server <url>"
        : `${reason ?? `not signed in to ${server}`}: run seshi login${server ? ` --server ${server}` : ""}`,
    );
    this.name = "NotSignedIn";
  }
}

export interface Credential {
  server: string;
  token: string;
  /** With the org key: the username to send as `X-Seshi-User`. */
  user?: string;
  profile: LoginProfile;
}

export interface CredentialOptions {
  logins: Logins;
  env: Record<string, string | undefined>;
  configuredUser?: string;
  fetch?: Fetch;
  now?: () => Date;
  gitEmail?: () => Promise<string | undefined>;
}

const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_DELETE_FRESH_SECONDS = 600;

function msUntil(iso: string | undefined, now: Date): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  return Date.parse(iso) - now.getTime();
}

export function sessionUsable(profile: LoginProfile, purpose: Purpose, now: Date): boolean {
  const session = profile.session;
  if (!session || msUntil(session.expires_at, now) <= EXPIRY_MARGIN_MS) return false;
  if (purpose !== "delete") return true;
  const freshMs = (profile.delete_fresh_seconds ?? DEFAULT_DELETE_FRESH_SECONDS) * 1000;
  return now.getTime() - Date.parse(session.issued_at) < freshMs - EXPIRY_MARGIN_MS;
}

async function renewSession(
  options: CredentialOptions,
  profile: LoginProfile,
  now: Date,
): Promise<string> {
  const { server } = profile;
  const refresh = await options.logins.secret(server, "refresh");
  if (!profile.oidc || !refresh) {
    throw new NotSignedIn(server, `the session for ${server} has expired`);
  }
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let idToken: string;
  let rotated: string | undefined;
  try {
    const tokens = await refreshIdToken({
      tokenEndpoint: profile.oidc.token_endpoint,
      clientId: profile.oidc.client_id,
      refreshToken: refresh,
      fetch: fetchImpl,
    });
    idToken = tokens.id_token;
    rotated = tokens.refresh_token;
  } catch (err) {
    if (err instanceof SignInError && err.code === "refresh_refused") {
      throw new NotSignedIn(server, `the IdP no longer renews the session for ${server}`);
    }
    throw err;
  }
  // A refreshed ID token carries the original nonce, if any; the server checks it either way.
  const nonce = peekClaims(idToken).nonce;
  let exchanged: Awaited<ReturnType<typeof exchangeIdToken>>;
  try {
    exchanged = await exchangeIdToken(
      { server, fetch: fetchImpl },
      { id_token: idToken, ...(typeof nonce === "string" ? { nonce } : {}) },
    );
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      throw new NotSignedIn(server, `${server} refused the renewed sign-in`);
    }
    throw err;
  }
  await options.logins.update(
    server,
    {
      owner: exchanged.owner,
      role: exchanged.role,
      scopes: exchanged.scopes,
      session: { issued_at: now.toISOString(), expires_at: exchanged.expires_at },
    },
    { session: exchanged.session_token, ...(rotated ? { refresh: rotated } : {}) },
  );
  return exchanged.session_token;
}

/** The credential for `server` and `purpose`. Throws `NotSignedIn` when there is none. */
export async function credentialFor(
  options: CredentialOptions,
  server: string,
  purpose: Purpose,
): Promise<Credential> {
  const profile = options.logins.get(server);
  if (!profile) throw new NotSignedIn(server);
  const now = (options.now ?? (() => new Date()))();
  const missing = () =>
    new NotSignedIn(profile.server, `the stored credential for ${profile.server} is gone`);
  switch (profile.mode) {
    case "org_key": {
      const key = await options.logins.secret(profile.server, "org_key");
      if (!key) throw missing();
      const { user } = await resolveUser({
        env: options.env,
        ...(options.configuredUser ? { configured: options.configuredUser } : {}),
        ...(options.gitEmail ? { gitEmail: options.gitEmail } : {}),
      });
      return { server: profile.server, token: key, user, profile };
    }
    case "token": {
      const token = await options.logins.secret(profile.server, "token");
      if (!token) throw missing();
      return { server: profile.server, token, profile };
    }
    case "oidc": {
      if (purpose === "upload") {
        const device = await options.logins.secret(profile.server, "device");
        if (!device) throw missing();
        if (msUntil(profile.device?.expires_at, now) <= 0) {
          throw new NotSignedIn(
            profile.server,
            `the device token for ${profile.server} has expired`,
          );
        }
        return { server: profile.server, token: device, profile };
      }
      const session = await options.logins.secret(profile.server, "session");
      if (session && sessionUsable(profile, purpose, now)) {
        return { server: profile.server, token: session, profile };
      }
      const renewed = await renewSession(options, profile, now);
      return {
        server: profile.server,
        token: renewed,
        profile: options.logins.get(profile.server) ?? profile,
      };
    }
  }
}
