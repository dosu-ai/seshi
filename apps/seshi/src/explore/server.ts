import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExploreApi } from "./api";
import type { Assets } from "./assets";
import type { RowFilter } from "./types";

export const TOKEN_HEADER = "x-seshi-token";

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function sameToken(given: string | null | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(given), digest(token));
}

export function withToken(html: string, token: string): string {
  return html.replace(
    /\b(src|href)="(\/(?!\/)[^"?#]*)"/g,
    (_, attr: string, path: string) => `${attr}="${path}?token=${encodeURIComponent(token)}"`,
  );
}

function respond(body: BodyInit | null, status: number, type?: string, extra = {}): Response {
  return new Response(body, {
    status,
    headers: { ...HEADERS, ...(type ? { "content-type": type } : {}), ...extra },
  });
}

const text = (status: number, message: string, extra = {}) =>
  respond(`${message}\n`, status, "text/plain; charset=utf-8", extra);

const json = (status: number, value: unknown) =>
  respond(JSON.stringify(value), status, "application/json; charset=utf-8");

export type ExploreHandler = Pick<ExploreApi, "list" | "detail" | "records">;

export interface ExploreServerOptions {
  api: ExploreHandler;
  assets: Assets;
  port?: number;
  token?: string;
}

export interface ExploreServer {
  port: number;
  token: string;
  url: string;
  stop(): Promise<void>;
}

const FILTERS: ReadonlySet<string> = new Set(["all", "mismatch", "redacted", "local", "stored"]);

function int(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

export function exploreHandler(
  options: { api: ExploreHandler; assets: Assets; token: string },
  port: () => number,
): (request: Request) => Promise<Response> {
  const { api, assets, token } = options;
  return async (request) => {
    const p = port();
    const allowed = [`127.0.0.1:${p}`, `localhost:${p}`];
    const host = request.headers.get("host");
    if (!host || !allowed.includes(host.toLowerCase())) {
      return text(403, "seshi explore: this server answers only http://127.0.0.1 on its port");
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowed.some((h) => origin.toLowerCase() === `http://${h}`)) {
      return text(403, "seshi explore: cross-origin requests are refused");
    }
    if (request.method !== "GET") {
      return text(405, "seshi explore is read-only: GET only", { allow: "GET" });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      if (!sameToken(request.headers.get(TOKEN_HEADER), token)) {
        return json(401, { error: "unauthorized", message: "the token is missing or wrong" });
      }
      try {
        return await route(api, path, url.searchParams);
      } catch (err) {
        return json(500, {
          error: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!sameToken(url.searchParams.get("token"), token)) {
      return text(
        401,
        "seshi explore: open the address `seshi explore` printed; it carries the token",
      );
    }
    if (path === "/" || path === "/index.html") {
      return respond(withToken(assets.index, token), 200, "text/html; charset=utf-8");
    }
    const file = assets.files.get(path);
    if (file) return respond(file.body, 200, file.type);
    return text(404, "not found");
  };
}

async function route(api: ExploreHandler, path: string, query: URLSearchParams) {
  const parts = path.slice("/api/".length).split("/");
  if (parts[0] !== "sessions") return json(404, { error: "not_found" });
  if (parts.length === 1) return json(200, api.list({ refresh: query.get("refresh") === "1" }));
  let agent: string;
  let id: string;
  try {
    agent = decodeURIComponent(parts[1] ?? "");
    id = decodeURIComponent(parts[2] ?? "");
  } catch {
    return json(400, { error: "bad_request", message: "a malformed session path" });
  }
  if (!agent || !id) return json(404, { error: "not_found" });
  const fresh = query.get("fresh") === "1";
  if (parts.length === 3) {
    const detail = await api.detail(agent, id, { fresh });
    return detail ? json(200, detail) : json(404, notSeen(agent, id));
  }
  if (parts.length === 4 && parts[3] === "records") {
    const filter = query.get("filter") ?? "all";
    if (!FILTERS.has(filter)) return json(400, { error: "bad_request", message: "unknown filter" });
    const offset = int(query.get("offset"));
    const limit = int(query.get("limit"));
    const view = await api.records(agent, id, {
      filter: filter as RowFilter,
      fresh,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return view ? json(200, view) : json(404, notSeen(agent, id));
  }
  return json(404, { error: "not_found" });
}

const notSeen = (agent: string, id: string) => ({
  error: "not_found",
  message: `this machine has not seen ${agent} session ${id}`,
});

export function startExploreServer(options: ExploreServerOptions): ExploreServer {
  const token = options.token ?? newToken();
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    development: false,
    fetch: exploreHandler({ api: options.api, assets: options.assets, token }, () => port),
    error: () => text(500, "seshi explore: internal error"),
  });
  port = server.port as number;
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
    async stop() {
      await server.stop(true);
    },
  };
}
