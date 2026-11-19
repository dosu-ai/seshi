import type { FormatRegistry } from "@seshi/formats";
import { type AssembleReport, assemblePending, type Pipeline } from "@seshi/pipeline";
import type { SearchService } from "@seshi/search";
import type { SourceInfo, Sources } from "@seshi/sources";
import {
  type Heartbeat,
  listPending,
  pruneHealth,
  pruneRecords,
  readCheckpoint,
  readHeartbeat,
  type Store,
  sourcesWithHealth,
  sourcesWithRecords,
  sweepTraces,
  writeHeartbeat,
} from "@seshi/store";
import type { Job, JobRunner } from "./jobs";
import { searchIndexJobs } from "./search-job";

export interface JobHost {
  readonly store: Store;
  readonly sources: Sources;
  readonly jobs: JobRunner;
  readonly search?: SearchService;
  readonly config: {
    readonly worker: { readonly heartbeat_interval: number; readonly assembly_interval: number };
    readonly sources: readonly { readonly id: string; readonly quiet_period?: number }[];
    readonly records: {
      readonly dropped_retention: number;
      readonly failed_retention: number;
      readonly health_retention: number;
    };
    readonly search: { readonly interval: number };
  };
  readonly roles: readonly string[];
  readonly process: string;
  readonly id: string;
  readonly version: string;
  readonly startedAt: Date;
  readonly pipeline: Pipeline;
  readonly formats: FormatRegistry;
  now(): Date;
}

export type JobFactory = (host: JobHost) => Job[];

export const STALE_HEARTBEATS = 3;

export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function heartbeatFresh(at: string, intervalMs: number, now: Date): boolean {
  const written = Date.parse(at);
  return Number.isFinite(written) && now.getTime() - written < STALE_HEARTBEATS * intervalMs;
}

export function heartbeatJob(host: JobHost): Job {
  const interval = host.config.worker.heartbeat_interval;
  const others = new Map<string, string>();
  return {
    name: "heartbeat",
    kind: "heartbeat",
    placement: "worker",
    intervalMs: interval,
    async run() {
      const now = host.now();
      const found = await readHeartbeat(host.store);
      const seen: { instance: string; at: string }[] = [];
      if (found) {
        const beat = found.value;
        seen.push({ instance: beat.instance, at: beat.at });
        for (const other of beat.others ?? []) seen.push(other);
      }
      const started = host.startedAt.toISOString();
      const isSecondWorker = (at: string) => at > started && heartbeatFresh(at, interval, now);
      for (const { instance, at } of seen) {
        if (instance === host.process) continue;
        if (!isSecondWorker(at)) continue;
        const known = others.get(instance);
        if (known === undefined || known < at) others.set(instance, at);
      }
      for (const [instance, at] of others) {
        if (!heartbeatFresh(at, interval, now)) others.delete(instance);
      }
      const heartbeat: Omit<Heartbeat, "schema"> = {
        instance: host.process,
        host: host.id,
        version: host.version,
        roles: [...host.roles],
        started_at: host.startedAt.toISOString(),
        at: now.toISOString(),
        interval_ms: interval,
        jobs: host.jobs.snapshot(),
        ...(others.size > 0
          ? { others: [...others].map(([instance, at]) => ({ instance, at })) }
          : {}),
      };
      await writeHeartbeat(host.store, heartbeat);
      return { summary: { other_workers: others.size } };
    },
  };
}

export function retentionJob(host: JobHost): Job {
  return {
    name: "retention",
    kind: "retention",
    placement: "worker",
    intervalMs: RETENTION_INTERVAL_MS,
    async run(signal) {
      // Read at each run: [records] can change on a reload.
      const { records } = host.config;
      const now = () => host.now();
      const summary = { dropped: 0, failed: 0, health: 0 };
      for (const source of await sourcesWithRecords(host.store)) {
        if (signal.aborted) break;
        summary.dropped += await pruneRecords(host.store, "dropped", source, {
          retentionMs: records.dropped_retention,
          now,
        });
        summary.failed += await pruneRecords(host.store, "failed", source, {
          retentionMs: records.failed_retention,
          now,
        });
      }
      const keepDays = Math.max(1, Math.ceil(records.health_retention / DAY_MS));
      for (const source of await sourcesWithHealth(host.store)) {
        if (signal.aborted) break;
        summary.health += await pruneHealth(host.store, source, { keepDays, now });
      }
      return { summary };
    },
  };
}

