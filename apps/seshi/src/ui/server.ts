/** The team UI's files, served by `seshi serve` at `/ui/` beside the API (`server.ui`).
 *
 * The page is static: no data, no secrets, no session state on the server. It signs the person
 * in and reads `/v1` with their own bearer credential, like any other client, so the API's
 * checks (scopes, who may read which session) are the only ones that apply. That is also why
 * these files need no auth: they are the same for everyone. */

import type { Assets } from "../web/assets";
import { contentSecurityPolicy, securityHeaders } from "../web/headers";

export const UI_PATH = "/ui/";

type Fetch = (request: Request) => Response | Promise<Response>;

export interface UiOptions {
  assets: Assets;
  /** The IdP the API signs people in through, if any: the page calls its token endpoint, so
   * the policy lets it connect there. Read on each request, so it follows a config reload. */
  issuer?: () => string | undefined;
}

/** The page as served under `/ui/`: the HTML links its files from `/`, so those links move
 * under the prefix. */
export function underPrefix(html: string): string {
  return html.replace(
    /\b(src|href)="\/(?!\/)([^"]*)"/g,
    (_, attr: string, path: string) => `${attr}="${UI_PATH}${path}"`,
  );
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function uiCsp(issuer: string | undefined): string {
  const idp = originOf(issuer);
  return contentSecurityPolicy({ connect: idp ? [idp] : [], trustedTypes: true });
}

/** A handler for the UI's paths that answers `undefined` for every other path. */
export function uiHandler(options: UiOptions): (request: Request) => Response | undefined {
  const index = underPrefix(options.assets.index);
  const { files } = options.assets;
  return (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path !== "/" && path !== "/ui" && !path.startsWith(UI_PATH)) return undefined;
    const headers = securityHeaders(uiCsp(options.issuer?.()));
    const respond = (body: BodyInit | null, status: number, extra: Record<string, string>) =>
      new Response(body, { status, headers: { ...headers, ...extra } });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond("the team UI is read-only: GET only\n", 405, {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
    }
    // One address for the page, the one registered with the IdP as its redirect URI.
    if (path === "/" || path === "/ui" || path === `${UI_PATH}index.html`) {
      return respond(null, 302, { location: `${UI_PATH}${url.search}` });
    }
    if (path === UI_PATH) {
      return respond(index, 200, { "content-type": "text/html; charset=utf-8" });
    }
    const file = files.get(path.slice(UI_PATH.length - 1));
    if (file) return respond(file.body, 200, { "content-type": file.type });
    return respond("not found\n", 404, { "content-type": "text/plain; charset=utf-8" });
  };
}

/** The API's handler with the UI's paths in front of it. */
export function withUi(api: Fetch, ui: (request: Request) => Response | undefined): Fetch {
  return (request) => ui(request) ?? api(request);
}
