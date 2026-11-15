/** The HTTP surface: one `fetch(Request) → Response` the tests call directly and `main.ts`
 * serves. One bucket, and the tokens that may use it, both from the environment: a list of
 * `name:token` pairs, a secret that signed tokens are checked against (`signed-token.ts`), or
 * both. Each token names a person, and that person's sessions live under `owners/<name>/`: a
 * token writes there and reads only there, so teammates never see each other's transcripts. A
 * client with a token posts transcripts; the server turns each into an envelope and runs it
 * through the pipeline inline (X4.4): normalized, redacted, filtered and reviewed in memory, and
 * only the trace written (X6.3), so the laptop never holds a bucket credential and the bucket
 * never holds an unredacted byte.
 *
 * Every route is a `StoreSessionDB` call (the SDK's client over the bucket, one per owner, all
 * submitting to one `Pipeline`) with the request read off the wire and the result or error
 * mapped to a status. The SDK's HTTP backend does the reverse on the other side, so the two are
 * one API with a network in it. */

import { timingSafeEqual } from "node:crypto";
import { MIN_SECRET_LENGTH, verifyToken } from "@seshi/auth";
import type { FormatRegistry } from "@seshi/formats";
import {
  type CallerKind,
  Forbidden,
  isRenderFormat,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  OffsetMismatch,
  type RawFormat,
  RENDER_FORMATS,
  SessionConflict,
  SessionRejected,
  type StorageView,
  StoreError,
  type StoreSessionResult,
  UPLOAD_SOURCE,
  type Upload,
  VERSION,
} from "@seshi/model";
import {
  type FilterSetting,
  type HealthCounters,
  type Limits,
  Pipeline,
  type Reviewer,
  StoreSessionDB,
} from "@seshi/pipeline";
import type { RedactionRules } from "@seshi/redact";
import { assertOwner, type Store } from "@seshi/store";

export type { StorageView };

/** A bearer token and the person it belongs to: the `owners/<owner>/` folder it may use. */
export interface TokenGrant {
  token: string;
  owner: string;
}

export interface AppOptions {
  /** The bucket every session goes to. */
  store: Store;
  storage: StorageView;
  /** The transcript formats the server accepts: `apps/seshi` builds the registry from its
   * integrations. */
  formats: FormatRegistry;
  /** Bearer tokens that may call the API, each bound to one owner. */
  tokens?: TokenGrant[];
  /** Signed tokens are accepted too when set: an HS256 JWT whose `sub` is the owner, minted
   * by whoever else holds this secret. One of `tokens` and `tokenSecret` is required. */
  tokenSecret?: string;
  /** Identifies this server in layout markers (`seshi/0.9.0`). */
  client?: string;
  now?: () => Date;
  /** The operator's redaction, added to the built-in rules for every session. */
  redaction?: RedactionRules;
  /** The session filter (X4.10): config's `[filter]`, or the rules per source id; today's
   * rules when omitted. */
  filter?: FilterSetting;
  /** Size caps, config's `[limits]`; today's when omitted. */
  limits?: Readonly<Limits>;
  /** Model review (F3); none when omitted. */
  reviewer?: Reviewer;
  /** Source health counters (X4.8); none when omitted. */
  health?: HealthCounters;
}

type Handler = (ctx: Context) => Promise<Response> | Response;

interface Context {
  request: Request;
  url: URL;
  params: Record<string, string>;
}

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

async function readBody(request: Request): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (!encoding || encoding === "identity") return bytes;
  if (encoding === "gzip") {
    try {
      return Bun.gunzipSync(bytes);
    } catch {
      throw new HttpError(400, "bad_encoding", "body is not valid gzip");
    }
  }
  throw new HttpError(415, "unsupported_encoding", `Content-Encoding ${encoding} not supported`);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "bad_json", "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "bad_json", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, "missing_field", `${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, "bad_field", `${key} must be a string`);
  if (required && value === "") throw new HttpError(400, "missing_field", `${key} is required`);
  return value;
}

/** `agent` is the trajectory source name (`claude-code`, not `claude`): one spelling, since the
 * archive id is derived from it. */
