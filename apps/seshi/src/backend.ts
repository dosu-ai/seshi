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
  building?: () => void;
}

export interface Backend {
  mode: "server" | "local";
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
  reviews(
    agent: string,
    sessionId: string,
    options?: OwnerOption,
  ): Promise<ReviewDecision[] | null>;
  search(request: SearchRequest, hooks?: SearchHooks): Promise<SearchResults>;
  listTokens(filter: { owner?: string; kind?: TokenKind; all?: boolean }): Promise<TokenInfo[]>;
  createToken(request: TokenRequest): Promise<{ token: string; record: TokenInfo }>;
  revokeToken(id: string): Promise<TokenInfo | null>;
  revokeOwnerTokens(owner: string, kind?: TokenKind): Promise<TokenInfo[]>;
  close(): Promise<void>;
}

export class ServerBackend implements Backend {
  readonly mode = "server";

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

export class LocalBackend implements Backend {
  readonly mode = "local";

  constructor(
    readonly instance: Instance,
    readonly owner: string,
  ) {}

  get where(): string {
    return this.instance.storage.url;
  }

  private sessionsAsLocalOwner(owner?: string): StoreSessionDB {
    if (owner === undefined || owner === this.owner) return this.instance.localSessions(this.owner);
    return this.instance.sessions({
      owner,
      writer: localWriter(this.owner),
      owner_basis: "verified",
    });
  }

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
    return this.sessionsAsLocalOwner(options.owner).listSessions({
      ...(options.after ? { after: options.after } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
  }
  getSession(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.sessionsAsLocalOwner(options.owner).getSession(agent, sessionId);
  }
  getTrace(agent: string, sessionId: string, options: TraceOptions = {}) {
    return this.sessionsAsLocalOwner(options.owner).getTrace(
      agent,
      sessionId,
      options.hash,
      options.format,
    );
  }
  tombstone(agent: string, sessionId: string, options: OwnerOption = {}) {
    return this.sessionsAsLocalOwner(options.owner).tombstone(agent, sessionId);
  }
  setVisibility(
    agent: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ) {
    return this.sessionsAsLocalOwner(options.owner).setVisibility(agent, sessionId, visibility);
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

declare const deleteConfirmed: unique symbol;

export interface DeleteConfirmation {
  readonly [deleteConfirmed]: true;
}

export type OpenBackendOptions = { server?: string } & (
  | { purpose?: Exclude<Purpose, "delete"> }
  | { purpose: "delete"; confirmed: DeleteConfirmation }
);

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
