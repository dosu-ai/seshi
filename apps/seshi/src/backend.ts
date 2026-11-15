/** What the session, token and search commands talk to (F8.3): a seshi server through
 * `@seshi/client` with the credential `seshi login` stored, or, in local mode (X3.5), an
 * Instance built in-process for the one person who owns the bucket. The commands see one
 * interface, so `seshi sessions ls` and `seshi search` read the same either way. Nothing else
 * touches a bucket. */

import type { TokenRequest as AuthTokenRequest, Principal } from "@seshi/auth";
import {
  HttpSessionDB,
  type OwnerOption,
  type ReviewDecision,
  type TokenInfo,
  type TokenKind,
  type TokenRequest,
} from "@seshi/client";
import type { Instance } from "@seshi/instance";
import {
  type Identity,
  localWriter,
  type RenderFormat,
  type SearchRequest,
  type SearchResults,
  type SessionMetadata,
  type SessionsPage,
  type StoredTrace,
  type Visibility,
} from "@seshi/model";
import type { StoreSessionDB } from "@seshi/pipeline";
import { type Account, accountCredential, serverOf } from "./account/account";
import type { Purpose } from "./account/credential";
import { NotSignedIn } from "./account/credential";
import { EXIT } from "./cli/exit";
import { Refused } from "./cli/failures";
import type { CommandContext } from "./commands/index";
import { USER_AGENT } from "./user-agent";

export interface TraceOptions extends OwnerOption {
  hash?: string;
  format?: RenderFormat;
}

export interface SearchHooks {
  /** Called before a local index is first built from the change feed (it can take a while). */
  building?: () => void;
}

