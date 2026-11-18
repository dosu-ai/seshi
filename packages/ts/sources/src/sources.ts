import type { SourceConfig } from "@seshi/config";
import {
  CheckpointLost,
  type Connector,
  type ConnectorContext,
  type ConnectorFailure,
  type ConnectorLogger,
  type Cursor,
  type SubmitOutcome,
} from "@seshi/kit";
import { type Envelope, type SourceKind, UPLOAD_SOURCE } from "@seshi/model";
import {
  countRecords,
  deleteCheckpoint,
  type HealthCounts,
  isPreconditionFailed,
  readCheckpoint,
  readHealth,
  type Store,
  writeCheckpoint,
  writeFailed,
} from "@seshi/store";

export interface Submitter {
  submit(envelope: Envelope, options?: { onFailure?: "throw" | "record" }): Promise<SubmitOutcome>;
  readonly health?: { count(sourceId: string, outcome: "failed"): void };
}

const FAILURE_MESSAGE_LENGTH = 300;

const SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>([
  "upload",
  "hook",
  "otlp",
  "datadog",
  "s3",
  "cursor-cloud",
]);

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const ERROR_LENGTH = 500;

export class SourceError extends Error {
  constructor(
    readonly code: "unknown_source" | "not_polled" | "disabled" | "busy" | "no_rewind",
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface SourceInfo {
  id: string;
  type: string;
  enabled: boolean;
  polled: boolean;
  connector?: string;
  interval_ms?: number;
  note?: string;
}

export interface RunReport {
  source: string;
  started_at: string;
  finished_at: string;
  /** `ok`; `discarded` when another worker moved the checkpoint (X7.3); `error` when the
   * connector or a transient store failure stopped it, with the checkpoint left in place. */
  outcome: "ok" | "discarded" | "error";
  submitted: number;
  outcomes: Record<string, number>;
  checkpoint_saved: boolean;
  more: boolean;
  lag_ms?: number;
  error?: string;
}

export interface SourceStatus extends SourceInfo {
  checkpoint: { updated_at: string; cursor: Cursor } | null;
  dropped: number;
  failed: number;
  health: HealthCounts;
}

export interface RewindReport {
  source: string;
  before: Cursor | null;
  after: Cursor | null;
  applied: boolean;
}

export interface SourcesOptions {
  store: Store;
  pipeline: Submitter;
  sources: readonly SourceConfig[];
  connectors: readonly Connector[];
  fetch?: typeof fetch;
  log?: ConnectorLogger;
  now?: () => Date;
}

const quietLog: ConnectorLogger = { info() {}, warn() {}, error() {} };

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > ERROR_LENGTH ? `${text.slice(0, ERROR_LENGTH - 1)}…` : text;
}

export class Sources {
  private readonly store: Store;
  private readonly pipeline: Submitter;
  private configs: ReadonlyMap<string, SourceConfig>;
  private readonly connectors: ReadonlyMap<string, Connector>;
  private readonly fetchImpl: typeof fetch;
  private readonly log: ConnectorLogger;
  private readonly now: () => Date;
  private readonly running = new Set<string>();

  constructor(options: SourcesOptions) {
    this.store = options.store;
    this.pipeline = options.pipeline;
    this.configs = new Map(options.sources.map((s) => [s.id, s]));
    const connectors = new Map<string, Connector>();
    for (const connector of options.connectors) {
      if (connectors.has(connector.kind)) {
        throw new Error(`two connectors poll sources of type '${connector.kind}'`);
      }
      connectors.set(connector.kind, connector);
    }
    this.connectors = connectors;
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? quietLog;
    this.now = options.now ?? (() => new Date());
  }

  /** Replace the configured sources (a config reload). A run already going keeps the config
   * it started with; checkpoints are the store's and are not touched. */
  update(sources: readonly SourceConfig[]): void {
    this.configs = new Map(sources.map((s) => [s.id, s]));
  }

  /** Every configured source, in config order. */
  list(): SourceInfo[] {
    return [...this.configs.values()].map((config) => this.info(config));
  }

  polled(): SourceInfo[] {
    return this.list().filter((s) => s.polled);
  }

  /** One source; `SourceError` (`unknown_source`) when it is not configured. */
  get(id: string): SourceInfo {
    return this.info(this.config(id));
  }

  private config(id: string): SourceConfig {
    const config = this.configs.get(id);
    if (!config) {
      const known = [...this.configs.keys()];
      throw new SourceError(
        "unknown_source",
        `no source '${id}' in [[sources]]${known.length > 0 ? ` (configured: ${known.join(", ")})` : ""}`,
      );
    }
    return config;
  }

