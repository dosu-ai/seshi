/** One client API, two backends, as `@dosu/sessiondb` offered it.
 *
 * `connect({ store, owner, formats })` writes a store directly: the transcript goes through the
 * pipeline here, on the machine that calls, and the bucket is written with that machine's
 * credential. `connect({ server, token })` is the HTTP client (`@seshi/client`), which posts the
 * transcript to a server that runs the same pipeline against the bucket it owns. Either way the
 * calls, their results and what they throw are the same.
 *
 * This is the direct-to-bucket client of today, kept here because it runs the pipeline and
 * `@seshi/client` may depend only on `@seshi/model` (X3.2). Local mode (X3.5, branch 06)
 * replaces it with an Instance built in-process. */

import { type HttpClientOptions, HttpSessionDB } from "@seshi/client";
import { type FormatRegistry, renderTrace } from "@seshi/formats";
import {
  type ChangesPage,
  type Identity,
  type ListSessionsOptions,
  localWriter,
  type OwnerBasis,
  type ReadChangesOptions,
  type RenderFormat,
  type SessionDB,
  type SessionMetadata,
  type SessionsPage,
  type StorageView,
  type StoredTrace,
  type StoreSessionResult,
  type TombstoneReason,
  type Upload,
  VERSION,
  type Writer,
} from "@seshi/model";
import type { RedactionRules } from "@seshi/redact";
import {
  archiveId,
  assertOwner,
  ensureLayout,
  type OpenStoreOptions,
  openStore,
  probe,
  readChanges,
  type Store,
} from "@seshi/store";
import { uploadEnvelope } from "./envelope";
import type { FilterSetting } from "./filter";
import { getSession, getTrace, listSessions, tombstone } from "./ingest";
import type { Limits } from "./limits";
import { Pipeline } from "./pipeline";

export interface StoreClientOptions {
  store: Store;
  owner: string;
  /** The transcript formats to read: the deployment's registry (`apps/seshi` builds it). */
  formats: FormatRegistry;
  /** What `me()` reports as the store's location; derived from the store's URL when omitted. */
  storage?: StorageView;
  /** Identifies this writer in the layout marker (`seshi/0.9.0`). */
  client?: string;
  now?: () => Date;
  /** Redaction added to the built-in rules (`redactionRules`). */
  redaction?: RedactionRules;
  /** Who this client writes as (X5.5); the owner itself in local mode by default. */
  writer?: Writer;
  /** How the owner was established; `verified` by default. */
  owner_basis?: OwnerBasis;
  /** The session filter (`SessionOptions.filter`). */
  filter?: FilterSetting;
  /** Size caps (`SessionOptions.limits`). */
  limits?: Readonly<Limits>;
  /** The pipeline to submit uploads to, shared by every owner's client (the server keeps one);
   * built from the options above when omitted. */
  pipeline?: Pipeline;
}

/** The pipeline over a `Store`, scoped to one owner. */
export class StoreSessionDB implements SessionDB {
  readonly owner: string;
  readonly store: Store;
  private readonly storage: StorageView;
  private readonly client: string;
  private readonly now: () => Date;
  private readonly pipeline: Pipeline;
  readonly writer: Writer;
  private readonly ownerBasis: OwnerBasis;

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
  }

  /** Write the layout marker and this owner's probe, so a wrong bucket or key fails here and
   * not on the first session. */
  async check(): Promise<void> {
    await ensureLayout(this.store, { createdBy: this.client });
    await probe(this.store, this.owner);
  }

  /** The upload as an envelope (source id `upload`, this client's writer as the caller),
   * through the pipeline. */
  async ingest(upload: Upload): Promise<StoreSessionResult> {
    const envelope = uploadEnvelope(
      { ...upload, format: upload.format ?? "jsonl", owner: this.owner },
      {
        caller: {
          kind: this.writer.kind,
          principal: this.writer.principal,
          ...(this.writer.credential_id ? { credential_id: this.writer.credential_id } : {}),
        },
        owner_basis: this.ownerBasis,
        now: this.now,
      },
    );
    return (await this.pipeline.submit(envelope, { onFailure: "throw" })) as StoreSessionResult;
  }

  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null> {
    return getSession(this.store, this.owner, agent, sessionId);
  }

  async getTrace(
    agent: string,
    sessionId: string,
    hash?: string,
    format: RenderFormat = "seshi",
  ): Promise<StoredTrace | null> {
    const metadata = await this.getSession(agent, sessionId);
    if (!metadata || metadata.status === "redacted") return null;
    const wanted = hash ?? metadata.head;
    if (!wanted || !/^[0-9a-f]{64}$/.test(wanted)) return null;
    const archive = archiveId(this.owner, agent, sessionId);
    const trace = await getTrace(this.store, this.owner, archive, wanted);
    return trace === null ? null : renderTrace(trace, format);
  }

  listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    return listSessions(this.store, this.owner, {
      startAfter: options.after,
      limit: options.limit,
    });
  }

  async tombstone(
    agent: string,
    sessionId: string,
    reason: TombstoneReason = "deleted",
  ): Promise<{ removed: number } | null> {
    return tombstone({
      store: this.store,
      owner: this.owner,
      agent,
      session_id: sessionId,
      now: this.now,
      reason,
      writer: this.writer,
    });
  }

  changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    return readChanges(this.store, this.owner, options);
  }

  /** Who this client is, without touching the store. */
  async me(): Promise<Identity> {
    return { owner: this.owner, storage: this.storage };
  }
}

export type ConnectOptions =
  | HttpClientOptions
  | ({
      /** A `Store`, or its URL: `s3://bucket/prefix`, `r2://bucket/prefix`, `file:///path`. */
      store: Store | string;
      owner: string;
      /** The transcript formats to read; see `StoreClientOptions.formats`. */
      formats: FormatRegistry;
      client?: string;
      /** Redaction added to the built-in rules (`redactionRules`). */
      redaction?: RedactionRules;
    } & OpenStoreOptions);

/** A client from its configuration: a server and a token, or a store and an owner. */
export function connect(options: ConnectOptions): SessionDB {
  if ("server" in options) {
    return new HttpSessionDB(options);
  }
  const { store: target, owner, formats, client, redaction, ...open } = options;
  if (typeof target === "string") {
    const { store, storage } = openStore(target, open);
    return new StoreSessionDB({ store, storage, owner, formats, client, redaction });
  }
  return new StoreSessionDB({ store: target, owner, formats, client, redaction });
}