function sourceOf(formats: FormatRegistry, agent: string): string {
  if (!formats.has(agent)) {
    throw new HttpError(
      422,
      "unsupported_agent",
      `no normalizer for '${agent}' (one of ${formats.sources.join(", ")})`,
    );
  }
  return agent;
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "bad_query", `${name} must be ≥ 1`);
  return Math.min(n, max);
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(options: AppOptions) {
  const { store, storage, formats } = options;
  const tokens = (options.tokens ?? [])
    .filter((t) => t.token.length > 0)
    .map((t) => ({ token: t.token, owner: assertOwner(t.owner) }));
  const tokenSecret = options.tokenSecret || undefined;
  if (tokens.length === 0 && tokenSecret === undefined) {
    throw new Error("at least one token, or a token secret, is required");
  }
  if (tokenSecret !== undefined && tokenSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`the token secret must be ${MIN_SECRET_LENGTH}+ characters`);
  }
  const client = options.client ?? `seshi/${VERSION}`;
  const now = options.now ?? (() => new Date());
  const routes: Route[] = [];
  const pipeline = new Pipeline({
    store,
    formats,
    client,
    now,
    redaction: options.redaction,
    filter: options.filter,
    limits: options.limits,
    reviewer: options.reviewer,
    health: options.health,
  });

  /** The SDK over the bucket, scoped to each owner a token names and to the kind of token it
   * was (a static token from config, or a legacy signed token), which every write records as
   * its writer (X5.5): the listed owners up front, a signed token's owner the first time it
   * calls. Both kinds bind the owner, so the owner is `verified`. */
  const clients = new Map<string, StoreSessionDB>();
  function clientFor(owner: string, kind: CallerKind = "static"): StoreSessionDB {
    const id = `${kind}:${owner}`;
    let db = clients.get(id);
    if (!db) {
      db = new StoreSessionDB({
        store,
        storage,
        owner,
        formats,
        client,
        now,
        pipeline,
        writer: { kind, principal: owner, source_id: UPLOAD_SOURCE },
        owner_basis: "verified",
      });
      clients.set(id, db);
    }
    return db;
  }
  for (const { owner } of tokens) clientFor(owner);

  function route(method: string, path: string, handler: Handler): void {
    const names: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/[:*]([A-Za-z_]+)/g, (token: string, name: string) => {
        names.push(name);
        return token.startsWith("*") ? "(.+)" : "([^/]+)";
      })}/?$`,
    );
    routes.push({ method, pattern, names, handler });
  }

  /** The client for the owner the request's token is bound to; every read and write goes
   * through it and is scoped to that owner. */
  function authorize(request: Request): StoreSessionDB {
    const token = bearer(request);
    if (!token) throw new HttpError(401, "unauthorized", "a valid token is required");
    const grant = tokens.find((known) => tokensEqual(token, known.token));
    if (grant) return clientFor(grant.owner, "static");
    const owner = tokenSecret !== undefined ? verifyToken(tokenSecret, token, now()) : undefined;
    if (owner === undefined) throw new HttpError(401, "unauthorized", "a valid token is required");
    return clientFor(owner, "legacy");
  }

  // --- health -----------------------------------------------------------------

  route("GET", "/healthz", () => json({ ok: true, version: VERSION }));

  // --- identity -----------------------------------------------------------------

  route("GET", "/v1/me", async ({ request }) => {
    const db = authorize(request);
    return json(await db.me());
  });

  // --- sessions ---------------------------------------------------------

  /** `ingest` as a response: 201 for a new trace; 200 for a duplicate, an unchanged, filtered
   * or dropped session; 422 for a transcript it refuses; 409 `offset_mismatch` for a chunk that
   * does not start where the session's log ends (`expected` says where it does: 0 while the
   * session has no trace), 409 `conflict` for a whole upload that does not extend the session
   * without `replace`; 403 for a `replace` by someone other than the original writer. */
  async function stored(db: StoreSessionDB, upload: Upload): Promise<Response> {
    let result: StoreSessionResult;
    try {
      result = await db.ingest(upload);
    } catch (err) {
      if (err instanceof OffsetMismatch) {
        return json(
          { error: { code: err.code, message: err.message, expected: err.expected } },
          409,
        );
      }
      if (err instanceof SessionConflict) throw new HttpError(409, err.code, err.message);
      if (err instanceof Forbidden) throw new HttpError(403, err.code, err.message);
      if (err instanceof SessionRejected) throw new HttpError(422, err.code, err.message);
      throw err;
    }
    return json(result, result.status === "stored" ? 201 : 200);
  }

  route("POST", "/v1/sessions", async ({ request }) => {
    const db = authorize(request);
    const body = await readJson(request);
    const agent = sourceOf(formats, str(body, "agent", true) as string);
    const format = (str(body, "format") ?? "jsonl") as RawFormat;
    if (format !== "jsonl" && format !== "json") {
      throw new HttpError(400, "bad_field", "format must be jsonl or json");
    }
    const offset = body.offset ?? 0;
    if (!Number.isInteger(offset) || (offset as number) < 0) {
      throw new HttpError(400, "bad_field", "offset must be a byte offset ≥ 0");
    }
    const shipped = body.shipped as { records?: unknown; prefix_sha256?: unknown } | undefined;
    if (
      shipped !== undefined &&
      (typeof shipped !== "object" ||
        shipped === null ||
        !Number.isInteger(shipped.records) ||
        typeof shipped.prefix_sha256 !== "string")
    ) {
      throw new HttpError(400, "bad_field", "shipped needs records and prefix_sha256");
    }
    const replace = body.replace ?? false;
    if (typeof replace !== "boolean")
      throw new HttpError(400, "bad_field", "replace must be a boolean");
    const visibility = str(body, "visibility");
    if (visibility !== undefined && visibility !== "org" && visibility !== "owner") {
      throw new HttpError(400, "bad_field", "visibility must be org or owner");
    }
    const idempotencyKey =
      request.headers.get("idempotency-key") ?? str(body, "idempotency_key") ?? undefined;
    if (idempotencyKey === "") {
      throw new HttpError(400, "bad_field", "an idempotency key must not be empty");
    }
    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new HttpError(
        400,
        "bad_field",
        `an idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
    return stored(db, {
      agent,
      session_id: str(body, "session_id", true) as string,
      transcript: str(body, "transcript", true) as string,
      format,
      offset: offset as number,
      project: str(body, "project"),
      branch: str(body, "branch"),
      parent_session_id: str(body, "parent_session_id"),
      fork_of: str(body, "fork_of"),
      ...(replace ? { replace } : {}),
      ...(visibility ? { visibility } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(shipped
        ? {
            shipped: {
              records: shipped.records as number,
              prefix_sha256: shipped.prefix_sha256 as string,
            },
          }
        : {}),
    });
  });

  route("GET", "/v1/sessions", async ({ request, url }) => {
    const db = authorize(request);
    const page = await db.listSessions({
      after: url.searchParams.get("after") ?? undefined,
      limit: intParam(url, "limit", 100, 1000),
    });
    return json(page);
  });

  route("GET", "/v1/sessions/:agent/:session_id", async ({ request, params }) => {
    const db = authorize(request);
    const metadata = await db.getSession(
      decodeURIComponent(params.agent as string),
      decodeURIComponent(params.session_id as string),
    );
    if (!metadata) throw new HttpError(404, "not_found", "no such session");
    return json(metadata);
  });

  route("GET", "/v1/sessions/:agent/:session_id/trace", async ({ request, params, url }) => {
    const db = authorize(request);
    const agent = decodeURIComponent(params.agent as string);
    const sessionId = decodeURIComponent(params.session_id as string);
    // The client answers null for every reason there is no trace; the route says which.
    const metadata = await db.getSession(agent, sessionId);
    if (!metadata) throw new HttpError(404, "not_found", "no such session");
    if (metadata.status === "redacted") {
      throw new HttpError(410, "redacted", "session was redacted; no trace");
    }
    const format = url.searchParams.get("format") ?? "seshi";
    if (!isRenderFormat(format)) {
      throw new HttpError(400, "bad_query", `format must be one of ${RENDER_FORMATS.join(", ")}`);
    }
    const hash = url.searchParams.get("hash") ?? metadata.head;
    if (!hash) throw new HttpError(404, "no_trace", "session has no trace");
    const trace = await db.getTrace(agent, sessionId, hash, format);
    if (!trace) throw new HttpError(404, "not_found", "no such trace");
    return json(trace);
  });

  route("DELETE", "/v1/sessions/:agent/:session_id", async ({ request, params }) => {
    const db = authorize(request);
    const result = await db.tombstone(
      decodeURIComponent(params.agent as string),
      decodeURIComponent(params.session_id as string),
    );
    if (!result) throw new HttpError(404, "not_found", "no such session");
    return json(result);
  });

  route("GET", "/v1/changes", async ({ request, url }) => {
    const db = authorize(request);
    const page = await db.changes({
      after: url.searchParams.get("after") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: intParam(url, "limit", 100, 1000),
    });
    return json(page);
  });

  // --- dispatch -----------------------------------------------------------------

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      const params: Record<string, string> = {};
      r.names.forEach((name, i) => {
        params[name] = m[i + 1] as string;
      });
      try {
        return await r.handler({ request, url, params });
      } catch (err) {
        if (err instanceof HttpError) return error(err.status, err.code, err.message);
        if (err instanceof StoreError) {
          return error(502, "storage_error", `storage failed: ${err.message}`);
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[seshi] ${request.method} ${url.pathname}: ${message}`);
        return error(500, "internal", "internal error");
      }
    }
    return pathMatched
      ? error(405, "method_not_allowed", `${request.method} not allowed`)
      : error(404, "not_found", `no route ${url.pathname}`);
  }

  return { fetch };
}

export type App = ReturnType<typeof createApp>;
