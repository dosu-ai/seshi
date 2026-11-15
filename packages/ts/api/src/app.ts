/** The HTTP surface: one `fetch(Request) → Response` over an Instance (`@seshi/instance`), which
 * the tests call directly and `seshi serve` serves. The instance holds the bucket, auth, the
 * pipeline and the job status; the routes only translate HTTP. Every call but `/healthz`, `/v1/auth/config` and the IdP exchange
 * carries a credential (X5): the org key with the caller's username, a session, device, admin
 * or service token, or a static token from config. `@seshi/auth` turns it into a principal with
 * a role and scopes, and the routes check the scope a call needs and, for a session, its owner
 * and visibility (X5.3, X5.10): a member reads their own sessions and the org's, an admin or a
 * service reads all.
 *
 * Uploads become envelopes and go through the pipeline inline (X4.4): normalized, redacted,
 * filtered and reviewed in memory, and only the trace written (X6.3), so the laptop never holds
 * a bucket credential and the bucket never holds an unredacted byte. A principal always writes
 * its own sessions; the pipeline's authorize stage (`ownershipAuthorizer`) holds every write to
 * that.
 *
 * Reads take `?owner=` to read another owner's sessions; without it a caller reads its own, and
 * `[auth.owner_aliases]` folds an old owner id into its new one (X5.8). */

import { gunzipSync } from "node:zlib";
import {
  AuthRequestError,
  canRead,
  type Principal,
  pickClaims,
  requireDelete,
  requireScope,
  requireVisibilityChange,
  type Scope,
  serviceSourceId,
  type TokenRequest,
  tokenInfo,
  USER_HEADER,
} from "@seshi/auth";
import { renderTrace } from "@seshi/formats";
import type { Instance } from "@seshi/instance";
import {
  type ChangesPage,
  Forbidden,
  type Identity,
  IngestRejected,
  isRenderFormat,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  OffsetMismatch,
  type RawFormat,
  RENDER_FORMATS,
  type RenderFormat,
  SessionConflict,
  type SessionMetadata,
  SessionRejected,
  type StorageView,
  StoreError,
  type StoreSessionResult,
  Unauthorized,
  UPLOAD_SOURCE,
  type Upload,
  VERSION,
  type Visibility,
  type Writer,
} from "@seshi/model";
import {
  getSession,
  getTrace,
  listSessions,
  type StoreSessionDB,
  setVisibility,
  tombstone,
} from "@seshi/pipeline";
import { rulesDocument } from "@seshi/redact";
import { SearchQueryError, SearchUnavailable, viewerFor } from "@seshi/search";
import {
  archiveId,
  isOwner,
  keys,
  listOwners,
  listRecords,
  listReviews,
  type ReviewRecord,
  readChanges,
  readMetadata,
  sourcesWithRecords,
  type TokenKind,
} from "@seshi/store";
import { otlpTraces } from "./otlp/receiver";
import { searchRequestOf } from "./search";

export type { StorageView };

/** How long a client is told to wait while the search index is being built. */
const SEARCH_RETRY_AFTER_S = 5;

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

/** The largest request body an upload of `maxUploadBytes` of transcript needs, decoded: the
 * transcript as a JSON string (escaping grows it) plus the other fields. `seshi serve` caps the
 * request at it too. */
export function maxBodyBytes(maxUploadBytes: number): number {
  return maxUploadBytes * 2 + 1024 * 1024;
}

function tooLarge(max: number): HttpError {
  return new HttpError(413, "too_large", `request body exceeds ${max} bytes`);
}

/** The body, gunzipped when sent gzipped, refused past `max` bytes either way: a small gzipped
 * body can inflate to far more than any upload. */
