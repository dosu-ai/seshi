import { exchangeIdToken, ServerError } from "@seshi/client";
import type { LoginProfile, Logins } from "./logins";
import { peekClaims, refreshIdToken, SignInError } from "./oidc";
import { type ConfiguredUser, resolveUser } from "./user";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a credential is for: reading (and changing) sessions, reading another owner's by
 * name (`--owner`), deleting one, uploading, or sharing and unsharing one's own sessions (the
 * device token, which may, else the sign-in). A read is the sign-in's, which reads the org's
 * shared sessions too; when the sign-in has run out and cannot be renewed, the device token,
 * which reads its owner's own (X5.10), with `fallback` saying so. Reading another owner's
 * never falls back: the device token would find none of theirs. */
export type Purpose = "read" | "read_others" | "delete" | "upload" | "share";

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
  /** Set when a read goes on with the device token because the sign-in could not be renewed:
   * why, for the command to warn that it sees only the owner's own sessions. */
  fallback?: string;
}

export interface CredentialOptions {
  logins: Logins;
  env: Record<string, string | undefined>;
  configuredUser?: ConfiguredUser;
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
      // Forget the dead refresh token, so later commands do not ask the IdP again.
      await options.logins.update(server, {}, { refresh: null });
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
      if (profile.token_expires_at !== undefined && msUntil(profile.token_expires_at, now) <= 0) {
        throw new NotSignedIn(
          profile.server,
          `the token for ${profile.server}${profile.owner ? ` (${profile.owner})` : ""} expired ${profile.token_expires_at.slice(0, 10)}; an admin makes a new one (seshi tokens create device --owner ${profile.owner ?? "<owner>"} --expires 365d) to sign in with (on Cursor Cloud: put it in the SESHI_TOKEN secret)`,
        );
      }
      return { server: profile.server, token, profile };
    }
    case "oidc": {
      const device = async (): Promise<Credential | "missing" | "expired"> => {
        const token = await options.logins.secret(profile.server, "device");
        if (!token) return "missing";
        if (msUntil(profile.device?.expires_at, now) <= 0) return "expired";
        return { server: profile.server, token, profile };
      };
      if (purpose === "share") {
        // The device token the uploader sends with may share its owner's sessions (X5.10), so
        // sharing needs no renewal through the IdP while it lasts.
        const shared = await device();
        if (typeof shared !== "string") return shared;
      }
      if (purpose === "upload") {
        const uploader = await device();
        if (uploader === "missing") throw missing();
        if (uploader === "expired") {
          throw new NotSignedIn(
            profile.server,
            `the device token for ${profile.server} has expired`,
          );
        }
        return uploader;
      }
      const session = await options.logins.secret(profile.server, "session");
      if (session && sessionUsable(profile, purpose, now)) {
        return { server: profile.server, token: session, profile };
      }
      let renewed: string;
      try {
        renewed = await renewSession(options, profile, now);
      } catch (err) {
        // The device token reads its owner's own sessions (X5.10): enough for a read while the
        // sign-in cannot be renewed, whether the IdP refused or could not be reached.
        const fallback = purpose === "read" ? await device() : "missing";
        if (typeof fallback === "string") throw err;
        const why = err instanceof NotSignedIn ? "" : ` (${(err as Error).message})`;
        return {
          ...fallback,
          fallback: `the sign-in for ${profile.server} has run out and could not be renewed${why}; reading with this machine's device token, which sees only your own sessions: run seshi login --server ${profile.server} to see the org's`,
        };
      }
      return {
        server: profile.server,
        token: renewed,
        profile: options.logins.get(profile.server) ?? profile,
      };
    }
  }
}
