import type { Principal } from "@seshi/auth";
import {
  HttpSeshi,
  type OwnerOption,
  type ReviewDecision,
  type TokenInfo,
  type TokenKind,
  type TokenRequest,
} from "@seshi/client";
import type { Instance } from "@seshi/instance";
import {
  type Identity,
  isStub,
  localWriter,
  type RenderFormat,
  type SearchRequest,
  type SearchResults,
  type SessionEvents,
  type SessionEventsRequest,
  type SessionList,
  type SessionListRequest,
  type SessionMetadata,
  type SessionsPage,
  type SqlRequest,
  type SqlResult,
  type SqlSchema,
  type StoredTrace,
  type Visibility,
} from "@seshi/model";
import type { StoreSeshi } from "@seshi/pipeline";
import {
  LOCAL_VIEWER,
  readSessionEvents,
  type SearchService,
  SessionReadError,
  type SqlCaller,
  TraceCache,
  type Viewer,
  viewerFor,
} from "@seshi/search";
import { readMetadata } from "@seshi/store";
import { type Account, accountCredential, serverOf } from "./account/account";
import type { Purpose } from "./account/credential";
import { NotSignedIn } from "./account/credential";
import { EXIT } from "./cli/exit";
import { Refused } from "./cli/failures";
import type { CommandContext } from "./commands/index";
import { needsUpdate, refusalOf, SERVERLESS_BASIS, type ServerlessBucket } from "./serverless/open";
import { isServerless } from "./serverless/settings";
import { USER_AGENT } from "./user-agent";

export interface TraceOptions extends OwnerOption {
  hash?: string;
  render?: RenderFormat;
}

export interface SearchHooks {
  building?: () => void;
}

/** A session as a reader names it: by its format and id (with `owner`, another's), or by its
 * owner and archive id, as search results and listings name it. */
export type SessionRef =
  | { format: string; sessionId: string; owner?: string }
  | { owner: string; archiveId: string };

const ARCHIVE = /^[0-9a-f]{64}$/;

/** A session named in one string: `owner/archive_id`, `format/session_id`, or a server URL
 * that ends in either (`…/v1/owners/<owner>/sessions/<archive_id>`,
 * `…/v1/sessions/<format>/<session_id>`). Undefined for anything else. */
export function parseSessionRef(text: string): SessionRef | undefined {
  let path = text.trim();
  if (/^https?:\/\//.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return undefined;
    }
    const parts = url.pathname
      .split("/")
      .filter((p) => p !== "")
      .map(decodeURIComponent);
    const owners = parts.lastIndexOf("owners");
    if (owners >= 0 && parts[owners + 2] === "sessions" && parts[owners + 3] !== undefined) {
      const [owner, archiveId] = [parts[owners + 1] as string, parts[owners + 3] as string];
      return ARCHIVE.test(archiveId) ? { owner, archiveId } : undefined;
    }
    const sessions = parts.lastIndexOf("sessions");
    if (sessions >= 0 && parts[sessions + 2] !== undefined) {
      return {
        format: parts[sessions + 1] as string,
        sessionId: parts[sessions + 2] as string,
        ...(url.searchParams.get("owner")
          ? { owner: url.searchParams.get("owner") as string }
          : {}),
      };
    }
    return undefined;
  }
  const slash = path.indexOf("/");
  if (slash <= 0 || slash === path.length - 1) return undefined;
  const [first, rest] = [path.slice(0, slash), path.slice(slash + 1)];
  if (ARCHIVE.test(rest)) return { owner: first, archiveId: rest };
  path = rest;
  return { format: first, sessionId: path };
}

/** How a reference is written back: `owner/archive_id` or `format/session_id`. */
export function sessionRefText(ref: SessionRef): string {
  return "archiveId" in ref ? `${ref.owner}/${ref.archiveId}` : `${ref.format}/${ref.sessionId}`;
}

