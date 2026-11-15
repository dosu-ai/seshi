/** Signing in through the IdP (X5.7). The CLI is a public client registered in the IdP. It
 * gets an ID token by the device authorization flow (RFC 8628: a code to enter in a browser,
 * on any machine), or by the browser with PKCE and a loopback redirect (RFC 8252) where the
 * device flow is not allowed, and keeps the IdP's refresh token to renew seshi's one-hour
 * session token without signing in again. The ID token goes to the server's
 * `/v1/auth/exchange` once (X5.2); the API never sees an IdP token.
 *
 * Every network call goes through the `fetch` given, so tests run against a local stand-in
 * IdP. */

import { createHash, randomBytes } from "node:crypto";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the IdP's discovery document says, as far as sign-in needs it. */
export interface Discovery {
  issuer: string;
  token_endpoint: string;
  authorization_endpoint?: string;
  device_authorization_endpoint?: string;
  scopes_supported?: string[];
}

/** What the token endpoint answers. */
export interface IdpTokens {
  id_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Sign-in did not work: the IdP refused, the person declined, the code expired. */
export class SignInError extends Error {
  constructor(
    message: string,
    readonly code = "sign_in_failed",
  ) {
    super(message);
    this.name = "SignInError";
  }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A random value for state, nonce and the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** The PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** An ID token's claims, read without checking it (the server checks it): the nonce to send
 * back with a refreshed token, and its times. */
export function peekClaims(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function call(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SignInError(
      `cannot reach the IdP at ${new URL(url).origin}: ${reason}`,
      "idp_unreachable",
    );
  }
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(fields).toString(),
  };
}

/** The IdP's discovery document (`<issuer>/.well-known/openid-configuration`). */
export async function discover(issuer: string, fetchImpl: Fetch): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await call(fetchImpl, url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new SignInError(`the IdP's discovery document answered ${response.status}`);
  }
  const doc = await readJson(response);
  if (doc.issuer !== issuer && doc.issuer !== issuer.replace(/\/+$/, "")) {
    throw new SignInError(`the IdP's discovery document names another issuer (${doc.issuer})`);
  }
  if (typeof doc.token_endpoint !== "string") {
    throw new SignInError("the IdP's discovery document has no token_endpoint");
  }
  // The authorization endpoint is opened in the OS's URL handler: a `file:`, `smb:` or custom
  // scheme named by a malicious server or IdP would launch whatever handles it.
  for (const key of ["authorization_endpoint", "token_endpoint", "device_authorization_endpoint"]) {
    const value = doc[key];
    if (value !== undefined && !webUrl(value)) {
      throw new SignInError(
        `the IdP's discovery document names a ${key} that is not https (or http on this machine)`,
      );
    }
  }
  return doc as unknown as Discovery;
}

/** Whether `url` is one sign-in may open or call: `https:`, or `http:` on a loopback host (an
 * IdP on this machine, in development). */
export function webUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** The scopes to ask for: the server's (`openid email profile`), plus `offline_access` where
 * the IdP lists it, which is how Okta and Entra give a refresh token. */
export function signInScopes(serverScopes: readonly string[], discovery: Discovery): string[] {
  const scopes = [...serverScopes];
  if (
    discovery.scopes_supported?.includes("offline_access") &&
    !scopes.includes("offline_access")
  ) {
    scopes.push("offline_access");
  }
  return scopes;
}

/** A token endpoint answer as tokens, or the IdP's error. */
function tokensOf(body: Record<string, unknown>): IdpTokens {
  if (typeof body.id_token !== "string") {
    throw new SignInError("the IdP answered without an ID token (is openid among the scopes?)");
  }
  return {
    id_token: body.id_token,
    ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
  };
}

/** What the person is asked to do in the device flow. */
export interface DeviceCode {
  user_code: string;
  verification_uri: string;
  /** The URL with the code in it, when the IdP gives one. */
  verification_uri_complete?: string;
  expires_in: number;
}

export interface DeviceFlowOptions {
  discovery: Discovery;
  clientId: string;
  scopes: readonly string[];
  fetch: Fetch;
  /** Shown to the person: the code and where to enter it. */
  prompt(code: DeviceCode): void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The device authorization flow (RFC 8628): ask for a code, show it, poll until the person
 * has signed in. */
export async function deviceFlow(options: DeviceFlowOptions): Promise<IdpTokens> {
  const { discovery, clientId, fetch: fetchImpl } = options;
  const endpoint = discovery.device_authorization_endpoint;
  if (!endpoint) throw new SignInError("the IdP has no device authorization endpoint");
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const started = await call(
    fetchImpl,
    endpoint,
    form({ client_id: clientId, scope: options.scopes.join(" ") }),
  );
  const grant = await readJson(started);
  if (!started.ok || typeof grant.device_code !== "string" || typeof grant.user_code !== "string") {
    const why = typeof grant.error_description === "string" ? grant.error_description : grant.error;
    throw new SignInError(`the IdP refused the device sign-in${why ? `: ${why}` : ""}`);
  }
  // Google spells it verification_url.
  const verification = (grant.verification_uri ?? grant.verification_url) as string | undefined;
  if (typeof verification !== "string") {
    throw new SignInError("the IdP's device sign-in gave no URL to visit");
  }
  const expiresIn = typeof grant.expires_in === "number" ? grant.expires_in : 600;
  await options.prompt({
    user_code: grant.user_code,
    verification_uri: verification,
    ...(typeof grant.verification_uri_complete === "string"
      ? { verification_uri_complete: grant.verification_uri_complete }
      : {}),
    expires_in: expiresIn,
  });
  let intervalMs = (typeof grant.interval === "number" ? grant.interval : 5) * 1000;
  const deadline = now() + expiresIn * 1000;
  for (;;) {
    if (now() >= deadline)
      throw new SignInError("the sign-in code expired; run seshi login again", "expired");
    await sleep(intervalMs);
    const polled = await call(
      fetchImpl,
      discovery.token_endpoint,
      form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: grant.device_code,
        client_id: clientId,
      }),
    );
    const body = await readJson(polled);
    if (polled.ok) return tokensOf(body);
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new SignInError("sign-in was declined in the browser", "denied");
      case "expired_token":
        throw new SignInError("the sign-in code expired; run seshi login again", "expired");
      default: {
        const why =
          typeof body.error_description === "string" ? body.error_description : body.error;
        throw new SignInError(
          `the IdP refused the sign-in${why ? `: ${why}` : ` (${polled.status})`}`,
        );
      }
    }
  }
}

