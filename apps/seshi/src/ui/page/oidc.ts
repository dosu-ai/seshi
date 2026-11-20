/** Sign-in through the server's IdP from the browser: Authorization Code with PKCE, as the
 * same public client the CLI uses (`apps/seshi/src/account/oidc.ts`), with this page's address
 * as the redirect URI. The ID token it gets is only ever handed to `POST /v1/auth/exchange`.
 * No DOM here: the page keeps the pending sign-in in `sessionStorage`. */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface OidcConfig {
  issuer: string;
  client_id: string;
  scopes: readonly string[];
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

/** What the page must remember across the trip to the IdP. */
export interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  token_endpoint: string;
  redirect_uri: string;
  /** Where the page was (its `#…`), to go back to after. */
  back: string;
}

export class SignInError extends Error {}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** https, or http on this machine (an IdP run for testing). */
function webUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

/** The IdP's discovery document, checked: it names the issuer the server trusts, and both
 * endpoints are web addresses. The token endpoint must share the issuer's origin, the only
 * one the page's policy lets it call. */
export async function discover(issuer: string, fetchImpl: Fetch): Promise<Discovery> {
  const trimmed = issuer.replace(/\/+$/, "");
  let doc: Record<string, unknown>;
  try {
    const response = await fetchImpl(`${trimmed}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      credentials: "omit",
    });
    if (!response.ok) throw new SignInError(`its discovery document answered ${response.status}`);
    doc = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SignInError) throw err;
    throw new SignInError(
      "the browser could not read its discovery document (the IdP must allow this page's origin)",
    );
  }
  if (doc.issuer !== issuer && doc.issuer !== trimmed) {
    throw new SignInError(`its discovery document names another issuer (${String(doc.issuer)})`);
  }
  if (!webUrl(doc.authorization_endpoint) || !webUrl(doc.token_endpoint)) {
    throw new SignInError("its discovery document has no https authorization and token endpoints");
  }
  if (new URL(doc.token_endpoint).origin !== new URL(issuer).origin) {
    throw new SignInError(
      `its token endpoint (${new URL(doc.token_endpoint).origin}) is not on the issuer's origin; sign in with the CLI instead`,
    );
  }
  return {
    issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
  };
}

/** The IdP's authorize address to send the browser to, and what to keep until it comes back. */
export async function startSignIn(
  oidc: OidcConfig,
  discovery: Discovery,
  redirectUri: string,
  back: string,
): Promise<{ url: string; pending: PendingSignIn }> {
  const pending: PendingSignIn = {
    state: randomString(16),
    nonce: randomString(16),
    verifier: randomString(32),
    token_endpoint: discovery.token_endpoint,
    redirect_uri: redirectUri,
    back,
  };
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oidc.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", oidc.scopes.join(" "));
  url.searchParams.set("state", pending.state);
  url.searchParams.set("nonce", pending.nonce);
  url.searchParams.set("code_challenge", await challengeOf(pending.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), pending };
}

/** Redeem the code the IdP sent back (`?code=&state=`) for an ID token. */
export async function finishSignIn(
  query: URLSearchParams,
  pending: PendingSignIn | undefined,
  clientId: string,
  fetchImpl: Fetch,
): Promise<{ id_token: string; nonce: string }> {
  if (!pending || query.get("state") !== pending.state) {
    throw new SignInError("this answer is from another sign-in; start again");
  }
  const error = query.get("error");
  if (error) {
    const description = query.get("error_description");
    throw new SignInError(description ? `${error}: ${description}` : error);
  }
  const code = query.get("code");
  if (!code) throw new SignInError("the IdP sent no code");
  let body: Record<string, unknown> = {};
  let response: Response;
  try {
    response = await fetchImpl(pending.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      credentials: "omit",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirect_uri,
        client_id: clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    throw new SignInError(
      "the browser could not reach the IdP's token endpoint (it must allow this page's origin)",
    );
  }
  if (!response.ok) {
    const why = body.error_description ?? body.error;
    throw new SignInError(`the IdP refused the code${why ? `: ${String(why)}` : ""}`);
  }
  if (typeof body.id_token !== "string") {
    throw new SignInError("the IdP answered without an ID token (is openid among the scopes?)");
  }
  return { id_token: body.id_token, nonce: pending.nonce };
}