export interface Backend {
  mode: "server" | "local";
  /** The server's URL, or the bucket's. */
  where: string;
  me(): Promise<Identity>;
  listSessions(options: { owner?: string; after?: string; limit?: number }): Promise<SessionsPage>;
  getSession(
    agent: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<SessionMetadata | null>;
  getTrace(agent: string, sessionId: string, options?: TraceOptions): Promise<StoredTrace | null>;
  tombstone(
    agent: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<{ removed: number } | null>;
  setVisibility(
    agent: string,
    sessionId: string,
    visibility: Visibility,
    options?: OwnerOption,
  ): Promise<SessionMetadata | null>;
  /** What model review decided for each stored write (F3.8), oldest first; null for a session
   * not stored. */
  reviews(
    agent: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<ReviewDecision[] | null>;
  /** Keyword search over what this caller may read (F10): `GET /v1/search` on a server, the
   * Instance's own index in local mode (brought up to date with the change feed first). */
  search(request: SearchRequest, hooks?: SearchHooks): Promise<SearchResults>;
  listTokens(filter: { owner?: string; kind?: TokenKind; all?: boolean }): Promise<TokenInfo[]>;
  createToken(request: TokenRequest): Promise<{ token: string; record: TokenInfo }>;
  revokeToken(id: string): Promise<TokenInfo | null>;
  revokeOwnerTokens(owner: string, kind?: TokenKind): Promise<TokenInfo[]>;
  close(): Promise<void>;
}

/** A seshi server, through the HTTP client. */
export class ServerBackend implements Backend {
  readonly mode = "server";

  /** With the org key: the username this backend states (`X-Seshi-User`), resolved now. */
  constructor(
    readonly db: HttpSessionDB,
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
  getSession(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.db.getSession(agent, sessionId, options);
  }
  getTrace(agent: string, sessionId: string, options: TraceOptions = {}) {
    return this.db.getTrace(agent, sessionId, options.hash, options.format, {
      ...(options.owner ? { owner: options.owner } : {}),
    });
  }
  tombstone(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.db.tombstone(agent, sessionId, options);
  }
  setVisibility(
    agent: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ) {
    return this.db.setVisibility(agent, sessionId, visibility, options);
  }
  reviews(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.db.reviews(agent, sessionId, options);
  }
  search(request: SearchRequest): Promise<SearchResults> {
    return this.db.search(request);
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

/** Local mode: the bucket's owner acts on it directly, as its admin would (X3.5). */
export class LocalBackend implements Backend {
  readonly mode = "local";

  constructor(
    readonly instance: Instance,
    readonly owner: string,
  ) {}

  get where(): string {
    return this.instance.storage.url;
  }

  /** The session API for `owner`'s folder, writing (deletes, visibility) as the local user. */
  private db(owner?: string): StoreSessionDB {
    if (owner === undefined || owner === this.owner) return this.instance.localSessions(this.owner);
    return this.instance.sessions({
      owner,
      writer: localWriter(this.owner),
      owner_basis: "verified",
    });
  }

  /** Who token changes are recorded as made by. */
  private principal(): Principal {
    return {
      kind: "local",
      owner: this.owner,
      owner_basis: "verified",
      role: "admin",
      scopes: new Set([
        "sessions:write",
        "sessions:read",
        "sessions:delete",
        "search",
        "sources:admin",
        "tokens:admin",
      ]),
      credential: "static",
      credential_id: "local",
      claims: {},
    };
  }

  async me(): Promise<Identity> {
    return { owner: this.owner, storage: this.instance.storage, kind: "local", role: "admin" };
  }
  listSessions(options: { owner?: string; after?: string; limit?: number }) {
    return this.db(options.owner).listSessions({
      ...(options.after ? { after: options.after } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
  }
  getSession(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.db(options.owner).getSession(agent, sessionId);
  }
  getTrace(agent: string, sessionId: string, options: TraceOptions = {}) {
    return this.db(options.owner).getTrace(agent, sessionId, options.hash, options.format);
  }
  tombstone(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.db(options.owner).tombstone(agent, sessionId);
  }
  setVisibility(
    agent: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ) {
    return this.db(options.owner).setVisibility(agent, sessionId, visibility);
  }
  async reviews(agent: string, sessionId: string, options: OwnerOption = {}) {
    if (!(await this.getSession(agent, sessionId, options))) return null;
    const { archiveId, listReviews } = await import("@seshi/store");
    const owner = options.owner ?? this.owner;
    const records = await listReviews(
      this.instance.store,
      owner,
      archiveId(owner, agent, sessionId),
    );
    return records as ReviewDecision[];
  }
  /** The bucket's keys read everything (X5.6), so nothing is filtered by owner. */
  async search(request: SearchRequest, hooks: SearchHooks = {}): Promise<SearchResults> {
    const search = this.instance.search;
    if (!search) {
      throw new Refused(
        EXIT.config,
        "search_disabled",
        "search is turned off in this config ([search] enabled = false)",
      );
    }
    if (!search.ready()) hooks.building?.();
    await search.catchUp();
    const { LOCAL_VIEWER } = await import("@seshi/search");
    return search.search(LOCAL_VIEWER, request);
  }
  async listTokens(filter: { owner?: string; kind?: TokenKind; all?: boolean }) {
    const { tokenInfo } = await import("@seshi/auth");
    const records = await this.instance.auth.tokens.list(filter);
    return records.map((r) => tokenInfo(r) as unknown as TokenInfo);
  }
  async createToken(request: TokenRequest) {
    const { tokenInfo } = await import("@seshi/auth");
    const { expires_at, ...rest } = request;
    const issued = await this.instance.auth.issue(
      {
        ...rest,
        ...(expires_at !== undefined ? { expires_at: new Date(expires_at) } : {}),
      } as AuthTokenRequest,
      this.principal(),
    );
    return { token: issued.token, record: tokenInfo(issued.record) as unknown as TokenInfo };
  }
  async revokeToken(id: string) {
    const { tokenInfo } = await import("@seshi/auth");
    const record = await this.instance.auth.tokens.revoke(id);
    return record ? (tokenInfo(record) as unknown as TokenInfo) : null;
  }
  async revokeOwnerTokens(owner: string, kind?: TokenKind) {
    const { tokenInfo } = await import("@seshi/auth");
    const records = await this.instance.auth.tokens.revokeOwner(owner, kind);
    return records.map((r) => tokenInfo(r) as unknown as TokenInfo);
  }
  close(): Promise<void> {
    return this.instance.close();
  }
}

export interface OpenBackendOptions {
  /** `--server`: talk to this server, whatever the CLI config says. */
  server?: string;
  /** What the credential is for: `delete` asks for a fresh session token (X5.3). */
  purpose?: Purpose;
}

/** The backend the CLI config names: `--server`, else `[local]`, else `server`. Throws
 * `NotSignedIn` when it names neither, or names a server with no stored credential. */
export async function openBackend(
  ctx: CommandContext,
  account: Account,
  options: OpenBackendOptions = {},
): Promise<Backend> {
  if (options.server === undefined && account.cli.local) {
    const { connect, localOwner } = await import("./connect");
    const connection = await connect({
      cli: account.cli,
      env: account.env,
      home: account.home,
      integrations: await ctx.integrations(),
    });
    return new LocalBackend(connection.instance as Instance, localOwner(account.cli, account.env));
  }
  const server = serverOf(account, options.server);
  if (server === undefined) throw new NotSignedIn(undefined);
  const credential = await accountCredential(account, server, options.purpose ?? "read");
  return new ServerBackend(
    new HttpSessionDB({
      server,
      token: credential.token,
      userAgent: USER_AGENT,
      ...(credential.user ? { user: credential.user } : {}),
    }),
    credential.user,
  );
}
