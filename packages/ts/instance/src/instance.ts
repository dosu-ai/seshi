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
import { SearchService } from "@seshi/search";
import { builtinConnectors, Sources } from "@seshi/sources";
import {
  assertOwner,
  ensureLayout,
  LayoutError,
  openStore,
  probe,
  readLayout,
  type Store,
} from "@seshi/store";
import { assembleOnce, BUILTIN_JOBS, type JobFactory, type JobHost } from "./builtin-jobs";
import { JobRunner } from "./jobs";
import { type Logger, quietLogger } from "./log";
import { type InstanceStatus, instanceStatus } from "./status";

export type Role = (typeof ROLES)[number];

export class InstanceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InstanceError";
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface InstanceParts {
  config: ServerConfig;
  store: Store;
  storage: StorageView;
  formats: FormatRegistry;
  deployment: string;
  /** The connectors this binary has: the integrations' (`connectorsOf`). The built-in S3
   * poller (F6) is added unless one of these polls `s3` already. */
  connectors?: readonly Connector[];
  /** Where the built-in S3 poller reads bucket keys from when a source sets none (`AWS_*`,
   * `S3_*`, `R2_*`); `process.env` by default. */
  env?: Readonly<Record<string, string | undefined>>;
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
  /** Where drop and failure records go; the bucket when omitted. A serverless laptop keeps
   * them in its own state folder (F11.10). */
  records?: Store;
  /** The pipeline writes the layout marker when the bucket has none (true). Serverless
   * laptops never do (F11.11). */
  createLayout?: boolean;
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
  jobs?: readonly JobFactory[];
  /** Session search (F10); built from `[search]` when omitted, none when null. */
  search?: SearchService | null;
  now?: () => Date;
  fetch?: typeof fetch;
  log?: Logger;
  client?: string;
}

export function defaultInstanceId(host: string = hostname()): string {
  const id = host
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return id === "" ? "seshi" : id;
}