export interface Backend {
  mode: "server" | "serverless";
  where: string;
  me(): Promise<Identity>;
  listSessions(options: { owner?: string; after?: string; limit?: number }): Promise<SessionsPage>;
  getSession(
    format: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<SessionMetadata | null>;
  getTrace(format: string, sessionId: string, options?: TraceOptions): Promise<StoredTrace | null>;
  tombstone(
    format: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<{ removed: number } | null>;
  setVisibility(
    format: string,
    sessionId: string,
    visibility: Visibility,
    options?: OwnerOption,
  ): Promise<SessionMetadata | null>;
  reviews(
    format: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<ReviewDecision[] | null>;
  search(request: SearchRequest, hooks?: SearchHooks): Promise<SearchResults>;
  /** One read-only SELECT over the index's views: the server's `POST /v1/sql`, or a local
   * worker over a serverless laptop's own index. */
  sql(request: SqlRequest, hooks?: SearchHooks): Promise<SqlResult>;
  sqlSchema(window?: { since?: string; until?: string }, hooks?: SearchHooks): Promise<SqlSchema>;
  /** Sessions by who, where and when, from the search index (`list_sessions`). */
  searchSessions(request: SessionListRequest, hooks?: SearchHooks): Promise<SessionList>;
  /** Part of a session's events (`read_session`). */
  sessionEvents(ref: SessionRef, request: SessionEventsRequest): Promise<SessionEvents>;
  listTokens(filter: { owner?: string; kind?: TokenKind; all?: boolean }): Promise<TokenInfo[]>;
  createToken(request: TokenRequest): Promise<{ token: string; record: TokenInfo }>;
  revokeToken(id: string): Promise<TokenInfo | null>;
  revokeOwnerTokens(owner: string, kind?: TokenKind): Promise<TokenInfo[]>;
  close(): Promise<void>;
}

export class ServerBackend implements Backend {
  readonly mode = "server";

  constructor(
    readonly db: HttpSeshi,
    readonly user?: string,
  ) {}

  get where(): string {
    return this.db.server;
  }
  me(): Promise<Identity> {
    return this.db.me();
  }
  listSessions(options: { owner?: string; after?: string; limit?: number }) {
    return this.db.listSessions(options);
  }
  getSession(format: string, sessionId: string, options: OwnerOption = {}) {
    return this.db.getSession(format, sessionId, options);
  }
  getTrace(format: string, sessionId: string, options: TraceOptions = {}) {
    return this.db.getTrace(format, sessionId, options.hash, options.render, {
      ...(options.owner ? { owner: options.owner } : {}),
    });
  }
  tombstone(format: string, sessionId: string, options: OwnerOption = {}) {
    return this.db.tombstone(format, sessionId, options);
  }
  setVisibility(
    format: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ) {
    return this.db.setVisibility(format, sessionId, visibility, options);
  }
  reviews(format: string, sessionId: string, options: OwnerOption = {}) {
    return this.db.reviews(format, sessionId, options);
  }
  search(request: SearchRequest): Promise<SearchResults> {
    return this.db.search(request);
  }
  sql(request: SqlRequest): Promise<SqlResult> {
    return this.db.sql(request);
  }
  sqlSchema(window: { since?: string; until?: string } = {}): Promise<SqlSchema> {
    return this.db.sqlSchema(window);
  }
  searchSessions(request: SessionListRequest): Promise<SessionList> {
    return this.db.searchSessions(request);
  }
  sessionEvents(ref: SessionRef, request: SessionEventsRequest): Promise<SessionEvents> {
    return "archiveId" in ref
      ? this.db.sessionEventsByArchive(ref.owner, ref.archiveId, request)
      : this.db.sessionEvents(ref.format, ref.sessionId, request, {
          ...(ref.owner ? { owner: ref.owner } : {}),
        });
  }
  listTokens(filter: { owner?: string; kind?: TokenKind; all?: boolean }) {
    return this.db.listTokens(filter);
  }
  createToken(request: TokenRequest) {
    return this.db.createToken(request);
  }
  revokeToken(id: string) {
    return this.db.revokeToken(id);
  }
  revokeOwnerTokens(owner: string, kind?: TokenKind) {
    return this.db.revokeOwnerTokens(owner, kind);
  }
  async close(): Promise<void> {}
}

/** Serverless mode (F11): this machine reads and writes the bucket as a member of its owner.
 * The visibility rule is applied here (F11.5); what the key may do is the bucket's to decide
 * (F11.4), and a refusal becomes a message. */
export class ServerlessBackend implements Backend {
  readonly mode = "serverless";

  constructor(
    readonly bucket: ServerlessBucket,
    /** `--include-private`: read every session the key can, owner-only ones included. Not a
     * permission: a key that can read the bucket can read every session. */
    readonly includePrivate = false,
  ) {}

  get instance(): Instance {
    return this.bucket.instance;
  }

  get owner(): string {
    return this.bucket.owner;
  }

  get where(): string {
    return this.instance.storage.url;
  }

  private sessionsAs(owner?: string): StoreSeshi {
    if (owner === undefined || owner === this.owner) {
      return this.instance.localSessions(this.owner, SERVERLESS_BASIS);
    }
    return this.instance.sessions({
      owner,
      writer: localWriter(this.owner),
      owner_basis: SERVERLESS_BASIS,
    });
  }

  principal(): Principal {
    return {
      kind: "local",
      owner: this.owner,
      owner_basis: SERVERLESS_BASIS,
      role: "member",
      scopes: new Set(["sessions:write", "sessions:read", "sessions:delete", "search"]),
      credential: "static",
      credential_id: "serverless",
      claims: {},
    };
  }

  viewer(): Viewer {
    return this.includePrivate
      ? LOCAL_VIEWER
      : viewerFor(this.principal(), this.instance.auth.aliases);
  }

  private readable(metadata: SessionMetadata | null): SessionMetadata | null {
    if (metadata === null) return null;
    return this.viewer().canRead({
      owner: metadata.owner,
      ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
    })
      ? metadata
      : null;
  }

  private async refused<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw refusalOf(err, this.owner);
    }
  }

  private writable(): void {
    if (this.bucket.writable) return;
    throw new Refused(
      EXIT.config,
      "needs_update",
      needsUpdate(this.bucket.marker.min_version as string),
    );
  }

  async me(): Promise<Identity> {
    return {
      owner: this.owner,
      storage: this.instance.storage,
      kind: "local",
      role: "member",
      owner_basis: SERVERLESS_BASIS,
    };
  }
  /** A page of the sessions this viewer may read. Sessions it may not are left out before
   * counting: listings are read, each asking for what is still wanted, until `limit`
   * readable ones are found (without a limit, until one listing holds any) or the listing
   * ends. */
  listSessions(options: { owner?: string; after?: string; limit?: number }) {
    return this.refused(async () => {
      const db = this.sessionsAs(options.owner);
      const sessions: SessionMetadata[] = [];
      let after = options.after;
      for (;;) {
        const left = options.limit === undefined ? undefined : options.limit - sessions.length;
        const page = await db.listSessions({
          ...(after ? { after } : {}),
          ...(left !== undefined ? { limit: left } : {}),
        });
        sessions.push(...page.sessions.filter((s) => this.readable(s) !== null));
        // Without a limit, a page is whatever one listing holds, unless none of it is readable.
        const full =
          options.limit !== undefined ? sessions.length >= options.limit : sessions.length > 0;
        if (full || !page.truncated || page.cursor === undefined || page.cursor === after) {
          return { sessions, cursor: page.cursor, truncated: page.truncated };
        }
        after = page.cursor;
      }
    });
  }
  getSession(format: string, sessionId: string, options: OwnerOption = {}) {
    return this.refused(async () =>
      this.readable(await this.sessionsAs(options.owner).getSession(format, sessionId)),
    );
  }
  async getTrace(format: string, sessionId: string, options: TraceOptions = {}) {
    if (!(await this.getSession(format, sessionId, options))) return null;
    return this.refused(() =>
      this.sessionsAs(options.owner).getTrace(format, sessionId, options.hash, options.render),
    );
  }
  async tombstone(format: string, sessionId: string, options: OwnerOption = {}) {
    this.writable();
    return this.refused(() => this.sessionsAs(options.owner).tombstone(format, sessionId));
  }
  async setVisibility(
    format: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ) {
    this.writable();
    return this.refused(() =>
      this.sessionsAs(options.owner).setVisibility(format, sessionId, visibility),
    );
  }
  async reviews(format: string, sessionId: string, options: OwnerOption = {}) {
    if (!(await this.getSession(format, sessionId, options))) return null;
    const { archiveId, listReviews } = await import("@seshi/store");
    const owner = options.owner ?? this.owner;
    const records = await this.refused(() =>
      listReviews(this.instance.store, owner, archiveId(owner, format, sessionId)),
    );
    return records as ReviewDecision[];
  }
  /** The laptop's own index, caught up unless it caught up within two indexer intervals. */
  private async index(hooks: SearchHooks): Promise<SearchService> {
    const search = this.instance.search;
    if (!search) {
      throw new Refused(
        EXIT.config,
        "search_disabled",
        "search is off on this machine: set [search] enabled = true in the CLI config",
      );
    }
    const status = await search.status();
    if (!status.ready) hooks.building?.();
    const caughtUp = status.caught_up_at;
    const fresh =
      caughtUp !== undefined &&
      Date.now() - Date.parse(caughtUp) < 2 * this.instance.config.search.interval;
    if (!fresh) await this.refused(() => search.catchUp());
    return search;
  }
  async search(request: SearchRequest, hooks: SearchHooks = {}): Promise<SearchResults> {
    return (await this.index(hooks)).search(this.viewer(), request);
  }
  async searchSessions(request: SessionListRequest, hooks: SearchHooks = {}): Promise<SessionList> {
    return (await this.index(hooks)).listSessions(this.viewer(), request);
  }
  /** Decoded traces this process has read, for reads of one session a range at a time. */
  private readonly traceCache = new TraceCache(8);
  async sessionEvents(ref: SessionRef, request: SessionEventsRequest): Promise<SessionEvents> {
    const located = await this.refused(async () => {
      if ("archiveId" in ref) {
        const metadata = this.readable(
          await readMetadata(this.instance.store, ref.owner, ref.archiveId),
        );
        return metadata && !isStub(metadata) ? { folder: ref.owner, metadata } : null;
      }
      const metadata = this.readable(
        await this.sessionsAs(ref.owner).getSession(ref.format, ref.sessionId),
      );
      return metadata && !isStub(metadata) ? { folder: ref.owner ?? this.owner, metadata } : null;
    });
    if (located === null) {
      throw new SessionReadError(404, "not_found", `no session ${sessionRefText(ref)}`);
    }
    return this.refused(() =>
      readSessionEvents({
        store: this.instance.store,
        ...located,
        request,
        cache: this.traceCache,
      }),
    );
  }

  /** `sql` over the laptop's own index (T11), with the visibility rule `search` follows: the
   * user's own sessions and the org's, owner-only ones too with `--include-private`. */
  private sqlCaller(): SqlCaller {
    return { viewer: this.viewer(), as: this.owner, role: "local", key: this.owner };
  }

  private localSql() {
    const sql = this.instance.sql;
    if (!sql) {
      throw new Refused(
        EXIT.config,
        "search_disabled",
        "sql reads the search index, which is off on this machine: set [search] enabled = true in the CLI config",
      );
    }
    return sql;
  }

  async sql(request: SqlRequest, hooks: SearchHooks = {}): Promise<SqlResult> {
    const sql = this.localSql();
    await this.index(hooks);
    return sql.query(this.sqlCaller(), request);
  }

  async sqlSchema(
    window: { since?: string; until?: string } = {},
    hooks: SearchHooks = {},
  ): Promise<SqlSchema> {
    const sql = this.localSql();
    await this.index(hooks);
    return sql.schema(this.sqlCaller(), window);
  }
  private noTokens(): never {
    throw new Refused(
      EXIT.config,
      "needs_server",
      "tokens need a server: in serverless mode the bucket's keys are the only credentials",
    );
  }
  async listTokens(): Promise<TokenInfo[]> {
    return this.noTokens();
  }
  async createToken(): Promise<{ token: string; record: TokenInfo }> {
    return this.noTokens();
  }
  async revokeToken(): Promise<TokenInfo | null> {
    return this.noTokens();
  }
  async revokeOwnerTokens(): Promise<TokenInfo[]> {
    return this.noTokens();
  }
  close(): Promise<void> {
    return this.bucket.close();
  }
}

declare const deleteConfirmed: unique symbol;

export interface DeleteConfirmation {
  readonly [deleteConfirmed]: true;
}

export type OpenBackendOptions = {
  server?: string;
  /** Serverless mode: read owner-only sessions too (`--include-private`). */
  includePrivate?: boolean;
} & (
  | { purpose?: Exclude<Purpose, "delete"> }
  | { purpose: "delete"; confirmed: DeleteConfirmation }
);

export async function openBackend(
  ctx: CommandContext,
  account: Account,
  options: OpenBackendOptions = {},
): Promise<Backend> {
  if (options.server === undefined && isServerless(account.cli)) {
    const { openServerless } = await import("./serverless/open");
    const bucket = await openServerless({
      cli: account.cli,
      env: account.env,
      home: account.home,
      integrations: await ctx.integrations(),
      secrets: account.secrets,
      write: false,
    });
    for (const warning of bucket.warnings) ctx.stderr(`seshi: warning: ${warning}`);
    return new ServerlessBackend(bucket, options.includePrivate ?? false);
  }
  const server = serverOf(account, options.server);
  if (server === undefined) throw new NotSignedIn(undefined);
  const credential = await accountCredential(account, server, options.purpose ?? "read");
  if (credential.fallback) ctx.stderr(`seshi: warning: ${credential.fallback}`);
  return new ServerBackend(
    new HttpSeshi({
      server,
      token: credential.token,
      userAgent: USER_AGENT,
      ...(credential.user ? { user: credential.user } : {}),
    }),
    credential.user,
  );
}
