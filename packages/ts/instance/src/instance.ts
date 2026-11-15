/** An Instance: everything one deployment runs, built from one config (X1.2). The store, auth,
 * the pipeline, source health, the connector scheduler and the job runner all hang off it, and
 * nothing is kept at module level, so tests build as many as they like in parallel, and a later
 * mode can host several orgs in one process.
 *
 * `buildInstance` does the I/O (open the bucket, read redaction packs, check the layout marker,
 * X1.4); `new Instance(parts)` assembles the rest without any, so tests that already hold a
 * store build one synchronously. The HTTP API (`@seshi/api`) serves an Instance; `seshi serve`,
 * the admin and sync commands, and local mode (X3.5) each build one. */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { Auth, AuthSettingsError, authSettings, ownershipAuthorizer } from "@seshi/auth";
import {
  filterFor,
  type ROLES,
  type ServerConfig,
  type SourceConfig,
  visibilityFor,
} from "@seshi/config";
import type { FormatRegistry } from "@seshi/formats";
import { type Connector, connectorsOf, type Integration } from "@seshi/kit";
import {
  type Claims,
  type LayoutMarker,
  localWriter,
  type OwnerBasis,
  type StorageView,
  VERSION,
  type Visibility,
  type Writer,
} from "@seshi/model";
import {
  type FilterSetting,
  type HealthCounters,
  type Limits,
  Pipeline,
  type Reviewer,
  type SpanAssembler,
  SpanStore,
  StoreHealthCounters,
  StoreSessionDB,
  type VisibilitySetting,
} from "@seshi/pipeline";
import {
  compileRuleSet,
  loadPacks,
  type RedactionRules,
  RulePackError,
  type RuleSet,
} from "@seshi/redact";
import { ReviewSetupError, reviewerFromConfig } from "@seshi/review";
import { Sources } from "@seshi/sources";
import {
  assertOwner,
  ensureLayout,
  LayoutError,
  openStore,
  probe,
  readLayout,
  type Store,
} from "@seshi/store";
import { BUILTIN_JOBS, type JobFactory, type JobHost } from "./builtin-jobs";
import { JobRunner } from "./jobs";
import { type Logger, quietLogger } from "./log";
import { type InstanceStatus, instanceStatus } from "./status";

export type Role = (typeof ROLES)[number];

/** Something stops the instance from being built: a setting, the bucket, the marker. The
 * message says which and is meant for the operator. */
export class InstanceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InstanceError";
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Everything an Instance is assembled from: what `buildInstance` opened and read, and
 * overrides for what is otherwise derived from `config` (tests, embedders). */
export interface InstanceParts {
  config: ServerConfig;
  store: Store;
  storage: StorageView;
  /** The transcript formats this binary reads: `apps/seshi` builds the registry from its
   * integrations (X3.11). */
  formats: FormatRegistry;
  /** The deployment the bucket belongs to (the layout marker's `deployment_id`, X1.4). */
  deployment: string;
  /** The connectors this binary has: the integrations' (`connectorsOf`), and later the
   * built-in S3 poller. */
  connectors?: readonly Connector[];
  /** The redaction rule set: the built-in pack and the operator's packs (F2.1).
   * `buildInstance` reads `redaction.packs` into it; the built-in pack alone when omitted. */
  redaction?: RedactionRules;
  /** Model review (F3); `buildInstance` builds it from `[review]` (none when there are no
   * policies). `new Instance` takes it as given. */
  reviewer?: Reviewer;
  /** Where span batches go (X4.2, 09); the span store in the bucket (`SpanStore`) when
   * omitted. The `assembler` job publishes what it holds. */
  assembler?: SpanAssembler;
  /** Identity and access; built from `[auth]` when omitted. */
  auth?: Auth;
  /** Source health; this instance's own shard in the bucket when omitted. */
  health?: HealthCounters;
  /** The session filter; `[filter]` with each source's overrides when omitted. */
  filter?: FilterSetting;
  /** Size caps; `[limits]` when omitted. */
  limits?: Readonly<Limits>;
  /** A new session's visibility fallback; each source's, then `default_visibility`, when
   * omitted. */
  visibility?: VisibilitySetting;
  /** What this instance runs; `server.roles` when omitted. */
  roles?: readonly Role[];
  /** The stable instance id: health shards and the heartbeat's `host`. `server.instance_id`,
   * else the host name. */
  id?: string;
  /** Jobs beyond the built-in ones. */
  jobs?: readonly JobFactory[];
  now?: () => Date;
  /** How connectors reach their APIs and auth reaches the IdP. */
  fetch?: typeof fetch;
  log?: Logger;
  /** Identifies this binary in layout markers (`seshi/0.9.0`). */
  client?: string;
}