async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > max) throw tooLarge(max);
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (!encoding || encoding === "identity") return bytes;
  if (encoding === "gzip") {
    try {
      return new Uint8Array(gunzipSync(bytes, { maxOutputLength: max }));
    } catch (err) {
      if ((err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge(max);
      throw new HttpError(400, "bad_encoding", "body is not valid gzip");
    }
  }
  throw new HttpError(415, "unsupported_encoding", `Content-Encoding ${encoding} not supported`);
}

async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, max);
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
function sourceOf(formats: Instance["formats"], agent: string): string {
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

function bool(body: Record<string, unknown>, key: string): boolean {
  const value = body[key] ?? false;
  if (typeof value !== "boolean") throw new HttpError(400, "bad_field", `${key} must be a boolean`);
  return value;
}

function visibilityField(value: unknown, where = "visibility"): Visibility | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "org" && value !== "owner") {
    throw new HttpError(400, "bad_field", `${where} must be org or owner`);
  }
  return value;
}

/** The writer a principal's writes record (X5.5): through the upload route, filed under
 * `upload`, or for a service token under its own source, so the source's visibility, filter and
 * health apply to what it writes (X5.4, X5.10). */
function writerFor(principal: Principal): Writer {
  return {
    kind: principal.kind,
    principal: principal.owner,
    credential_id: principal.credential_id,
    source_id: (principal.kind === "service" && serviceSourceId(principal.owner)) || UPLOAD_SOURCE,
  };
}

/** Who the caller is, as `GET /v1/me` answers it. */
function identityOf(principal: Principal, storage: StorageView): Identity {
  return {
    owner: principal.owner,
    storage,
    kind: principal.kind,
    role: principal.role,
    scopes: [...principal.scopes].sort(),
    owner_basis: principal.owner_basis,
    credential_id: principal.credential_id,
    ...(principal.visibility ? { visibility: principal.visibility } : {}),
    ...(principal.expires_at ? { expires_at: principal.expires_at.toISOString() } : {}),
  };
}

const TOKEN_KINDS: readonly TokenKind[] = ["org", "admin", "device", "service"];

/** The routes over `instance`. An instance without the api role (`--roles worker`) answers
 * `/healthz` only, so a container's health check still works (X7.1). */
