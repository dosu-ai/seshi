/** The stored seshi tokens (X5.9): org keys, admin, device and service tokens, each a record
 * `tokens/<id>.json` holding the token's hash, its owner, scopes, default visibility, expiry and
 * revoked flag. Created with If-None-Match and changed with If-Match (X6.5). Records are cached
 * in memory for a short time, so a busy uploader costs no bucket read per call; a revocation in
 * this process takes effect at once, one in another process within the cache's lifetime. */

import type { Claims, OwnerBasis, Visibility } from "@seshi/model";
import {
  createToken,
  listTokens,
  readToken,
  type Store,
  TOKEN_SCHEMA,
  type TokenKind,
  type TokenRecord,
  updateToken,
} from "@seshi/store";
import { hashMatches, isTokenId, mintToken, tokenId } from "./opaque";
import type { Scope } from "./scopes";

/** How long a token record is trusted from memory before it is read again. */
export const TOKEN_CACHE_MS = 30_000;
/** The most records the cache holds; the oldest go first. */
const CACHE_ENTRIES = 10_000;

/** A record as it may be shown: everything but the hash. */
export type TokenInfo = Omit<TokenRecord, "hash">;

export function tokenInfo(record: TokenRecord): TokenInfo {
  const { hash: _hash, ...info } = record;
  return info;
}

export interface IssueOptions {
  kind: TokenKind;
  owner: string;
  scopes: readonly Scope[];
  owner_basis?: OwnerBasis;
  visibility?: Visibility;
  /** Null (the default) for a token that does not expire. */
  expires_at?: Date | null;
  label?: string;
  created_by?: TokenRecord["created_by"];
  machine?: TokenRecord["machine"];
  claims?: Claims;
}

export interface TokenListFilter {
  owner?: string;
  kind?: TokenKind;
  /** Revoked and expired tokens too; live ones only by default. */
  all?: boolean;
}

/** Whether a record still lets its holder in at `now`. */
export function isLive(record: TokenRecord, now: Date): boolean {
  if (record.revoked) return false;
  return record.expires_at === null || Date.parse(record.expires_at) > now.getTime();
}

export class TokenService {
  private readonly cache = new Map<string, { record: TokenRecord | null; at: number }>();
  private readonly now: () => Date;
  private readonly cacheMs: number;

  constructor(
    private readonly store: Store,
    options: { now?: () => Date; cacheMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.cacheMs = options.cacheMs ?? TOKEN_CACHE_MS;
  }

  /** Create a token. The token itself is returned once and never stored. */
  async issue(options: IssueOptions): Promise<{ token: string; record: TokenRecord }> {
    const minted = mintToken();
    const record: TokenRecord = {
      schema: TOKEN_SCHEMA,
      id: minted.id,
      hash: minted.hash,
      kind: options.kind,
      owner: options.owner,
      scopes: [...options.scopes],
      ...(options.owner_basis ? { owner_basis: options.owner_basis } : {}),
      ...(options.visibility ? { visibility: options.visibility } : {}),
      created_at: this.now().toISOString(),
      expires_at: options.expires_at ? options.expires_at.toISOString() : null,
      revoked: false,
      ...(options.label ? { label: options.label } : {}),
      ...(options.created_by ? { created_by: options.created_by } : {}),
      ...(options.machine ? { machine: options.machine } : {}),
      ...(options.claims && Object.keys(options.claims).length > 0
        ? { claims: options.claims }
        : {}),
    };
    await createToken(this.store, record);
    this.remember(record.id, record);
    return { token: minted.token, record };
  }

  /** The live record a token stands for; undefined for a malformed, unknown, wrong, revoked
   * or expired token (no reason is given: the caller answers 401 either way). */
  async verify(token: string): Promise<TokenRecord | undefined> {
    const id = tokenId(token);
    if (id === undefined) return undefined;
    const record = await this.record(id);
    if (record === null || !hashMatches(record.hash, token)) return undefined;
    return isLive(record, this.now()) ? record : undefined;
  }

  /** A record by id, through the cache. */
  private async record(id: string): Promise<TokenRecord | null> {
    const cached = this.cache.get(id);
    if (cached && this.now().getTime() - cached.at < this.cacheMs) return cached.record;
    const read = await readToken(this.store, id);
    const record = read?.value ?? null;
    this.remember(id, record);
    return record;
  }

  private remember(id: string, record: TokenRecord | null): void {
    this.cache.delete(id);
    this.cache.set(id, { record, at: this.now().getTime() });
    while (this.cache.size > CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  /** One record, read from the bucket; null for an unknown id. */
  async get(id: string): Promise<TokenRecord | null> {
    if (!isTokenId(id)) return null;
    const read = await readToken(this.store, id);
    return read?.value ?? null;
  }

  /** Every record that passes `filter`, in id order. There is no index: this reads every token
   * record, which an org has hundreds of, not millions. */
  async list(filter: TokenListFilter = {}): Promise<TokenRecord[]> {
    const now = this.now();
    const out: TokenRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listTokens(this.store, { after, limit: 1000 });
      const records = await Promise.all(page.ids.map((id) => readToken(this.store, id)));
      for (const read of records) {
        const record = read?.value;
        if (!record) continue;
        if (filter.owner !== undefined && record.owner !== filter.owner) continue;
        if (filter.kind !== undefined && record.kind !== filter.kind) continue;
        if (!filter.all && !isLive(record, now)) continue;
        out.push(record);
      }
      if (!page.truncated || page.cursor === undefined) return out;
      after = page.cursor;
    }
  }

  /** Revoke one token (If-Match); the record as it now is, null for an unknown id. Revoking a
   * revoked token changes nothing. */
  async revoke(id: string): Promise<TokenRecord | null> {
    if (!isTokenId(id)) return null;
    const at = this.now().toISOString();
    const record = await updateToken(this.store, id, (current) =>
      current.revoked ? null : { ...current, revoked: true, revoked_at: at },
    );
    this.cache.delete(id);
    return record;
  }

  /** Revoke every live token of `owner` (X5.11), or only those of one kind; the ones revoked.
   * Sessions stay, under the owner's id. */
  async revokeOwner(owner: string, kind?: TokenKind): Promise<TokenRecord[]> {
    const live = await this.list({ owner, ...(kind ? { kind } : {}) });
    const revoked: TokenRecord[] = [];
    for (const record of live) {
      const done = await this.revoke(record.id);
      if (done) revoked.push(done);
    }
    return revoked;
  }
}