/** A host name as an instance id: letters, digits, `_` and `-`, up to 64. */
export function defaultInstanceId(host: string = hostname()): string {
  const id = host
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return id === "" ? "seshi" : id;
}

/** A session writer's identity for `Instance.sessions`. */
export interface SessionIdentity {
  owner: string;
  writer: Writer;
  owner_basis: OwnerBasis;
  claims?: Claims;
  /** The default visibility of what it writes (a token's, X5.10). */
  visibility?: Visibility;
}

export class Instance {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly storage: StorageView;
  readonly formats: FormatRegistry;
  readonly deployment: string;
  readonly auth: Auth;
  readonly pipeline: Pipeline;
  readonly health: HealthCounters;
  readonly sources: Sources;
  readonly jobs: JobRunner;
  /** Where span batches go: the span store, unless the parts named another. */
  readonly assembler: SpanAssembler;
  readonly roles: readonly Role[];
  /** The stable instance id. */
  readonly id: string;
  /** This process: unique per run (`<id>-<random>`), so the heartbeat tells two workers on
   * one host apart. */
  readonly process: string;
  readonly client: string;
  readonly limits: Readonly<Limits>;
  /** The rule set every write is redacted with (F2): what `GET /v1/redaction/rules` serves
   * and `seshi redact backfill` applies. */
  readonly redaction: RuleSet;
  readonly log: Logger;
  readonly startedAt: Date;
  readonly now: () => Date;
  private closed = false;

  constructor(parts: InstanceParts) {
    const { config } = parts;
    this.config = config;
    this.store = parts.store;
    this.storage = parts.storage;
    this.formats = parts.formats;
    this.deployment = parts.deployment;
    this.now = parts.now ?? (() => new Date());
    this.startedAt = this.now();
    this.log = parts.log ?? quietLogger;
    this.client = parts.client ?? `seshi/${VERSION}`;
    this.roles = [...(parts.roles ?? config.server.roles)];
    this.id = parts.id ?? config.server.instance_id ?? defaultInstanceId();
    this.process = `${this.id}-${randomBytes(4).toString("hex")}`;
    this.limits = parts.limits ?? config.limits;
    this.redaction = parts.redaction ?? compileRuleSet();

    if (parts.auth) {
      this.auth = parts.auth;
    } else {
      let settings: ReturnType<typeof authSettings>;
      try {
        settings = authSettings(config);
      } catch (err) {
        if (err instanceof AuthSettingsError) throw new InstanceError(err.message);
        throw err;
      }
      this.auth = new Auth(settings, {
        store: this.store,
        deployment: this.deployment,
        sources: config.sources.map((s) => s.id),
        now: this.now,
        ...(parts.fetch ? { fetch: parts.fetch } : {}),
      });
    }

    this.health =
      parts.health ??
      new StoreHealthCounters(this.store, {
        instance: this.id,
        now: this.now,
        onError: (err) => this.log.warn(`source health not recorded: ${message(err)}`),
      });

    this.assembler = parts.assembler ?? new SpanStore({ store: this.store, now: this.now });

    this.pipeline = new Pipeline({
      store: this.store,
      formats: this.formats,
      client: this.client,
      now: this.now,
      redaction: this.redaction,
      // Each source's own rules over [filter] (X4.10); uploads get [filter].
      filter: parts.filter ?? ((sourceId) => filterFor(config, sourceId)),
      limits: this.limits,
      reviewer: parts.reviewer,
      assembler: this.assembler,
      health: this.health,
      authorizer: ownershipAuthorizer(),
      // The request, then the token's default, then the source's, then default_visibility.
      visibility: parts.visibility ?? ((sourceId) => visibilityFor(config, sourceId)),
    });

    this.sources = new Sources({
      store: this.store,
      pipeline: this.pipeline,
      sources: config.sources,
      connectors: parts.connectors ?? [],
      ...(parts.fetch ? { fetch: parts.fetch } : {}),
      log: this.log,
      now: this.now,
    });

    this.jobs = new JobRunner({
      worker: this.roles.includes("worker"),
      now: this.now,
      log: this.log,
    });
    const host: JobHost = {
      store: this.store,
      sources: this.sources,
      jobs: this.jobs,
      config,
      roles: this.roles,
      process: this.process,
      id: this.id,
      version: VERSION,
      startedAt: this.startedAt,
      pipeline: this.pipeline,
      formats: this.formats,
      now: this.now,
    };
    for (const factory of [...BUILTIN_JOBS, ...(parts.jobs ?? [])]) {
      for (const job of factory(host)) this.jobs.register(job);
    }
  }

