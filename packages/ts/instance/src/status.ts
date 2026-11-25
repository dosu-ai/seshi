import { UPLOAD_SOURCE, VERSION } from "@seshi/model";
import type { SourceStatus } from "@seshi/sources";
import {
  countRecords,
  type Heartbeat,
  type JobRecord,
  readHeartbeat,
  readLayout,
  sourcesWithRecords,
} from "@seshi/store";
import { heartbeatFresh, STALE_HEARTBEATS } from "./builtin-jobs";
import type { Instance } from "./instance";
import type { JobPlacement } from "./jobs";

/** What a server says about a bucket marked serverless (F11.8): it still runs. */
export const SERVERLESS_BUCKET_WARNING =
  "the bucket is marked serverless: laptops may be writing it directly (seshi admin mode server when they have moved to this server)";

export interface WorkerView {
  state: "running" | "stopped" | "never" | "several";
  instance?: string;
  host?: string;
  version?: string;
  roles?: string[];
  started_at?: string;
  last_heartbeat?: string;
  age_ms?: number;
  others: { instance: string; at: string }[];
}

export interface JobStatus {
  name: string;
  kind: string;
  placement: JobPlacement;
  interval_ms: number;
  source?: string;
  last?: JobRecord;
  backlog?: Record<string, number>;
  dropped?: number;
  failed?: number;
}

export interface InstanceStatus {
  at: string;
  deployment: string;
  instance: { id: string; process: string; roles: string[]; version: string };
  worker: WorkerView;
  jobs: JobStatus[];
  sources: SourceStatus[];
  warnings: string[];
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The worker's state from its heartbeat at `now`, and what to warn about. `intervalMs` is the
 * configured heartbeat interval, used when the heartbeat does not record its own. */
export function assessWorker(
  heartbeat: Heartbeat | null,
  now: Date,
  intervalMs: number,
): { worker: WorkerView; warnings: string[] } {
  if (!heartbeat) {
    return {
      worker: { state: "never", others: [] },
      warnings: [
        "no worker has run against this bucket: run one instance with the worker role (seshi serve runs api and worker by default)",
      ],
    };
  }
  const interval = heartbeat.interval_ms ?? intervalMs;
  const age = Math.max(0, now.getTime() - Date.parse(heartbeat.at));
  const others = (heartbeat.others ?? []).filter((o) => heartbeatFresh(o.at, interval, now));
  const view: WorkerView = {
    state: "running",
    instance: heartbeat.instance,
    ...(heartbeat.host ? { host: heartbeat.host } : {}),
    version: heartbeat.version,
    roles: heartbeat.roles,
    started_at: heartbeat.started_at,
    last_heartbeat: heartbeat.at,
    age_ms: age,
    others,
  };
  const warnings: string[] = [];
  if (!heartbeatFresh(heartbeat.at, interval, now)) {
    view.state = "stopped";
    warnings.push(
      `the worker (${heartbeat.instance}) last wrote its heartbeat ${ago(age)} ago, more than ${STALE_HEARTBEATS} intervals: it has stopped, so polling and span assembly are paused until it is restarted`,
    );
  } else if (others.length > 0) {
    view.state = "several";
    warnings.push(
      `${others.length + 1} workers are running (${[heartbeat.instance, ...others.map((o) => o.instance)].join(", ")}): exactly one instance should run the worker role (X7.2); the others waste API calls but corrupt nothing (X7.3)`,
    );
  }
  return { worker: view, warnings };
}

/** Whether a worker is running against this bucket: its heartbeat is fresh (X7.5). */
export async function workerRunning(instance: Instance): Promise<boolean> {
  const found = await readHeartbeat(instance.store);
  const { worker } = assessWorker(
    found?.value ?? null,
    instance.now(),
    instance.config.worker.heartbeat_interval,
  );
  return worker.state === "running" || worker.state === "several";
}

export async function instanceStatus(instance: Instance): Promise<InstanceStatus> {
  const now = instance.now();
  const found = await readHeartbeat(instance.store);
  const heartbeat = found?.value ?? null;
  const { worker, warnings } = assessWorker(
    heartbeat,
    now,
    instance.config.worker.heartbeat_interval,
  );

  const marker = await readLayout(instance.store).catch(() => null);
  if (marker?.mode === "serverless") warnings.push(SERVERLESS_BUCKET_WARNING);

  const configured = instance.config.sources.map((s) => s.id);
  const recorded = await sourcesWithRecords(instance.store);
  const ids = [...new Set([...configured, UPLOAD_SOURCE, ...recorded])];
  const sources: SourceStatus[] = [];
  for (const id of ids) {
    if (id === UPLOAD_SOURCE || configured.includes(id)) {
      sources.push(await instance.sources.status(id));
    } else {
      sources.push(await orphanStatus(instance, id));
    }
  }
  const bySource = new Map(sources.map((s) => [s.id, s]));

  const local = instance.jobs.snapshot();
  const jobs: JobStatus[] = [];
  for (const job of instance.jobs.list()) {
    const last = job.placement === "every" ? local[job.name] : heartbeat?.jobs?.[job.name];
    let backlog: Record<string, number> | undefined;
    if (job.backlog) {
      try {
        backlog = await job.backlog();
      } catch {
        backlog = undefined;
      }
    }
    const source = job.source ? bySource.get(job.source) : undefined;
    jobs.push({
      name: job.name,
      kind: job.kind,
      placement: job.placement,
      interval_ms: job.intervalMs,
      ...(job.source ? { source: job.source } : {}),
      ...(last ? { last } : {}),
      ...(backlog ? { backlog } : {}),
      ...(source ? { dropped: source.dropped, failed: source.failed } : {}),
    });
    if (last?.last_outcome === "error" && last.last_error) {
      warnings.push(`job ${job.name} failed at ${last.last_error.at}: ${last.last_error.message}`);
    }
  }
  for (const source of sources) {
    if (source.failed > 0) {
      warnings.push(
        `source ${source.id} has ${source.failed} failure record(s): seshi sync failed ${source.id}`,
      );
    }
  }

  return {
    at: now.toISOString(),
    deployment: instance.deployment,
    instance: {
      id: instance.id,
      process: instance.process,
      roles: [...instance.roles],
      version: VERSION,
    },
    worker,
    jobs,
    sources,
    warnings,
  };
}

async function orphanStatus(instance: Instance, id: string): Promise<SourceStatus> {
  const [dropped, failed] = await Promise.all([
    countRecords(instance.store, "dropped", id),
    countRecords(instance.store, "failed", id),
  ]);
  return {
    id,
    type: "unknown",
    enabled: false,
    polled: false,
    note: "not in [[sources]] any more",
    checkpoint: null,
    dropped,
    failed,
    health: {},
  };
}
