/** The session API over HTTP: `HttpSessionDB` posts transcripts to a seshi server, which runs
 * the pipeline against the bucket it holds, under the owner the token names. Every refusal the
 * server maps to a status comes back as the error the pipeline would have thrown, so a caller's
 * `catch` reads the same as over a store.
 *
 * Depends on `@seshi/model` only (X3.2): the server's keys and the pipeline never reach a
 * machine that only holds a token. */

import { gzipSync } from "node:zlib";
import {
  type ChangesPage,
  type Fetch,
  Forbidden,
  type Identity,
  type ListSessionsOptions,
  OffsetMismatch,
  type ReadChangesOptions,
  type RenderFormat,
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
} from "@seshi/model";

export interface HttpClientOptions {
  /** The server's base URL (`https://sessiondb.example.com`). */
  server: string;
  token: string;
  /** With the org key (X5.12): the username to write as, sent as `X-Seshi-User`. The CLI
   * resolves it from SESHI_USER, the CLI config's `user`, git's user.email, then the OS user
   * name (X5.7). Other credentials name their owner themselves. */
  user?: string;
  /** For tests and custom transports: defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Bodies past this many bytes are sent `Content-Encoding: gzip`. Default 8 KiB. */
  gzipFrom?: number;
  /** Per request; a large transcript can take the server a while to normalize and verify.
   * Default 120 s, the server's own idle timeout. 0 disables. */
  timeoutMs?: number;
  /** Sent as `User-Agent`, so a server's logs say which program uploaded
   * (`dosu-cli/0.68.5`). Default `@dosu/sessiondb/<version>`. */
  userAgent?: string;
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

/** The server's API over `fetch`. Every refusal the server maps to a status comes back as the
 * error the pipeline would have thrown. */
export class HttpSessionDB implements SessionDB {
  readonly server: string;
  private readonly token: string;
  private readonly user: string | undefined;
  private readonly fetch: Fetch;
  private readonly gzipFrom: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.token = options.token;
    this.user = options.user;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.gzipFrom = options.gzipFrom ?? 8 * 1024;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.userAgent = options.userAgent ?? `@dosu/sessiondb/${VERSION}`;
  }

  private async request(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${this.server}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "user-agent": this.userAgent,
      ...(this.user !== undefined ? { "x-seshi-user": this.user } : {}),
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      const json = new TextEncoder().encode(JSON.stringify(options.body));
      if (json.length >= this.gzipFrom) {
        headers["content-encoding"] = "gzip";
        body = new Uint8Array(gzipSync(json));
      } else {
        body = json;
      }
    }
    let response: Response;
    try {
      response = await this.fetch(url.toString(), {
        method,
        headers,
        body,
        ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new StoreError(`cannot reach ${this.server}: ${reason}`, err);
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
    return { status: response.status, body: parsed };
  }

  /** A non-2xx response as the error it stands for; `offset` is the chunk's, for a 409. */
  private static refuse(status: number, body: unknown, offset = 0): never {
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

  async ingest(upload: Upload): Promise<StoreSessionResult> {
    const { status, body } = await this.request("POST", "/v1/sessions", { body: upload });
    if (status !== 200 && status !== 201) HttpSessionDB.refuse(status, body, upload.offset ?? 0);
    return body as StoreSessionResult;
  }

  private sessionPath(agent: string, sessionId: string): string {
    return `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`;
  }

  async getSession(agent: string, sessionId: string): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("GET", this.sessionPath(agent, sessionId));
    if (status === 404) return null;
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as SessionMetadata;
  }

  async getTrace(
    agent: string,
    sessionId: string,
    hash?: string,
    format?: RenderFormat,
  ): Promise<StoredTrace | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.sessionPath(agent, sessionId)}/trace`,
      { query: { hash, format } },
    );
    if (status === 404 || status === 410) return null;
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as StoredTrace;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    const { status, body } = await this.request("GET", "/v1/sessions", {
      query: { after: options.after, limit: options.limit, owner: options.owner },
    });
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as SessionsPage;
  }

  async tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null> {
    const { status, body } = await this.request("DELETE", this.sessionPath(agent, sessionId));
    if (status === 404) return null;
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as { removed: number };
  }

  async changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    const { status, body } = await this.request("GET", "/v1/changes", {
      query: { after: options.after, since: options.since, limit: options.limit },
    });
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as ChangesPage;
  }

  async me(): Promise<Identity> {
    const { status, body } = await this.request("GET", "/v1/me");
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as Identity;
  }

  /** The org's redaction rule packs (`GET /v1/redaction/rules`, F2.4), for redacting before
   * upload: a `seshi/redaction-rules/1` document, unchecked. `@seshi/redact`'s
   * `ruleSetFromDocument` validates it and builds the rule set. */
  async redactionRules(): Promise<unknown> {
    const { status, body } = await this.request("GET", "/v1/redaction/rules");
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body;
  }
}
