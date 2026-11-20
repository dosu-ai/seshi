/** Calls to the API with the signed-in person's credential, and where that credential lives:
 * `sessionStorage`, so it lasts as long as the tab and is never shared with another. No
 * cookies: the API reads only the `Authorization` header, so a page on another site cannot
 * make the browser call it as this person. */

import { type RouteName, resolve } from "./routes";

export interface Credential {
  token: string;
  /** `X-Seshi-User`: the username the org key acts for. */
  user?: string;
  /** How it was got, for the sign-out line: `sign-in`, `org key`, `token`. */
  via: string;
  expires_at?: string;
}

const KEY = "seshi-ui.credential";
export const PENDING_KEY = "seshi-ui.pending-sign-in";

let current: Credential | undefined;

export function loadCredential(): Credential | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Credential;
    if (typeof parsed.token !== "string") return undefined;
    current = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveCredential(credential: Credential): void {
  current = credential;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(credential));
  } catch {}
}

export function clearCredential(): void {
  current = undefined;
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the API refuses the credential (expired, revoked): the page asks to sign in. */
export const SIGNED_OUT = "seshi-ui:signed-out";

export interface CallOptions {
  params?: Record<string, string>;
  query?: URLSearchParams;
  body?: unknown;
  /** Use this credential instead of the saved one (checking one before saving it). */
  credential?: Credential | null;
}

async function send(name: RouteName, options: CallOptions): Promise<Response> {
  const { method, path } = resolve(name, options.params);
  const credential = options.credential === undefined ? current : options.credential;
  const headers: Record<string, string> = { accept: "application/json" };
  if (credential) {
    headers.authorization = `Bearer ${credential.token}`;
    if (credential.user) headers["x-seshi-user"] = credential.user;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const query = options.query?.toString();
  const response = await fetch(query ? `${path}?${query}` : path, {
    method,
    headers,
    cache: "no-store",
    credentials: "omit",
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.ok) return response;
  let code = "error";
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {}
  if (response.status === 401 && options.credential === undefined && current) {
    window.dispatchEvent(new CustomEvent(SIGNED_OUT));
  }
  throw new ApiError(response.status, code, message);
}

export async function call<T>(name: RouteName, options: CallOptions = {}): Promise<T> {
  return (await (await send(name, options)).json()) as T;
}

/** A route's answer as a file the browser saves (the export route needs the credential, so a
 * plain link cannot fetch it). */
export async function download(
  name: RouteName,
  options: CallOptions,
  filename: string,
): Promise<void> {
  const response = await send(name, options);
  const disposition = response.headers.get("content-disposition") ?? "";
  const named = /filename="([^"]+)"/.exec(disposition)?.[1] ?? filename;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = named;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
