/** The session API over HTTP: `HttpSessionDB` posts transcripts to a seshi server, which runs
 * the pipeline against the bucket it holds, under the owner the token names. Every refusal the
 * server maps to a status comes back as the error the pipeline would have thrown, so a caller's
 * `catch` reads the same as over a store. Beyond the session API it reads other owners'
 * sessions (`?owner=`, X5.10), changes a session's visibility, manages tokens (X5.9) and reads
 * the worker's and the sources' status (X7.5); `authConfig` and `exchangeIdToken` are the two
 * calls made before there is a token (X5.7).
 *
 * Depends on `@seshi/model` only (X3.2): the server's keys and the pipeline never reach a
 * machine that only holds a token. */

import { gzipSync } from "node:zlib";
import {
  type ChangesPage,
  type Fetch,
  Forbidden,
  type Identity,
  type IngestOptions,
  type ListSessionsOptions,
  OffsetMismatch,
  type ReadChangesOptions,
  type RenderFormat,
  type SearchRequest,
  type SearchResults,
  SessionConflict,
  type SessionDB,
  type SessionMetadata,
  SessionRejected,
  type SessionsPage,
  type StoredTrace,
  StoreError,
  type StoreSessionResult,
  type Upload,
  VERSION,
  type Visibility,
} from "@seshi/model";
import type {
  AuthConfig,
  ExchangeRequest,
  ExchangeResult,
  JobsStatus,
  OwnersPage,
  RecordKind,
  RecordsPage,
  ReviewDecision,
  SourceStatus,
  TokenInfo,
  TokenKind,
  TokenRequest,
} from "./types";

/** How a client reaches the server, with or without a credential. */
export interface TransportOptions {
  /** The server's base URL (`https://seshi.example.com`). */
  server: string;
  /** For tests and custom transports: defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Per request; a large transcript can take the server a while to normalize and verify.
   * Default 120 s, the server's own idle timeout. 0 disables. */
  timeoutMs?: number;
  /** Sent as `User-Agent`, so a server's logs say which program called
   * (`dosu-cli/0.68.5`). Default `@dosu/sessiondb/<version>`. */
  userAgent?: string;
}

export interface HttpClientOptions extends TransportOptions {
  token: string;
  /** With the org key (X5.12): the username to write as, sent as `X-Seshi-User`. The CLI
   * resolves it from SESHI_USER, the CLI config's `user`, git's user.email, then the OS user
   * name (X5.7). Other credentials name their owner themselves. */
  user?: string;
  /** Bodies past this many bytes are sent `Content-Encoding: gzip`. Default 8 KiB. */
  gzipFrom?: number;
}

/** The header a retraction carries its secret in (F9.7). */
export const RETRACT_HEADER = "x-seshi-retract";

/** Whose session a read or change is about: the caller's own when `owner` is omitted. A member
 * reads another owner's sessions as far as visibility allows (X5.10). */
export interface OwnerOption {
  owner?: string;
}

/** A response the server gave that is not one of the pipeline's own refusals: unauthorized, a
 * bad request, an internal error, a route that is not there. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; expected?: number };
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  gzipFrom?: number;
}

/** What one request answered: its status, its JSON body, and its headers. */
interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

/** One request to the server, its JSON answer and status. Network failures are `StoreError`
 * ("cannot reach"); a 2xx that is not JSON is `ServerError` `bad_response`. */
