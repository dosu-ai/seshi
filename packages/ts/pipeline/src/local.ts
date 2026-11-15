/** One client API, two backends, as `@dosu/sessiondb` offered it.
 *
 * `connect({ store, owner, formats })` writes a store directly: the transcript is redacted and
 * normalized here, on the machine that calls, and the bucket is written with that machine's
 * credential. `connect({ server, token })` is the HTTP client (`@seshi/client`), which posts the
 * transcript to a server that runs the same pipeline against the bucket it owns. Either way the
 * calls, their results and what they throw are the same.
 *
 * This is the direct-to-bucket client of today, kept here because it runs the pipeline and
 * `@seshi/client` may depend only on `@seshi/model` (X3.2). Local mode (X3.5, branch 06)
 * replaces it with an Instance built in-process. */

import { type HttpClientOptions, HttpSessionDB } from "@seshi/client";
import type { FormatRegistry } from "@seshi/formats";
import {
  type ChangesPage,
  type Identity,
  type ListSessionsOptions,
  type ReadChangesOptions,
  type SessionDB,
  type SessionMetadata,
  type SessionsPage,
  type StorageView,
  type StoredTrace,
  type StoreSessionResult,
  type TraceFormat,
  type Upload,
  VERSION,
} from "@seshi/model";
import type { RedactionRules } from "@seshi/redact";
import {
  archiveId,
  assertOwner,
  ensureLayout,
  LAYOUT_KEY,
  layoutFormat,
  type OpenStoreOptions,
  openStore,
  probe,
  readChanges,
  type Store,
} from "@seshi/store";
import { getSession, getTrace, listSessions, tombstone } from "./ingest";
import { storeSession } from "./session";

export interface StoreClientOptions {
  store: Store;
  owner: string;
  /** The transcript formats to read: the deployment's registry (`apps/seshi` builds it). */
  formats: FormatRegistry;
  /** What `me()` reports as the store's location; derived from the store's URL when omitted. */
  storage?: StorageView;
  /** Identifies this writer in the layout marker (`sessiondb-cli/0.2.0`). */
  client?: string;
  now?: () => Date;
  /** Redaction added to the built-in rules (`redactionRules`). */
  redaction?: RedactionRules;
  /** How traces are written: `letta` (trajectory-v1 records, the default) or `otlp` (GenAI
   * spans). A new store takes it; an existing one must hold it, so writing an `otlp` store
   * takes opting in. Reads (`getTrace`, `me`) follow whatever the store holds either way. */
  format?: TraceFormat;
}

/** The pipeline over a `Store`, scoped to one owner. */
export class StoreSessionDB implements SessionDB {
  readonly owner: string;
  readonly store: Store;
  private readonly storage: StorageView;
  private readonly client: string;
  private readonly now: () => Date;
  private readonly redaction: RedactionRules | undefined;
  private readonly format: TraceFormat | undefined;
  private readonly formats: FormatRegistry;
  private resolved: TraceFormat | undefined;

  constructor(options: StoreClientOptions) {
    this.owner = assertOwner(options.owner);
    this.store = options.store;
    this.storage = options.storage ?? { url: options.store.url };
    this.client = options.client ?? `@dosu/sessiondb/${VERSION}`;
    this.now = options.now ?? (() => new Date());
    this.redaction = options.redaction;
    this.format = options.format;
    this.formats = options.formats;
  }

  /** The store's trace format: its marker's, checked against the one configured. Remembered
   * once the store has a marker, since a store never changes format. */
  async traceFormat(): Promise<TraceFormat> {
    if (this.resolved) return this.resolved;
    const format = await layoutFormat(this.store, this.format);
    if (await this.store.stat(LAYOUT_KEY)) this.resolved = format;
    return format;
  }

  /** Write the layout marker and this owner's probe, so a wrong bucket or key fails here and
   * not on the first session. */
  async check(): Promise<void> {
    await ensureLayout(this.store, this.client, this.format ?? "letta");
    await probe(this.store, this.owner);
  }

  ingest(upload: Upload): Promise<StoreSessionResult> {
    return storeSession(
      { ...upload, format: upload.format ?? "jsonl", owner: this.owner },
      {
        store: this.store,
        formats: this.formats,
        client: this.client,
        now: this.now,
        redaction: this.redaction,
        format: this.format,
      },
    );
  }

  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null> {
    return getSession(this.store, this.owner, agent, sessionId);
  }

  async getTrace(agent: string, sessionId: string, hash?: string): Promise<StoredTrace | null> {
    const metadata = await this.getSession(agent, sessionId);
    if (!metadata || metadata.status === "redacted") return null;
    const wanted = hash ?? metadata.head;
    if (!wanted) return null;
    const archive = archiveId(this.owner, agent, sessionId);
    return getTrace(this.store, this.owner, archive, wanted, await this.traceFormat());
  }

  listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    return listSessions(this.store, this.owner, {
      startAfter: options.after,
      limit: options.limit,
    });
  }

  async tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null> {
    return tombstone({
      store: this.store,
      owner: this.owner,
      agent,
      session_id: sessionId,
      now: this.now,
      format: await this.traceFormat(),
    });
  }

  changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    return readChanges(this.store, this.owner, options);
  }

  /** Who this client is, without touching the store; `traceFormat()` reads the store's format. */
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
      /** The trace format; see `StoreClientOptions.format`. */
      format?: TraceFormat;
    } & OpenStoreOptions);

/** A client from its configuration: a server and a token, or a store and an owner. */
export function connect(options: ConnectOptions): SessionDB {
  if ("server" in options) {
    return new HttpSessionDB(options);
  }
  const { store: target, owner, formats, client, redaction, format, ...open } = options;
  if (typeof target === "string") {
    const { store, storage } = openStore(target, open);
    return new StoreSessionDB({ store, storage, owner, formats, client, redaction, format });
  }
  return new StoreSessionDB({ store: target, owner, formats, client, redaction, format });
}