  private info(config: SourceConfig): SourceInfo {
    const connector = this.connectors.get(config.type);
    const interval = (config as { interval?: unknown }).interval;
    const base = {
      id: config.id,
      type: config.type,
      enabled: config.enabled,
      ...(connector ? { connector: connector.kind } : {}),
    };
    if (!connector) {
      return {
        ...base,
        polled: false,
        note:
          config.type === "otlp"
            ? "pushed to POST /otlp/v1/traces, not polled"
            : `no connector for type '${config.type}' in this binary`,
      };
    }
    return {
      ...base,
      polled: config.enabled,
      interval_ms: typeof interval === "number" && interval > 0 ? interval : DEFAULT_INTERVAL_MS,
      ...(config.enabled ? {} : { note: "enabled = false" }),
    };
  }

  private pollable(id: string): { config: SourceConfig; connector: Connector } {
    const config = this.config(id);
    const connector = this.connectors.get(config.type);
    if (!connector) {
      throw new SourceError("not_polled", `source '${id}': ${this.info(config).note}`);
    }
    return { config, connector };
  }

  /** Run a source once: read its checkpoint, run its connector, report. A disabled source is
   * refused unless `force`. Never throws for what the connector does: a failure is the
   * report's `error`. Throws `SourceError` for a source that cannot run. */
  async run(
    id: string,
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<RunReport> {
    const { config, connector } = this.pollable(id);
    if (!config.enabled && !options.force) {
      throw new SourceError("disabled", `source '${id}' is disabled (enabled = false)`);
    }
    if (this.running.has(id)) {
      throw new SourceError("busy", `source '${id}' is already running in this process`);
    }
    this.running.add(id);
    try {
      return await this.runConnector(config, connector, options.signal);
    } finally {
      this.running.delete(id);
    }
  }

  private async runConnector(
    config: SourceConfig,
    connector: Connector,
    outer: AbortSignal | undefined,
  ): Promise<RunReport> {
    const id = config.id;
    const started = this.now();
    const outcomes: Record<string, number> = {};
    let submitted = 0;
    let saved = false;
    let lost = false;
    let checkpointBlockedBy: string | undefined;
    let runEnded = false;
    const assertRunOpen = () => {
      if (runEnded) throw new Error(`the run of source '${id}' has ended`);
    };
    const controller = new AbortController();
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    const report = (outcome: RunReport["outcome"], extra: Partial<RunReport> = {}): RunReport => ({
      source: id,
      started_at: started.toISOString(),
      finished_at: this.now().toISOString(),
      outcome,
      submitted,
      outcomes,
      checkpoint_saved: saved,
      more: false,
      ...extra,
    });

    let current: { cursor: Cursor; etag: string } | null;
    try {
      const read = await readCheckpoint(this.store, id);
      current = read ? { cursor: read.value.cursor, etag: read.etag } : null;
    } catch (err) {
      return report("error", { error: `reading the checkpoint: ${message(err)}` });
    }
    let etag: string | null = current?.etag ?? null;

    const prefix = `source ${id}: `;
    const context: ConnectorContext = {
      source: { id, type: config.type, config: config as unknown as Record<string, unknown> },
      submit: async (envelope: Envelope): Promise<SubmitOutcome> => {
        if (envelope.source_id !== id) {
          throw new Error(
            `a connector for source '${id}' submitted an envelope for '${envelope.source_id}'`,
          );
        }
        assertRunOpen();
        if (lost) throw new CheckpointLost(id);
        submitted++;
        let result: SubmitOutcome;
        try {
          result = await this.pipeline.submit(envelope, { onFailure: "record" });
        } catch (err) {
          checkpointBlockedBy ??= message(err);
          throw err;
        }
        outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
        return result;
      },
      checkpoint: {
        read: () => (current ? structuredClone(current.cursor) : null),
        write: async (cursor: Cursor) => {
          assertRunOpen();
          if (lost) throw new CheckpointLost(id);
          if (checkpointBlockedBy !== undefined) {
            throw new Error(
              `not saving the checkpoint of source '${id}': an envelope failed transiently (${checkpointBlockedBy}); the next run reads it again`,
            );
          }
          try {
            etag = await writeCheckpoint(this.store, id, cursor, etag, this.now);
            saved = true;
          } catch (err) {
            if (!isPreconditionFailed(err)) throw err;
            lost = true;
            throw new CheckpointLost(id);
          }
        },
      },
      fetch: (input, init) =>
        this.fetchImpl(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        }),
      log: {
        info: (line) => this.log.info(prefix + line),
        warn: (line) => this.log.warn(prefix + line),
        error: (line) => this.log.error(prefix + line),
      },
      signal,
      now: this.now,
      fail: async (failure: ConnectorFailure): Promise<string> => {
        assertRunOpen();
        if (lost) throw new CheckpointLost(id);
        const text =
          failure.message.length > FAILURE_MESSAGE_LENGTH
            ? `${failure.message.slice(0, FAILURE_MESSAGE_LENGTH - 1)}…`
            : failure.message;
        let record: string;
        try {
          record = await writeFailed(this.store, {
            at: this.now().toISOString(),
            source: id,
            ...(SOURCE_KINDS.has(config.type) ? { source_kind: config.type as SourceKind } : {}),
            owner: `svc:${id}`,
            ...(failure.session_key !== undefined ? { session_key: failure.session_key } : {}),
            idempotency_key: failure.idempotency_key,
            ...(failure.provenance ? { provenance: failure.provenance } : {}),
            code: failure.code,
            message: text,
          });
        } catch (err) {
          checkpointBlockedBy ??= message(err);
          throw err;
        }
        outcomes.failed = (outcomes.failed ?? 0) + 1;
        this.pipeline.health?.count(id, "failed");
        return record;
      },
    };

    try {
      const result = await connector.run(context);
      if (lost) return report("discarded", { error: new CheckpointLost(id).message });
      if (checkpointBlockedBy !== undefined) {
        return report("error", { error: `an envelope failed transiently: ${checkpointBlockedBy}` });
      }
      return report("ok", {
        more: result?.more === true,
        ...(result?.lag_ms !== undefined ? { lag_ms: result.lag_ms } : {}),
      });
    } catch (err) {
      if (err instanceof CheckpointLost || lost) {
        return report("discarded", { error: new CheckpointLost(id).message });
      }
      return report("error", { error: message(err) });
    } finally {
      runEnded = true;
      controller.abort();
    }
  }