  /** Whether this instance serves the HTTP API. */
  get api(): boolean {
    return this.roles.includes("api");
  }

  /** Whether this instance is the worker (X7.2). */
  get worker(): boolean {
    return this.roles.includes("worker");
  }

  /** Start the background jobs this instance's roles call for (X7.1). */
  start(): void {
    if (this.closed) throw new Error("this instance is closed");
    this.jobs.start();
  }

  /** Stop the jobs and write what source health counted, each bounded by `timeoutMs`. The
   * instance is not used after this. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.jobs.stop(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.health.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The workers, jobs and sources as status shows them (X7.5). */
  status(): Promise<InstanceStatus> {
    return instanceStatus(this);
  }

  /** The session API over this instance's pipeline, writing as `identity` (the HTTP routes
   * build one per principal). */
  sessions(identity: SessionIdentity): StoreSessionDB {
    return new StoreSessionDB({
      store: this.store,
      storage: this.storage,
      owner: identity.owner,
      formats: this.formats,
      client: this.client,
      now: this.now,
      pipeline: this.pipeline,
      writer: identity.writer,
      owner_basis: identity.owner_basis,
      ...(identity.claims ? { claims: identity.claims } : {}),
      ...(identity.visibility ? { visibility: identity.visibility } : {}),
    });
  }

  /** Local mode (X3.5): the session API for the one person who owns the bucket, writing as
   * themselves (`local` writer, verified owner). */
  localSessions(owner: string): StoreSessionDB {
    assertOwner(owner);
    return this.sessions({ owner, writer: localWriter(owner), owner_basis: "verified" });
  }

  /** The source config for `id`, if configured. */
  source(id: string): SourceConfig | undefined {
    return this.config.sources.find((s) => s.id === id);
  }
}

/** How `buildInstance` opens and reads what an Instance needs. */
export interface BuildOptions
  extends Omit<InstanceParts, "config" | "store" | "storage" | "deployment" | "connectors"> {
  /** An open store, instead of opening `store.url` (tests, embedders). */
  store?: { store: Store; storage: StorageView };
  /** Env the bucket client falls back to for credentials (`AWS_*`, `S3_*`, `R2_*`) when
   * `[store]` sets none; `process.env` by default. */
  env?: Record<string, string | undefined>;
  /** The integrations this binary was built with: their connectors are scheduled. */
  integrations?: readonly Integration[];
  /** Connectors beyond the integrations' (tests, built-in pollers). */
  connectors?: readonly Connector[];
  /** Owners whose folders are written and read back once, so a bucket key that cannot write
   * fails now and not on the first session; the static tokens' owners by default. */
  probe?: readonly string[];
  /** For tests: the deployment id a new prefix gets. */
  newDeploymentId?: () => string;
  /** Write the layout marker when the bucket has none (true by default). Read-only commands
   * pass false: they refuse a bucket no seshi server has used rather than claim it, so a
   * mistyped `store.url` is not turned into a new deployment by a status check. */
  initialize?: boolean;
}

/** The bucket options `[store]` gives, secrets revealed. */
export function storeOptions(config: ServerConfig): {
  region?: string;
  endpoint?: string;
  accountId?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
} {
  const { store } = config;
  return {
    ...(store.region ? { region: store.region } : {}),
    ...(store.endpoint ? { endpoint: store.endpoint } : {}),
    ...(store.account_id ? { accountId: store.account_id } : {}),
    ...(store.credentials
      ? {
          credentials: {
            accessKeyId: store.credentials.access_key_id.reveal(),
            secretAccessKey: store.credentials.secret_access_key.reveal(),
            ...(store.credentials.session_token
              ? { sessionToken: store.credentials.session_token.reveal() }
              : {}),
          },
        }
      : {}),
  };
}