export interface SessionIdentity {
  owner: string;
  writer: Writer;
  owner_basis: OwnerBasis;
  claims?: Claims;
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
  readonly assembler: SpanAssembler;
  /** Session search over a local index (F10.3); undefined when `search.enabled` is false. */
  readonly search: SearchService | undefined;
  readonly roles: readonly Role[];
  readonly id: string;
  readonly process: string;
  readonly client: string;
  readonly limits: Readonly<Limits>;
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
      filter: parts.filter ?? ((sourceId) => filterFor(config, sourceId)),
      limits: this.limits,
      reviewer: parts.reviewer,
      assembler: this.assembler,
      health: this.health,
      authorizer: ownershipAuthorizer(),
      visibility: parts.visibility ?? ((sourceId) => visibilityFor(config, sourceId)),
      ...(parts.records ? { records: parts.records } : {}),
      ...(parts.createLayout !== undefined ? { createLayout: parts.createLayout } : {}),
    });

    const given = parts.connectors ?? [];
    const builtin = builtinConnectors({
      formats: this.formats,
      maxBytes: this.limits.max_upload_bytes,
      ...(parts.env ? { env: parts.env } : {}),
    }).filter((c) => !given.some((g) => g.kind === c.kind));
    this.sources = new Sources({
      store: this.store,
      pipeline: this.pipeline,
      sources: config.sources,
      connectors: [...given, ...builtin] as Connector[],
      ...(parts.fetch ? { fetch: parts.fetch } : {}),
      log: this.log,
      now: this.now,
    });

    this.search =
      parts.search === null
        ? undefined
        : (parts.search ??
          (config.search.enabled
            ? new SearchService({
                store: this.store,
                deployment: this.deployment,
                settings: {
                  ...(config.search.path ? { path: config.search.path } : {}),
                  events: config.search.events,
                },
                aliases: this.auth.aliases,
                now: this.now,
                log: this.log,
              })
            : undefined));

    this.jobs = new JobRunner({
      worker: this.roles.includes("worker"),
      now: this.now,
      log: this.log,
    });
    const host: JobHost = {
      store: this.store,
      sources: this.sources,
      jobs: this.jobs,
      ...(this.search ? { search: this.search } : {}),
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

  get api(): boolean {
    return this.roles.includes("api");
  }

  get worker(): boolean {
    return this.roles.includes("worker");
  }

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
    this.search?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.health.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  status(): Promise<InstanceStatus> {
    return instanceStatus(this);
  }

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

  /** The session API as `owner` itself, through the upload route. `basis` is how the owner
   * was established: `claimed` in serverless mode, where nothing seshi controls checked the
   * name (F11.4). */
  localSessions(owner: string, basis: OwnerBasis = "verified"): StoreSessionDB {
    assertOwner(owner);
    return this.sessions({ owner, writer: localWriter(owner), owner_basis: basis });
  }

  source(id: string): SourceConfig | undefined {
    return this.config.sources.find((s) => s.id === id);
  }

  async prune(): Promise<PruneRun> {
    const record = await this.jobs.runNow("retention");
    const summary = record.last_summary ?? {};
    return {
      dropped: summary.dropped ?? 0,
      failed: summary.failed ?? 0,
      health: summary.health ?? 0,
      ...(record.last_outcome === "error" && record.last_error
        ? { error: record.last_error.message }
        : {}),
    };
  }

  /** Run the span assembler now, whatever this instance's roles: `seshi sync assemble`, the
   * one-shot a deployment with no worker runs from cron (X7.1), as the `assembler` job does
   * on the worker. Passes run until nothing more is waiting, a pass hits an error (its
   * session keeps its marker), a pass gets nowhere, or `maxPasses` (100) ran. Counts are
   * summed over the passes; `waiting` is the last pass's. */
  async assemble(options: { signal?: AbortSignal; maxPasses?: number } = {}): Promise<AssembleRun> {
    const maxPasses = options.maxPasses ?? 100;
    const run: AssembleRun = {
      passes: 0,
      published: 0,
      waiting: 0,
      failed: 0,
      retouched: 0,
      errors: 0,
      dropped: 0,
      outcomes: {},
      more: false,
    };
    for (;;) {
      const { report, error } = await assembleOnce(this, options.signal);
      run.passes += 1;
      run.published += report.published;
      run.waiting = report.waiting;
      run.failed += report.failed;
      run.retouched += report.retouched;
      run.errors += report.errors;
      run.dropped += report.dropped;
      for (const [status, n] of Object.entries(report.outcomes)) {
        run.outcomes[status] = (run.outcomes[status] ?? 0) + n;
      }
      run.more = report.more;
      if (error !== undefined) run.error ??= error;
      const progress = report.published + report.failed + report.dropped + report.retouched;
      if (
        !report.more ||
        error !== undefined ||
        progress === 0 ||
        options.signal?.aborted ||
        run.passes >= maxPasses
      ) {
        return run;
      }
    }
  }
}

export interface PruneRun {
  dropped: number;
  failed: number;
  health: number;
  error?: string;
}

export interface AssembleRun {
  passes: number;
  published: number;
  waiting: number;
  failed: number;
  retouched: number;
  errors: number;
  dropped: number;
  outcomes: Record<string, number>;
  more: boolean;
  error?: string;
}

export interface BuildOptions
  extends Omit<InstanceParts, "config" | "store" | "storage" | "deployment" | "connectors"> {
  store?: { store: Store; storage: StorageView };
  /** Env the bucket client falls back to for credentials (`AWS_*`, `S3_*`, `R2_*`) when
   * `[store]` sets none; `process.env` by default. */
  env?: Record<string, string | undefined>;
  integrations?: readonly Integration[];
  connectors?: readonly Connector[];
  /** Owners whose folders are written and read back once, so a bucket key that cannot write
   * fails now and not on the first session; the static tokens' owners by default. */
  probe?: readonly string[];
  newDeploymentId?: () => string;
  /** Write the layout marker when the bucket has none (true by default). Read-only commands
   * pass false: they refuse a bucket no seshi server has used rather than claim it, so a
   * mistyped `store.url` is not turned into a new deployment by a status check. */
  initialize?: boolean;
  /** Record `store.org` in a marker that names none (true). A serverless laptop never writes
   * the marker (F11.11): it checks the org, and leaves an unnamed one alone. */
  claimOrg?: boolean;
}

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
      ...(options.initialize === false ? { create: false } : {}),
      ...(options.claimOrg === false ? { claimOrg: false } : {}),
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
    integrations,
    connectors,
    probe: probed,
    newDeploymentId: _newDeploymentId,
    initialize: _initialize,
    claimOrg: _claimOrg,
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