  /** A source's checkpoint, record counts and health over the last `days` days (7 by
   * default). Also answers for `upload`, which has no checkpoint. */
  async status(id: string, options: { days?: number } = {}): Promise<SourceStatus> {
    const info: SourceInfo =
      id === UPLOAD_SOURCE
        ? { id, type: "upload", enabled: true, polled: false, note: "hooks and seshi upload" }
        : this.get(id);
    const days = options.days ?? 7;
    const since = new Date(this.now().getTime() - (days - 1) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const [checkpoint, dropped, failed, health] = await Promise.all([
      id === UPLOAD_SOURCE ? null : readCheckpoint(this.store, id),
      countRecords(this.store, "dropped", id),
      countRecords(this.store, "failed", id),
      readHealth(this.store, id, { since }),
    ]);
    const counts: HealthCounts = {};
    for (const day of health) {
      for (const [outcome, n] of Object.entries(day.counts)) {
        const key = outcome as keyof HealthCounts;
        counts[key] = (counts[key] ?? 0) + (n ?? 0);
      }
    }
    return {
      ...info,
      checkpoint: checkpoint
        ? { updated_at: checkpoint.value.updated_at, cursor: checkpoint.value.cursor }
        : null,
      dropped,
      failed,
      health: counts,
    };
  }

  /** Rewind a source's checkpoint so it reads again (X4.9): to `since`, through its
   * connector's `rewind`, or to the start (the checkpoint is removed). With `dryRun`, only
   * reports. The write is conditional: a run that moves the checkpoint meanwhile wins, and the
   * rewind fails with the store's `PreconditionFailed`. */
  async rewind(
    id: string,
    options: { since?: Date; dryRun?: boolean } = {},
  ): Promise<RewindReport> {
    if (id === UPLOAD_SOURCE) {
      throw new SourceError(
        "not_polled",
        "uploads are not polled, and the server keeps no raw logs to rebuild them from; they are resent from the machines that uploaded them: the uploader resends stale sessions by itself, and seshi capture resend [--all | --session <id>] does it by hand",
      );
    }
    const { config, connector } = this.pollable(id);
    const read = await readCheckpoint(this.store, id);
    const before = read?.value.cursor ?? null;
    let after: Cursor | null = null;
    if (options.since !== undefined) {
      if (!connector.rewind) {
        throw new SourceError(
          "no_rewind",
          `the '${connector.kind}' connector cannot rewind to a time; rewind source '${id}' to the start instead`,
        );
      }
      after = connector.rewind(
        before === null ? null : structuredClone(before),
        options.since,
        config as unknown as Record<string, unknown>,
      );
    }
    if (options.dryRun) return { source: id, before, after, applied: false };
    if (after === null) {
      if (read) await deleteCheckpoint(this.store, id, read.etag);
    } else {
      await writeCheckpoint(this.store, id, after, read?.etag ?? null, this.now);
    }
    return { source: id, before, after, applied: true };
  }
}