async function send(
  transport: TransportOptions,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Answer> {
  const server = transport.server.replace(/\/+$/, "");
  const fetchImpl = transport.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = transport.timeoutMs ?? 120_000;
  const url = new URL(`${server}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    "user-agent": transport.userAgent ?? `@dosu/sessiondb/${VERSION}`,
    ...options.headers,
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    const json = new TextEncoder().encode(JSON.stringify(options.body));
    if (json.length >= (options.gzipFrom ?? Number.POSITIVE_INFINITY)) {
      headers["content-encoding"] = "gzip";
      body = new Uint8Array(gzipSync(json));
    } else {
      body = json;
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers,
      body,
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new StoreError(`cannot reach ${server}: ${reason}`, err);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A proxy's own error page is a refusal with no envelope, reported by status alone; a
      // 2xx that is not JSON is not the server at all.
      if (response.ok) {
        throw new ServerError(response.status, "bad_response", `not JSON: ${text.slice(0, 200)}`);
      }
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function errorCode(body: unknown): string | undefined {
  return (body as ErrorBody | null)?.error?.code;
}

/** A non-2xx response as the error it stands for; `offset` is the chunk's, for a 409. */
function refuse(status: number, body: unknown, offset = 0): never {
  const error = (body as ErrorBody | null)?.error ?? {};
  const code = error.code ?? "unknown";
  const message = error.message ?? `HTTP ${status}`;
  if (status === 409 && code === "offset_mismatch") {
    throw new OffsetMismatch(offset, error.expected ?? 0);
  }
  if (status === 409 && code === "conflict") throw new SessionConflict(message);
  if (status === 403 && code === "forbidden") throw new Forbidden(message);
  if (status === 422) throw new SessionRejected(code, message);
  if (status === 502) throw new StoreError(message);
  throw new ServerError(status, code, message);
}

/** `GET /v1/auth/config`: whether the server takes the org key and which IdP it signs in
 * through (X5.7). Needs no credential. */
export async function authConfig(transport: TransportOptions): Promise<AuthConfig> {
  const { status, body } = await send(transport, "GET", "/v1/auth/config");
  if (status !== 200) refuse(status, body);
  return body as AuthConfig;
}

/** `POST /v1/auth/exchange`: an IdP ID token for a session token, and a device token when the
 * request names a machine (X5.2). Needs no credential; a token the server does not accept is
 * `ServerError` 401, a server without an IdP 404 `no_idp`. */
export async function exchangeIdToken(
  transport: TransportOptions,
  request: ExchangeRequest,
): Promise<ExchangeResult> {
  const { status, body } = await send(transport, "POST", "/v1/auth/exchange", { body: request });
  if (status !== 200) refuse(status, body);
  return body as ExchangeResult;
}

/** The server's API over `fetch`. Every refusal the server maps to a status comes back as the
 * error the pipeline would have thrown. */
export class HttpSessionDB implements SessionDB {
  readonly server: string;
  private readonly token: string;
  private readonly user: string | undefined;
  private readonly transport: TransportOptions;
  private readonly gzipFrom: number;

  constructor(options: HttpClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.token = options.token;
    this.user = options.user;
    this.gzipFrom = options.gzipFrom ?? 8 * 1024;
    this.transport = {
      server: this.server,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    };
  }

  private request(method: string, path: string, options: RequestOptions = {}): Promise<Answer> {
    return send(this.transport, method, path, {
      ...options,
      gzipFrom: this.gzipFrom,
      headers: {
        ...options.headers,
        authorization: `Bearer ${this.token}`,
        ...(this.user !== undefined ? { "x-seshi-user": this.user } : {}),
      },
    });
  }

  /** `POST /v1/sessions`. With `retractSecret` (for a `replace` with the org key) the secret
   * goes in `X-Seshi-Retract`, never the body. */
  async ingest(upload: Upload, options: IngestOptions = {}): Promise<StoreSessionResult> {
    const { status, body } = await this.request("POST", "/v1/sessions", {
      body: upload,
      ...(options.retractSecret !== undefined
        ? { headers: { [RETRACT_HEADER]: options.retractSecret } }
        : {}),
    });
    if (status !== 200 && status !== 201) refuse(status, body, upload.offset ?? 0);
    return body as StoreSessionResult;
  }

  private sessionPath(agent: string, sessionId: string): string {
    return `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`;
  }

  /** The session's metadata; null for one not stored, or one the caller may not read. */
  async getSession(
    agent: string,
    sessionId: string,
    options: OwnerOption = {},
  ): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("GET", this.sessionPath(agent, sessionId), {
      query: { owner: options.owner },
    });
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as SessionMetadata;
  }

  /** The head trace, or `hash`, as `format`; null for a session not stored, unreadable or
   * redacted. */
  async getTrace(
    agent: string,
    sessionId: string,
    hash?: string,
    format?: RenderFormat,
    options: OwnerOption = {},
  ): Promise<StoredTrace | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.sessionPath(agent, sessionId)}/trace`,
      { query: { hash, format, owner: options.owner } },
    );
    if (status === 404 || status === 410) return null;
    if (status !== 200) refuse(status, body);
    return body as StoredTrace;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    const { status, body } = await this.request("GET", "/v1/sessions", {
      query: { after: options.after, limit: options.limit, owner: options.owner },
    });
    if (status !== 200) refuse(status, body);
    return body as SessionsPage;
  }

  /** Delete the session: a tombstone in its owner's change feed (X5.3); null for one not
   * stored. Needs `sessions:delete`, and with an IdP a session token under 10 minutes old.
   * With `retractSecret` it is a retraction instead (F9.7): the machine that uploaded the
   * session proves it with the secret whose hash it sent, using its normal upload credential
   * (`sessions:write`), and the tombstone says `retracted`. A refused retraction is
   * `ServerError` 403 `bad_retract_secret` or `retract_disabled`. */
  async tombstone(
    agent: string,
    sessionId: string,
    options: OwnerOption & { retractSecret?: string } = {},
  ): Promise<{ removed: number } | null> {
    const { status, body } = await this.request("DELETE", this.sessionPath(agent, sessionId), {
      query: { owner: options.owner },
      ...(options.retractSecret !== undefined
        ? { headers: { [RETRACT_HEADER]: options.retractSecret } }
        : {}),
    });
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as { removed: number };
  }

  /** Change who may read a session (X5.10); the metadata as it now is, null for one not
   * stored. A redacted session is `ServerError` 410. The owner or an admin may. */
  async setVisibility(
    agent: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("PATCH", this.sessionPath(agent, sessionId), {
      body: { visibility },
      query: { owner: options.owner },
    });
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as SessionMetadata;
  }

  /** What model review decided for each stored write of the session, oldest first (F3.8,
   * `GET …/reviews`): the whole audit record for admins, only `n`, `at`, `content_hash` and
   * `decision` for anyone else who may read it. Null for a session not stored. */
  async reviews(
    agent: string,
    sessionId: string,
    options: OwnerOption = {},
  ): Promise<ReviewDecision[] | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.sessionPath(agent, sessionId)}/reviews`,
      { query: { owner: options.owner } },
    );
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return (body as { reviews: ReviewDecision[] }).reviews;
  }

  async changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    const { status, body } = await this.request("GET", "/v1/changes", {
      query: { after: options.after, since: options.since, limit: options.limit },
    });
    if (status !== 200) refuse(status, body);
    return body as ChangesPage;
  }

  /** Keyword search over the sessions this credential may read (F10, `GET /v1/search`). A
   * request the server cannot run is a `ServerError` with status 400 (`bad_query`); while the
   * server's index is first being built, status 503 (`index_building`), and 404
   * (`search_disabled`) when the server has search turned off. */
  async search(request: SearchRequest): Promise<SearchResults> {
    const { status, body } = await this.request("GET", "/v1/search", {
      query: {
        q: request.q,
        owner: request.owner,
        agent: request.agent,
        repo: request.repo,
        branch: request.branch,
        source: request.source,
        since: request.since,
        until: request.until,
        sort: request.sort,
        limit: request.limit,
        matches: request.matches,
        cursor: request.cursor,
      },
    });
    if (status !== 200) refuse(status, body);
    return body as SearchResults;
  }

  async me(): Promise<Identity> {
    const { status, body } = await this.request("GET", "/v1/me");
    if (status !== 200) refuse(status, body);
    return body as Identity;
  }

  /** The org's redaction rule packs (`GET /v1/redaction/rules`, F2.4), for redacting before
   * upload: a `seshi/redaction-rules/1` document, unchecked. `@seshi/redact`'s
   * `ruleSetFromDocument` validates it and builds the rule set. */
  async redactionRules(): Promise<unknown> {
    const { status, body } = await this.request("GET", "/v1/redaction/rules");
    if (status !== 200) refuse(status, body);
    return body;
  }

  /** `redactionRules` with HTTP caching, for a client that keeps the document between runs:
   * `etag`, from an earlier answer, goes as If-None-Match. `null` means the rule set has not
   * changed since; otherwise the document comes back with its own ETag. */
  async redactionRulesSince(
    etag?: string,
  ): Promise<{ document: unknown; etag: string | undefined } | null> {
    const { status, body, headers } = await this.request("GET", "/v1/redaction/rules", {
      ...(etag ? { headers: { "if-none-match": etag } } : {}),
    });
    if (status === 304 && etag) return null;
    if (status !== 200) refuse(status, body);
    return { document: body, etag: headers.get("etag") ?? undefined };
  }

  /** The owners with sessions stored. */
  async owners(options: { after?: string; limit?: number } = {}): Promise<OwnersPage> {
    const { status, body } = await this.request("GET", "/v1/owners", {
      query: { after: options.after, limit: options.limit },
    });
    if (status !== 200) refuse(status, body);
    return body as OwnersPage;
  }

  // --- tokens (X5.9, X5.11): `tokens:admin` -------------------------------------------

  /** Issue a token; its secret is in the answer only. */
  async createToken(request: TokenRequest): Promise<{ token: string; record: TokenInfo }> {
    const { status, body } = await this.request("POST", "/v1/tokens", { body: request });
    if (status !== 201) refuse(status, body);
    return body as { token: string; record: TokenInfo };
  }

  /** Live tokens, or every one with `all`. */
  async listTokens(
    filter: { owner?: string; kind?: TokenKind; all?: boolean } = {},
  ): Promise<TokenInfo[]> {
    const { status, body } = await this.request("GET", "/v1/tokens", {
      query: { owner: filter.owner, kind: filter.kind, all: filter.all ? "true" : undefined },
    });
    if (status !== 200) refuse(status, body);
    return (body as { tokens: TokenInfo[] }).tokens;
  }

  /** Revoke one token; null for an unknown id. */
  async revokeToken(id: string): Promise<TokenInfo | null> {
    const { status, body } = await this.request("DELETE", `/v1/tokens/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return (body as { token: TokenInfo }).token;
  }

  /** Revoke every token of an owner (offboarding, X5.11), or every one of a kind. */
  async revokeOwnerTokens(owner: string, kind?: TokenKind): Promise<TokenInfo[]> {
    const { status, body } = await this.request("POST", "/v1/tokens/revoke", {
      body: { owner, ...(kind ? { kind } : {}) },
    });
    if (status !== 200) refuse(status, body);
    return (body as { revoked: TokenInfo[] }).revoked;
  }

  // --- admin (X7.5): `sources:admin` ---------------------------------------------------

  /** The worker, its jobs and every source. */
  async jobs(): Promise<JobsStatus> {
    const { status, body } = await this.request("GET", "/v1/admin/jobs");
    if (status !== 200) refuse(status, body);
    return body as JobsStatus;
  }

  /** Every configured source and `upload`: checkpoints, record counts, health over `days`. */
  async sources(options: { days?: number } = {}): Promise<SourceStatus[]> {
    const { status, body } = await this.request("GET", "/v1/admin/sources", {
      query: { days: options.days },
    });
    if (status !== 200) refuse(status, body);
    return (body as { sources: SourceStatus[] }).sources;
  }

  /** One source's status; null for an unknown source. */
  async source(id: string, options: { days?: number } = {}): Promise<SourceStatus | null> {
    const { status, body } = await this.request(
      "GET",
      `/v1/admin/sources/${encodeURIComponent(id)}`,
      { query: { days: options.days } },
    );
    if (status === 404 && errorCode(body) === "unknown_source") return null;
    if (status !== 200) refuse(status, body);
    return body as SourceStatus;
  }

  /** A source's failure or drop records, oldest first (X6.4); null for an unknown source. */
  async records(
    kind: RecordKind,
    id: string,
    options: { since?: string; after?: string; limit?: number } = {},
  ): Promise<RecordsPage | null> {
    const { status, body } = await this.request(
      "GET",
      `/v1/admin/sources/${encodeURIComponent(id)}/${kind}`,
      { query: { since: options.since, after: options.after, limit: options.limit } },
    );
    if (status === 404 && errorCode(body) === "unknown_source") return null;
    if (status !== 200) refuse(status, body);
    return body as RecordsPage;
  }
}
