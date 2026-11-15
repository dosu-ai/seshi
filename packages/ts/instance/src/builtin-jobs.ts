/** The jobs every instance registers (X7). A later branch that adds background work (the span
 * assembler, 09; the search indexer, 12) adds its factory to `BUILTIN_JOBS`, one line; tests
 * and embedders pass more through `InstanceParts.jobs`. */

import type { FormatRegistry } from "@seshi/formats";
import { assemblePending, type Pipeline } from "@seshi/pipeline";
import type { Sources } from "@seshi/sources";
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
  writeHeartbeat,
} from "@seshi/store";
import type { Job, JobRunner } from "./jobs";

/** What a job factory gets: the parts of the instance jobs are built from. */
export interface JobHost {
  readonly store: Store;
  readonly sources: Sources;
  readonly jobs: JobRunner;
  readonly config: {
    readonly worker: { readonly heartbeat_interval: number; readonly assembly_interval: number };
    /** Each source's quiet period applies to its sessions' spans (F4.4). */
    readonly sources: readonly { readonly id: string; readonly quiet_period?: number }[];
    readonly records: {
      readonly dropped_retention: number;
      readonly failed_retention: number;
      readonly health_retention: number;
    };
  };
  readonly roles: readonly string[];
  /** This process, unique per run. */
  readonly process: string;
  /** The stable instance id. */
  readonly id: string;
  readonly version: string;
  readonly startedAt: Date;
  /** The pipeline the span assembler publishes through. */
  readonly pipeline: Pipeline;
  /** The formats whose span adapters assemble sessions. */
  readonly formats: FormatRegistry;
  now(): Date;
}

/** Builds the jobs of one kind for an instance. */
export type JobFactory = (host: JobHost) => Job[];

/** A heartbeat older than this many intervals means the worker stopped (X7.5). */
export const STALE_HEARTBEATS = 3;

/** How often the retention job runs. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a heartbeat written at `at` with `intervalMs` is still fresh at `now`. */
export function heartbeatFresh(at: string, intervalMs: number, now: Date): boolean {
  const written = Date.parse(at);
  return Number.isFinite(written) && now.getTime() - written < STALE_HEARTBEATS * intervalMs;
}

/** `worker/heartbeat.json`, every `worker.heartbeat_interval` (X7.5). Before writing, it reads
 * the heartbeat there: one from another process, written since this one started and still
 * fresh, means a second worker, and it is named in `others` so status sees both whichever wrote
 * last (X7.3). */
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
      for (const { instance, at } of seen) {
        if (instance === host.process) continue;
        // A heartbeat from before this process started is a predecessor's (a restart, a
        // replaced container), not a second worker: only one written since counts.
        if (at <= started || !heartbeatFresh(at, interval, now)) continue;
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

/** Prunes drop and failure records past `[records]` retention, and source health shards past
 * `health_retention` (X6.4, X4.8). */
export function retentionJob(host: JobHost): Job {
  const { records } = host.config;
  return {
    name: "retention",
    kind: "retention",
    placement: "worker",
    intervalMs: RETENTION_INTERVAL_MS,
    async run(signal) {
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

/** One job per polled source (X7, X7.4): a run of its connector on its interval. Its backlog
 * is how long ago its checkpoint was saved. */
export function pollerJobs(host: JobHost): Job[] {
  return host.sources.polled().map(
    (source): Job => ({
      name: `source:${source.id}`,
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
    }),
  );
}

/** A source's quiet period when its config names none (F4.4; config's default for `otlp`). */
export const DEFAULT_QUIET_PERIOD_MS = 10 * 60 * 1000;

/** The span assembler (X7.4, F4.4): publishes sessions whose spans have gone quiet, through
 * the pipeline. Its backlog is the pending markers. */
export function assemblerJob(host: JobHost): Job {
  const quiet = (sourceId: string) =>
    host.config.sources.find((s) => s.id === sourceId)?.quiet_period ?? DEFAULT_QUIET_PERIOD_MS;
  return {
    name: "assembler",
    kind: "assembler",
    placement: "worker",
    intervalMs: host.config.worker.assembly_interval,
    async run(signal) {
      let firstError: string | undefined;
      const report = await assemblePending({
        store: host.store,
        formats: host.formats,
        publish: (session) => host.pipeline.publishAssembled(session),
        quietMs: quiet,
        now: () => host.now(),
        signal,
        onError: (archive, err) => {
          firstError ??= `session ${archive.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`;
        },
      });
      return {
        ...(firstError ? { outcome: "error" as const, error: firstError } : {}),
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

/** The jobs every instance registers, in order. */
export const BUILTIN_JOBS: readonly JobFactory[] = [
  (host) => [heartbeatJob(host)],
  (host) => [retentionJob(host)],
  pollerJobs,
  (host) => [assemblerJob(host)],
];