export function createApp(instance: Instance) {
  const { store, storage, formats, auth, pipeline, now } = instance;
  const aliases = auth.aliases;
  const routes: Route[] = [];
  const bodyLimit = maxBodyBytes(instance.limits.max_upload_bytes);

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

  /** The principal the request's credential stands for; `Unauthorized` (401) otherwise. */
  function authenticate(request: Request): Promise<Principal> {
    return auth.authenticate(bearer(request), request.headers.get(USER_HEADER) ?? undefined);
  }

  /** The principal, when its credential carries `scope`; 403 otherwise. */
  async function caller(request: Request, scope: Scope): Promise<Principal> {
    const principal = await authenticate(request);
    requireScope(principal, scope);
    return principal;
  }

  /** The session API over the instance's pipeline, writing as the principal: its own sessions,
   * its writer, its owner basis, claims and default visibility (X5.5, X5.10). */
  function writerClient(principal: Principal): StoreSessionDB {
    return instance.sessions({
      owner: principal.owner,
      writer: writerFor(principal),
      owner_basis: principal.owner_basis,
      claims: principal.claims,
      ...(principal.visibility ? { visibility: principal.visibility } : {}),
    });
  }

  /** The owner a read is about: `?owner=`, else the caller's own. */
  function ownerOf(url: URL, principal: Principal): string {
    const owner = url.searchParams.get("owner") ?? principal.owner;
    if (!isOwner(owner)) throw new HttpError(400, "bad_query", "owner is not an owner id");
    return owner;
  }

  /** A session the principal may read, from the folders the owner's sessions are stored under
   * (aliases applied), with the folder it was found in. A session it may not read is "not
   * found", so its existence is not given away. */
  async function readable(
    principal: Principal,
    owner: string,
    agent: string,
    sessionId: string,
  ): Promise<{ folder: string; metadata: SessionMetadata }> {
    for (const folder of aliases.storedAs(owner)) {
      const metadata = await getSession(store, folder, agent, sessionId);
      if (metadata === null) continue;
      if (!canRead(principal, metadata, aliases)) break;
      return { folder, metadata };
    }
    throw new HttpError(404, "not_found", "no such session");
  }

  function sessionParams(params: Record<string, string>): { agent: string; sessionId: string } {
    return {
      agent: decodeURIComponent(params.agent as string),
      sessionId: decodeURIComponent(params.session_id as string),
    };
  }

  // --- health -----------------------------------------------------------------

  route("GET", "/healthz", () => json({ ok: true, version: VERSION }));

  if (!instance.api) return { fetch: dispatch(routes), auth, pipeline };

  // --- auth (X5.2, X5.7) ------------------------------------------------------------

  route("GET", "/v1/auth/config", () => json({ version: VERSION, ...auth.modes() }));

  route("POST", "/v1/auth/exchange", async ({ request }) => {
    const body = await readJson(request, 64 * 1024);
    const idToken = str(body, "id_token", true) as string;
    const nonce = str(body, "nonce");
    const rawMachine = body.machine;
    let machine: { id: string; name?: string } | undefined;
    if (rawMachine !== undefined && rawMachine !== null) {
      if (typeof rawMachine !== "object" || Array.isArray(rawMachine)) {
        throw new HttpError(400, "bad_field", "machine must be an object with an id");
      }
      const m = rawMachine as Record<string, unknown>;
      const id = str(m, "id", true) as string;
      const name = str(m, "name");
      machine = { id, ...(name ? { name } : {}) };
    }
    const visibility = visibilityField(body.visibility);
    try {
      const result = await auth.exchange({
        id_token: idToken,
        ...(nonce !== undefined ? { nonce } : {}),
        ...(machine ? { machine } : {}),
        ...(visibility ? { visibility } : {}),
      });
      return json(result);
    } catch (err) {
      if (err instanceof AuthRequestError) {
        throw new HttpError(err.code === "no_idp" ? 404 : 400, err.code, err.message);
      }
      throw err;
    }
  });

  // --- identity -----------------------------------------------------------------

  route("GET", "/v1/me", async ({ request }) => {
    const principal = await authenticate(request);
    return json(identityOf(principal, storage));
  });

  route("GET", "/v1/owners", async ({ request, url }) => {
    await caller(request, "sessions:read");
    const after = url.searchParams.get("after") ?? undefined;
    if (after !== undefined && !isOwner(after)) {
      throw new HttpError(400, "bad_query", "after is not an owner id");
    }
    return json(await listOwners(store, { after, limit: intParam(url, "limit", 100, 1000) }));
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
      if (err instanceof SessionRejected) throw new HttpError(422, err.code, err.message);
      throw err;
    }
    return json(result, result.status === "stored" ? 201 : 200);
  }

  route("POST", "/v1/sessions", async ({ request }) => {
    const principal = await caller(request, "sessions:write");
    const body = await readJson(request, bodyLimit);
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
    const replace = bool(body, "replace");
    const visibility = visibilityField(body.visibility);
    if (body.claims !== undefined && (typeof body.claims !== "object" || body.claims === null)) {
      throw new HttpError(400, "bad_field", "claims must be an object");
    }
    const claims = pickClaims(body.claims);
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
    return stored(writerClient(principal), {
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
      ...(claims ? { claims } : {}),
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

  /** One owner's sessions a page at a time, across the folders aliases fold into it (up to
   * `limit` keys from each), as far as the principal may read them. The cursor is the last key
   * listed, which says which folder it is in. */
  route("GET", "/v1/sessions", async ({ request, url }) => {
    const principal = await caller(request, "sessions:read");
    const owner = ownerOf(url, principal);
    const after = url.searchParams.get("after") ?? undefined;
    const limit = intParam(url, "limit", 100, 1000);
    const folders = aliases
      .storedAs(owner)
      .map((folder) => ({ folder, prefix: keys.sessions(folder) }))
      .sort((a, b) => (a.prefix < b.prefix ? -1 : 1));
    const sessions: SessionMetadata[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (const { folder, prefix } of folders) {
      let startAfter: string | undefined;
      if (after !== undefined) {
        if (after.startsWith(prefix)) startAfter = after;
        else if (after > prefix) continue;
      }
      const page = await listSessions(store, folder, { startAfter, limit });
      sessions.push(...page.sessions.filter((m) => canRead(principal, m, aliases)));
      cursor = page.cursor ?? cursor;
      // A page ends inside a folder; the next one picks up there and goes on to the rest.
      if (page.truncated) {
        truncated = true;
        break;
      }
    }
    return json({ sessions, cursor, truncated });
  });

  route("GET", "/v1/sessions/:agent/:session_id", async ({ request, params, url }) => {
    const principal = await caller(request, "sessions:read");
    const { agent, sessionId } = sessionParams(params);
    const { metadata } = await readable(principal, ownerOf(url, principal), agent, sessionId);
    return json(metadata);
  });

  /** The head trace, or `?hash=`, rendered as `?format=` (`seshi` by default), of a session
   * the principal may read. */
  async function renderedTrace(request: Request, params: Record<string, string>, url: URL) {
    const principal = await caller(request, "sessions:read");
    const { agent, sessionId } = sessionParams(params);
    const { folder, metadata } = await readable(
      principal,
      ownerOf(url, principal),
      agent,
      sessionId,
    );
    if (metadata.status === "redacted") {
      throw new HttpError(410, "redacted", "session was redacted; no trace");
    }
    const format = url.searchParams.get("format") ?? "seshi";
    if (!isRenderFormat(format)) {
      throw new HttpError(400, "bad_query", `format must be one of ${RENDER_FORMATS.join(", ")}`);
    }
    const hash = url.searchParams.get("hash") ?? metadata.head;
    if (!hash) throw new HttpError(404, "no_trace", "session has no trace");
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(404, "not_found", "no such trace");
    const trace = await getTrace(store, folder, archiveId(folder, agent, sessionId), hash);
    if (!trace) throw new HttpError(404, "not_found", "no such trace");
    return {
      agent,
      sessionId,
      format: format as RenderFormat,
      hash,
      body: renderTrace(trace, format),
    };
  }

  route("GET", "/v1/sessions/:agent/:session_id/trace", async ({ request, params, url }) => {
    return json((await renderedTrace(request, params, url)).body);
  });

  /** The same trace as a download: `Content-Disposition: attachment` with a file name that
   * says which session, which trace and which format. */
  route("GET", "/v1/sessions/:agent/:session_id/export", async ({ request, params, url }) => {
    const { agent, sessionId, format, hash, body } = await renderedTrace(request, params, url);
    const name = `${agent}-${sessionId}-${hash.slice(0, 12)}.${format}.json`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    return json(body, 200, { "content-disposition": `attachment; filename="${name}"` });
  });

  /** What model review decided for each stored write of a session (F3.8). Audit records are
   * for admins: an admin gets them whole (policy, models, findings by location, failures);
   * anyone else who may read the session sees only that each write was allowed, redacted or
   * skipped, never the findings (F3 access). Drops are not here: nothing of them is in the
   * session; `seshi sync dropped` lists them. */
  route("GET", "/v1/sessions/:agent/:session_id/reviews", async ({ request, params, url }) => {
    const principal = await caller(request, "sessions:read");
    const { agent, sessionId } = sessionParams(params);
    const { folder } = await readable(principal, ownerOf(url, principal), agent, sessionId);
    const records = await listReviews(store, folder, archiveId(folder, agent, sessionId));
    const audit = principal.role === "admin";
    const view = (r: ReviewRecord) =>
      audit
        ? r
        : {
            schema: r.schema,
            n: r.n,
            at: r.at,
            content_hash: r.content_hash,
            decision: r.decision,
          };
    return json({ reviews: records.map(view) });
  });

  route("PATCH", "/v1/sessions/:agent/:session_id", async ({ request, params, url }) => {
    const principal = await caller(request, "sessions:read");
    const { agent, sessionId } = sessionParams(params);
    const body = await readJson(request, 64 * 1024);
    const visibility = visibilityField(body.visibility);
    if (visibility === undefined) {
      throw new HttpError(400, "missing_field", "visibility is required");
    }
    const { folder, metadata: current } = await readable(
      principal,
      ownerOf(url, principal),
      agent,
      sessionId,
    );
    requireVisibilityChange(principal, folder, aliases, current.owner_basis);
    let metadata: SessionMetadata | null;
    try {
      metadata = await setVisibility({
        store,
        owner: folder,
        agent,
        session_id: sessionId,
        visibility,
        now,
        writer: writerFor(principal),
      });
    } catch (err) {
      if (err instanceof IngestRejected && err.code === "redacted") {
        throw new HttpError(410, "redacted", err.message);
      }
      throw err;
    }
    if (!metadata) throw new HttpError(404, "not_found", "no such session");
    return json(metadata);
  });

  route("DELETE", "/v1/sessions/:agent/:session_id", async ({ request, params, url }) => {
    const principal = await caller(request, "sessions:delete");
    const { agent, sessionId } = sessionParams(params);
    const { folder } = await readable(principal, ownerOf(url, principal), agent, sessionId);
    requireDelete(principal, folder, now(), aliases);
    const result = await tombstone({
      store,
      owner: folder,
      agent,
      session_id: sessionId,
      now,
      reason: "deleted",
      writer: writerFor(principal),
    });
    if (!result) throw new HttpError(404, "not_found", "no such session");
    return json(result);
  });

  /** One owner's change feed. A member reading someone else's sees the entries of sessions
   * that are visible to the org now (X5.10). */
  route("GET", "/v1/changes", async ({ request, url }) => {
    const principal = await caller(request, "sessions:read");
    const owner = ownerOf(url, principal);
    const page: ChangesPage = await readChanges(store, owner, {
      after: url.searchParams.get("after") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: intParam(url, "limit", 100, 1000),
    });
    if (canRead(principal, { owner, visibility: "owner" }, aliases)) return json(page);
    const visible = new Map<string, boolean>();
    const entries = [];
    for (const item of page.entries) {
      const archive = item.entry.archive_id;
      let ok = visible.get(archive);
      if (ok === undefined) {
        const metadata = await readMetadata(store, owner, archive);
        ok = metadata !== null && canRead(principal, metadata, aliases);
        visible.set(archive, ok);
      }
      if (ok) entries.push(item);
    }
    return json({ ...page, entries });
  });

  // --- search (F10) -----------------------------------------------------------------

  /** Keyword search over the sessions the caller may read (F10.4): the server adds the
   * permission filter from the verified principal; nothing in the request widens it. 503 while
   * this instance's index is first built from the change feed (F10.3). */
  route("GET", "/v1/search", async ({ request, url }) => {
    const principal = await caller(request, "search");
    if (!instance.search) {
      throw new HttpError(404, "search_disabled", "search is turned off on this server");
    }
    try {
      return json(
        await instance.search.search(viewerFor(principal, aliases), searchRequestOf(url)),
      );
    } catch (err) {
      if (err instanceof SearchQueryError) throw new HttpError(400, err.code, err.message);
      if (err instanceof SearchUnavailable) {
        return json({ error: { code: err.code, message: err.message } }, 503, {
          "retry-after": String(SEARCH_RETRY_AFTER_S),
        });
      }
      throw err;
    }
  });

  // --- tokens (X5.9, X5.11) -------------------------------------------------------

  function tokenKind(value: unknown): TokenKind {
    if (typeof value !== "string" || !(TOKEN_KINDS as readonly string[]).includes(value)) {
      throw new HttpError(400, "bad_field", `kind must be one of ${TOKEN_KINDS.join(", ")}`);
    }
    return value as TokenKind;
  }

  route("POST", "/v1/tokens", async ({ request }) => {
    const principal = await caller(request, "tokens:admin");
    const body = await readJson(request, 64 * 1024);
    const scopes = body.scopes;
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string"))
    ) {
      throw new HttpError(400, "bad_field", "scopes must be a list of scopes");
    }
    const expiresAt = str(body, "expires_at");
    const expires = expiresAt === undefined ? undefined : new Date(expiresAt);
    if (expires !== undefined && Number.isNaN(expires.getTime())) {
      throw new HttpError(400, "bad_field", "expires_at must be an RFC 3339 time");
    }
    const visibility = visibilityField(body.visibility);
    const owner = str(body, "owner");
    const service = str(body, "service");
    const label = str(body, "label");
    const tokenRequest: TokenRequest = {
      kind: tokenKind(body.kind),
      ...(owner !== undefined ? { owner } : {}),
      ...(service !== undefined ? { service } : {}),
      ...(scopes !== undefined ? { scopes: scopes as Scope[] } : {}),
      ...(visibility ? { visibility } : {}),
      ...(expires !== undefined ? { expires_at: expires } : {}),
      ...(label !== undefined ? { label } : {}),
    };
    try {
      const issued = await auth.issue(tokenRequest, principal);
      return json({ token: issued.token, record: tokenInfo(issued.record) }, 201);
    } catch (err) {
      if (err instanceof AuthRequestError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
  });

  route("GET", "/v1/tokens", async ({ request, url }) => {
    await caller(request, "tokens:admin");
    const owner = url.searchParams.get("owner") ?? undefined;
    const kind = url.searchParams.get("kind");
    const all = url.searchParams.get("all");
    if (all !== null && all !== "true" && all !== "false") {
      throw new HttpError(400, "bad_query", "all must be true or false");
    }
    const records = await auth.tokens.list({
      ...(owner !== undefined ? { owner } : {}),
      ...(kind !== null ? { kind: tokenKind(kind) } : {}),
      all: all === "true",
    });
    return json({ tokens: records.map(tokenInfo) });
  });

  route("POST", "/v1/tokens/revoke", async ({ request }) => {
    await caller(request, "tokens:admin");
    const body = await readJson(request, 64 * 1024);
    const owner = str(body, "owner", true) as string;
    // A person's or service account's id: the org key (owner `*`) is rotated, not revoked by
    // owner (X5.11).
    if (!isOwner(owner)) throw new HttpError(400, "bad_field", "owner is not an owner id");
    const kind = body.kind === undefined ? undefined : tokenKind(body.kind);
    const revoked = await auth.tokens.revokeOwner(owner, kind);
    return json({ revoked: revoked.map(tokenInfo) });
  });

  route("DELETE", "/v1/tokens/:id", async ({ request, params }) => {
    await caller(request, "tokens:admin");
    const record = await auth.tokens.revoke(params.id as string);
    if (!record) throw new HttpError(404, "not_found", "no such token");
    return json({ token: tokenInfo(record) });
  });

  // --- admin (X7.5) ----------------------------------------------------------------

  /** The worker, its jobs and every source: last run, last error, backlog, drop and failure
   * counts. Admin only. */
  route("GET", "/v1/admin/jobs", async ({ request }) => {
    await caller(request, "sources:admin");
    return json(await instance.status());
  });

  // --- redaction (F2.4) -------------------------------------------------------------

  /** The org's rule packs, for a client that redacts before upload: any signed-in caller, the
   * uploader's write-only device token included. They may say what the org considers secret,
   * so they are not public. The built-in pack is not sent (the client has its own); `rule_set`
   * lets the client tell whether its rule set is the server's. The ETag is the rule-set hash,
   * so a client that sends it back gets 304 until the server's packs change. */
  route("GET", "/v1/redaction/rules", async ({ request }) => {
    await authenticate(request);
    const document = rulesDocument(instance.redaction);
    const etag = `"${document.rule_set}"`;
    const cached = request.headers.get("if-none-match");
    if (cached?.split(",").some((t) => t.trim() === etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return json(document, 200, { etag, "cache-control": "private, no-cache" });
  });

  // --- OTLP ingest (F4), outside /v1: OTLP's own v1 follows ----------------------

  const traces = otlpTraces(instance, { bearer, readBody, maxBodyBytes: bodyLimit });
  route("POST", "/otlp/v1/traces", ({ request }) => traces(request));

  // --- admin: sources (X4.8, X6.4) ------------------------------------------------------
  // What `seshi sync status|failed|dropped` read over HTTP. A source no longer in [[sources]]
  // keeps its records until retention prunes them, so its records can still be read.

  /** Whether `id` names a source this deployment knows: `upload`, a configured one, or (with
   * `withRecords`) one that still has records. */
  async function knownSource(id: string, withRecords: boolean): Promise<boolean> {
    if (id === UPLOAD_SOURCE || instance.source(id) !== undefined) return true;
    return withRecords && (await sourcesWithRecords(store)).includes(id);
  }

  function unknownSource(id: string): HttpError {
    return new HttpError(404, "unknown_source", `no source '${id}'`);
  }

  function daysParam(url: URL): number {
    return intParam(url, "days", 7, 90);
  }

  /** Every configured source and `upload`: checkpoint, record counts and health over
   * `?days=` (7 by default). */
  route("GET", "/v1/admin/sources", async ({ request, url }) => {
    await caller(request, "sources:admin");
    const days = daysParam(url);
    const ids = [...instance.config.sources.map((s) => s.id), UPLOAD_SOURCE];
    const sources = [];
    for (const id of ids) sources.push(await instance.sources.status(id, { days }));
    return json({ sources });
  });

  route("GET", "/v1/admin/sources/:id", async ({ request, params, url }) => {
    await caller(request, "sources:admin");
    const id = decodeURIComponent(params.id as string);
    if (!(await knownSource(id, false))) throw unknownSource(id);
    return json(await instance.sources.status(id, { days: daysParam(url) }));
  });

  /** A source's failure or drop records, oldest first: why each envelope was not stored,
   * never its content. `?since=` (a time) or `?after=` (the last key seen), `?limit=`. */
  route("GET", "/v1/admin/sources/:id/:kind", async ({ request, params, url }) => {
    await caller(request, "sources:admin");
    const id = decodeURIComponent(params.id as string);
    const kind = params.kind as string;
    if (kind !== "failed" && kind !== "dropped") {
      throw new HttpError(404, "not_found", `no route ${url.pathname}`);
    }
    if (!(await knownSource(id, true))) throw unknownSource(id);
    const limit = intParam(url, "limit", 50, 1000);
    const after = url.searchParams.get("after") ?? undefined;
    if (after !== undefined && !after.startsWith(keys.records(kind, id))) {
      throw new HttpError(400, "bad_query", `after is not a key of ${id}'s ${kind} records`);
    }
    const sinceParam = url.searchParams.get("since");
    let since: string | undefined;
    if (sinceParam !== null) {
      const at = new Date(sinceParam);
      if (Number.isNaN(at.getTime())) throw new HttpError(400, "bad_query", "since is not a time");
      since = at.toISOString();
    }
    const page = await listRecords(store, kind, id, {
      limit,
      ...(after !== undefined ? { after } : since !== undefined ? { since } : {}),
    });
    return json({ source: id, kind, ...page });
  });

  return { fetch: dispatch(routes), auth, pipeline };
}

/** One handler for every route: the method and path pick it, and the errors the routes throw
 * become their statuses. */
function dispatch(routes: readonly Route[]): (request: Request) => Promise<Response> {
  return async function fetch(request: Request): Promise<Response> {
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
        if (err instanceof Unauthorized) return error(401, err.code, err.message);
        if (err instanceof Forbidden) return error(403, err.code, err.message);
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
  };
}

export type App = ReturnType<typeof createApp>;