/** The rule set `redaction.packs` names (F2.1): each file read and validated, TOML packs as
 * they are and JSON rule files merged into the `legacy` pack, then compiled on top of the
 * built-in pack with every operator rule checked against its own test strings. A problem names
 * its file. With no packs, the built-in pack alone. */
export async function readRedactionPacks(paths: readonly string[]): Promise<RuleSet> {
  const files: { path: string; text: string }[] = [];
  for (const path of paths) {
    try {
      files.push({ path, text: await Bun.file(path).text() });
    } catch (err) {
      throw new InstanceError(`cannot read redaction pack ${path}: ${message(err)}`);
    }
  }
  try {
    const loaded = loadPacks(files);
    return compileRuleSet({
      packs: loaded.map((l) => l.pack),
      sources: Object.fromEntries(loaded.map((l) => [l.pack.id, l.source])),
      runTests: true,
    });
  } catch (err) {
    if (err instanceof RulePackError) throw new InstanceError(err.message, { cause: err });
    throw err;
  }
}

/** The reviewer `[review]` describes (F3), its prompt files read; none without policies, so
 * nothing is sent anywhere. A policy that cannot run stops the build. */
async function buildReviewer(
  config: ServerConfig,
  options: BuildOptions,
): Promise<Reviewer | undefined> {
  try {
    return await reviewerFromConfig(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      log: options.log ?? quietLogger,
    });
  } catch (err) {
    if (err instanceof ReviewSetupError) throw new InstanceError(err.message, { cause: err });
    throw err;
  }
}

/** Build an Instance from a loaded config: open the bucket, read the redaction packs, check
 * the layout marker (X1.4: the bucket must be this deployment's and org's, and not a sessiondb
 * prefix), and probe the static tokens' owners. Every failure is an `InstanceError` saying
 * what to fix. */
export async function buildInstance(
  config: ServerConfig,
  options: BuildOptions,
): Promise<Instance> {
  const url = config.store.url;
  let opened: { store: Store; storage: StorageView };
  if (options.store) {
    opened = options.store;
  } else {
    try {
      opened = openStore(url, {
        ...storeOptions(config),
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (err) {
      throw new InstanceError(message(err), { cause: err });
    }
  }
  const redaction = options.redaction ?? (await readRedactionPacks(config.redaction.packs));
  const reviewer = options.reviewer ?? (await buildReviewer(config, options));
  const client = options.client ?? `seshi/${VERSION}`;

  if (options.initialize === false) {
    let existing: LayoutMarker | null;
    try {
      existing = await readLayout(opened.store);
    } catch (err) {
      throw new InstanceError(`cannot read ${url}: ${message(err)}`, { cause: err });
    }
    if (existing === null) {
      throw new InstanceError(
        `no seshi deployment at ${url}: check store.url, or start seshi serve (or seshi admin init) against it first`,
      );
    }
  }

  let marker: LayoutMarker;
  try {
    marker = await ensureLayout(opened.store, {
      createdBy: client,
      deploymentId: config.store.deployment_id,
      org: config.store.org,
      ...(options.now ? { now: options.now } : {}),
      ...(options.newDeploymentId ? { newDeploymentId: options.newDeploymentId } : {}),
    });
  } catch (err) {
    if (err instanceof LayoutError) {
      throw new InstanceError(`cannot use ${url}: ${message(err)}`, { cause: err });
    }
    throw new InstanceError(`cannot write to ${url}: ${message(err)}`, { cause: err });
  }

  const {
    store: _store,
    env: _env,
    integrations,
    connectors,
    probe: probed,
    newDeploymentId: _newDeploymentId,
    initialize: _initialize,
    ...rest
  } = options;
  let instanceConnectors: Connector[];
  try {
    instanceConnectors = [...connectorsOf(integrations ?? []), ...(connectors ?? [])];
  } catch (err) {
    throw new InstanceError(message(err), { cause: err });
  }
  const instance = new Instance({
    ...rest,
    config,
    store: opened.store,
    storage: opened.storage,
    deployment: marker.deployment_id,
    connectors: instanceConnectors,
    redaction,
    ...(reviewer ? { reviewer } : {}),
    client,
  });

  for (const owner of probed ?? Object.keys(config.auth.tokens)) {
    try {
      await probe(opened.store, owner);
    } catch (err) {
      throw new InstanceError(`cannot write to ${url}: ${message(err)}`, { cause: err });
    }
  }
  return instance;
}