export const POLLER_PREFIX = "source:";

/** The job that polls one source, named `source:<id>`. */
export function pollerJob(
  host: Pick<JobHost, "sources" | "store" | "now">,
  source: SourceInfo,
): Job {
  return {
    name: `${POLLER_PREFIX}${source.id}`,
    kind: "poller",
    placement: "worker",
    intervalMs: source.interval_ms ?? 5 * 60 * 1000,
    source: source.id,
    async run(signal) {
      const report = await host.sources.run(source.id, { signal });
      return {
        outcome: report.outcome,
        ...(report.error ? { error: report.error } : {}),
        more: report.more,
        summary: {
          submitted: report.submitted,
          ...report.outcomes,
          ...(report.lag_ms !== undefined ? { lag_ms: report.lag_ms } : {}),
        },
      };
    },
    async backlog(): Promise<Record<string, number>> {
      const checkpoint = await readCheckpoint(host.store, source.id);
      if (!checkpoint) return { no_checkpoint: 1 };
      const age = host.now().getTime() - Date.parse(checkpoint.value.updated_at);
      return { checkpoint_age_ms: Math.max(0, age) };
    },
  };
}

export function pollerJobs(host: JobHost): Job[] {
  return host.sources.polled().map((source) => pollerJob(host, source));
}

export const DEFAULT_QUIET_PERIOD_MS = 10 * 60 * 1000;

export type AssembleHost = Pick<JobHost, "store" | "formats" | "pipeline" | "config" | "now">;

export interface AssemblePass {
  report: AssembleReport;
  error?: string;
}

export async function assembleOnce(
  host: AssembleHost,
  signal?: AbortSignal,
): Promise<AssemblePass> {
  const quiet = (sourceId: string) =>
    host.config.sources.find((s) => s.id === sourceId)?.quiet_period ?? DEFAULT_QUIET_PERIOD_MS;
  let error: string | undefined;
  const report = await assemblePending({
    store: host.store,
    formats: host.formats,
    publish: (session) => host.pipeline.publishAssembled(session),
    quietMs: quiet,
    now: () => host.now(),
    ...(signal ? { signal } : {}),
    onError: (archive, err) => {
      error ??= `session ${archive.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`;
    },
  });
  return { report, ...(error ? { error } : {}) };
}

export function assemblerJob(host: JobHost): Job {
  return {
    name: "assembler",
    kind: "assembler",
    placement: "worker",
    intervalMs: host.config.worker.assembly_interval,
    async run(signal) {
      const { report, error } = await assembleOnce(host, signal);
      return {
        ...(error ? { outcome: "error" as const, error } : {}),
        more: report.more,
        summary: {
          published: report.published,
          waiting: report.waiting,
          failed: report.failed,
          retouched: report.retouched,
          errors: report.errors,
          dropped: report.dropped,
          ...report.outcomes,
        },
      };
    },
    async backlog(): Promise<Record<string, number>> {
      let pending = 0;
      let after: string | undefined;
      for (;;) {
        const page = await listPending(host.store, { after, limit: 1000 });
        pending += page.archives.length;
        if (!page.truncated || page.archives.length === 0) return { pending_sessions: pending };
        after = page.cursor;
      }
    },
  };
}

export const SWEEP_INTERVAL_MS = DAY_MS;

export function sweepJob(host: Pick<JobHost, "store" | "now">): Job {
  return {
    name: "sweep",
    kind: "sweep",
    placement: "worker",
    intervalMs: SWEEP_INTERVAL_MS,
    async run(signal) {
      const report = await sweepTraces(host.store, { signal, now: () => host.now() });
      return {
        ...(report.errors > 0
          ? {
              outcome: "error" as const,
              error: `${report.errors} session(s) not swept: ${report.error ?? "unknown"}`,
            }
          : {}),
        summary: {
          sessions: report.sessions,
          deleted: report.deleted,
          young: report.young,
          errors: report.errors,
        },
      };
    },
  };
}

export const BUILTIN_JOBS: readonly JobFactory[] = [
  (host) => [heartbeatJob(host)],
  (host) => [retentionJob(host)],
  pollerJobs,
  (host) => [assemblerJob(host)],
  searchIndexJobs,
  (host) => [sweepJob(host)],
];
