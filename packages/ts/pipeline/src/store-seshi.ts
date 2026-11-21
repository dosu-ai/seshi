import { type FormatRegistry, renderTrace } from "@seshi/formats";
import {
  type ChangesPage,
  type Claims,
  type Identity,
  type IngestOptions,
  isStub,
  type ListSessionsOptions,
  localWriter,
  type OwnerBasis,
  type ReadChangesOptions,
  type RenderFormat,
  type Seshi,
  type SessionMetadata,
  type SessionsPage,
  type StaleSessionsPage,
  type StorageView,
  type StoredTrace,
  type StoreSessionResult,
  type TombstoneReason,
  type Upload,
  VERSION,
  type Visibility,
  type Writer,
} from "@seshi/model";
import type { RedactionRules } from "@seshi/redact";
import { archiveId, assertOwner, readChanges, type Store } from "@seshi/store";
import { uploadEnvelope } from "./envelope";
import type { FilterSetting } from "./filter";
import { getSession, getTrace, listSessions, setVisibility, tombstone } from "./ingest";
import type { Limits } from "./limits";
import { Pipeline } from "./pipeline";
import { staleSessions } from "./stale";

export interface StoreClientOptions {
  store: Store;
  owner: string;
  formats: FormatRegistry;
  /** What `me()` reports as the store's location; derived from the store's URL when omitted. */
  storage?: StorageView;
  client?: string;
  now?: () => Date;
  /** Redaction added to the built-in rules (`redactionRules`). */
  redaction?: RedactionRules;
  /** Who this client writes as (X5.5); the owner itself in local mode by default. */
  writer?: Writer;
  /** How the owner was established; `verified` by default. */
  owner_basis?: OwnerBasis;
  /** Identity the credential established (an org-key username, an IdP email): merged over
   * what an upload claims, so the data cannot contradict it (X5.5). */
  claims?: Claims;
  /** The visibility of a new session when an upload sets none (the token's default, X5.10). */
  visibility?: Visibility;
  filter?: FilterSetting;
  limits?: Readonly<Limits>;
  /** The pipeline to submit uploads to, shared by every owner's client (the server keeps one);
   * built from the options above when omitted. */
  pipeline?: Pipeline;
}

export class StoreSeshi implements Seshi {
  readonly owner: string;
  readonly store: Store;
  private readonly storage: StorageView;
  private readonly client: string;
  private readonly now: () => Date;
  private readonly pipeline: Pipeline;
  readonly writer: Writer;
  private readonly ownerBasis: OwnerBasis;
  private readonly claims: Claims | undefined;
  private readonly visibility: Visibility | undefined;

  constructor(options: StoreClientOptions) {
    this.owner = assertOwner(options.owner);
    this.store = options.store;
    this.storage = options.storage ?? { url: options.store.url };
    this.client = options.client ?? `seshi/${VERSION}`;
    this.now = options.now ?? (() => new Date());
    this.pipeline =
      options.pipeline ??
      new Pipeline({
        store: options.store,
        formats: options.formats,
        client: this.client,
        now: this.now,
        redaction: options.redaction,
        filter: options.filter,
        limits: options.limits,
      });
    this.writer = options.writer ?? localWriter(this.owner);
    this.ownerBasis = options.owner_basis ?? "verified";
    this.claims = options.claims;
    this.visibility = options.visibility;
  }

  async ingest(upload: Upload, options: IngestOptions = {}): Promise<StoreSessionResult> {
    const visibility = upload.visibility ?? this.visibility;
    const claims = { ...upload.claims, ...this.claims };
    const envelope = uploadEnvelope(
      {
        ...upload,
        encoding: upload.encoding ?? "jsonl",
        owner: this.owner,
        ...(visibility ? { visibility } : {}),
      },
      {
        caller: {
          kind: this.writer.kind,
          principal: this.writer.principal,
          ...(this.writer.credential_id ? { credential_id: this.writer.credential_id } : {}),
        },
        owner_basis: this.ownerBasis,
        claims,
        source_id: this.writer.source_id,
        now: this.now,
      },
    );
    return (await this.pipeline.submit(envelope, {
      onFailure: "throw",
      ...(options.retractSecret !== undefined ? { retractSecret: options.retractSecret } : {}),
    })) as StoreSessionResult;
  }

  /** A session's pointer; null for a stub (F3.4), which has no trace and is not served, as on
   * the HTTP API. */
  async getSession(format: string, sessionId: string): Promise<SessionMetadata | null> {
    const metadata = await getSession(this.store, this.owner, format, sessionId);
    return metadata && isStub(metadata) ? null : metadata;
  }

  async getTrace(
    format: string,
    sessionId: string,
    hash?: string,
    render: RenderFormat = "seshi",
  ): Promise<StoredTrace | null> {
    const metadata = await this.getSession(format, sessionId);
    if (!metadata || metadata.status === "redacted") return null;
    const wanted = hash ?? metadata.head;
    if (!wanted || !metadata.traces.some((ref) => ref.content_hash === wanted)) return null;
    const archive = archiveId(this.owner, format, sessionId);
    const trace = await getTrace(this.store, this.owner, archive, wanted);
    return trace === null ? null : renderTrace(trace, render);
  }

  /** A page of the owner's sessions, stubs (F3.4) left out, as on the HTTP API. */
  async listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    const page = await listSessions(this.store, this.owner, {
      startAfter: options.after,
      limit: options.limit,
    });
    return { ...page, sessions: page.sessions.filter((m) => !isStub(m)) };
  }

  staleSessions(options: { after?: string; limit?: number } = {}): Promise<StaleSessionsPage> {
    return staleSessions(this.store, this.owner, this.pipeline.formats, options);
  }

  async tombstone(
    format: string,
    sessionId: string,
    reason: TombstoneReason = "deleted",
  ): Promise<{ removed: number } | null> {
    return tombstone({
      store: this.store,
      owner: this.owner,
      format,
      session_id: sessionId,
      now: this.now,
      reason,
      writer: this.writer,
    });
  }

  /** Change who may read a session (X5.10); null for one not stored. */
  setVisibility(
    format: string,
    sessionId: string,
    visibility: Visibility,
  ): Promise<SessionMetadata | null> {
    return setVisibility({
      store: this.store,
      owner: this.owner,
      format,
      session_id: sessionId,
      visibility,
      now: this.now,
      writer: this.writer,
    });
  }

  changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    return readChanges(this.store, this.owner, options);
  }

  async me(): Promise<Identity> {
    return { owner: this.owner, storage: this.storage };
  }
}