export interface BrowserFlowOptions {
  discovery: Discovery;
  clientId: string;
  scopes: readonly string[];
  fetch: Fetch;
  /** Open the sign-in page; false when no browser could be started. */
  open(url: string): Promise<boolean>;
  /** Shown to the person: the URL, in case no browser opened. */
  prompt(url: string): void | Promise<void>;
  /** How long to wait for the browser to come back. Default 5 minutes. */
  timeoutMs?: number;
}

/** What the browser flow gives: the tokens and the nonce the ID token must carry. */
export interface BrowserSignIn extends IdpTokens {
  nonce: string;
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>seshi</title>
<body style="font-family:system-ui,sans-serif;background:#F6F4EE;color:#173A41;padding:3rem">
<p><strong>Signed in.</strong> You can close this tab and go back to the terminal.</p></body>`;

function failPage(message: string): string {
  const safe = message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>seshi</title>
<body style="font-family:system-ui,sans-serif;padding:3rem"><p>Sign-in failed: ${safe}</p>
<p>Go back to the terminal.</p></body>`;
}

/** The browser flow with PKCE (RFC 7636) and a loopback redirect (RFC 8252): a one-shot server
 * on 127.0.0.1 takes the IdP's redirect, the code is exchanged with the verifier. */
export async function browserFlow(options: BrowserFlowOptions): Promise<BrowserSignIn> {
  const { discovery, clientId, fetch: fetchImpl } = options;
  const authorize = discovery.authorization_endpoint;
  if (!authorize) throw new SignInError("the IdP has no authorization endpoint");
  const verifier = randomToken();
  const state = randomToken(16);
  const nonce = randomToken(16);
  let settle: (result: { code: string } | { error: string }) => void = () => {};
  const arrived = new Promise<{ code: string } | { error: string }>((resolve) => {
    settle = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      const html = { headers: { "content-type": "text/html; charset=utf-8" } };
      if (url.searchParams.get("state") !== state) {
        // Not our sign-in (a stale tab, or someone else's request): keep waiting.
        return new Response(failPage("this page is from another sign-in"), {
          ...html,
          status: 400,
        });
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description");
        settle({ error: description ? `${error}: ${description}` : error });
        return new Response(failPage(error), { ...html, status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) {
        settle({ error: "the IdP sent no code" });
        return new Response(failPage("no code"), { ...html, status: 400 });
      }
      settle({ code });
      return new Response(DONE_PAGE, html);
    },
  });
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    const url = new URL(authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", options.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    await options.prompt(url.toString());
    await options.open(url.toString());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: "no answer from the browser in time" }),
        options.timeoutMs ?? 5 * 60_000,
      );
    });
    const result = await Promise.race([arrived, timedOut]);
    clearTimeout(timer);
    if ("error" in result) throw new SignInError(`sign-in failed: ${result.error}`);
    const response = await call(
      fetchImpl,
      discovery.token_endpoint,
      form({
        grant_type: "authorization_code",
        code: result.code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    );
    const body = await readJson(response);
    if (!response.ok) {
      const why = typeof body.error_description === "string" ? body.error_description : body.error;
      throw new SignInError(`the IdP refused the code${why ? `: ${why}` : ""}`);
    }
    return { ...tokensOf(body), nonce };
  } finally {
    server.stop(true);
  }
}

/** A fresh ID token from the refresh token. Throws `SignInError` `refresh_refused` when the
 * IdP no longer honours it (the person was removed, or it expired): sign in again. */
export async function refreshIdToken(options: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  fetch: Fetch;
}): Promise<IdpTokens> {
  const response = await call(
    options.fetch,
    options.tokenEndpoint,
    form({
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
    }),
  );
  const body = await readJson(response);
  if (!response.ok) {
    const why = typeof body.error_description === "string" ? body.error_description : body.error;
    throw new SignInError(
      `the IdP refused the refresh token${why ? ` (${why})` : ""}`,
      "refresh_refused",
    );
  }
  return tokensOf(body);
}
