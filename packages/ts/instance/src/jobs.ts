/** Background jobs (X7): one job runner per instance, no queue service (X7.1). A job is a
 * named piece of work that runs on an interval; the runner runs the jobs this instance's roles
 * call for, keeps each one's last run, last error and counts in memory, and the heartbeat
 * writes them to the bucket so `seshi workers status` and `GET /v1/admin/jobs` can show them
 * from anywhere (X7.5).
 *
 * Jobs find their own work (X7.4): a poller from its checkpoint, the span assembler from its
 * pending markers, the indexer from its local cursor. Nothing here coordinates workers: there
 * is one in the first version (X7.2), and a second by mistake is harmless (X7.3). */

import type { JobRecord } from "@seshi/store";
import type { Logger } from "./log";

/** Where a job runs: on the one worker instance, or on every instance (the search indexer
 * keeps a local index on each, X7). */
export type JobPlacement = "worker" | "every";

/** What one run of a job says about itself. */
export interface JobResult {
  /** `ok` unless said otherwise; `discarded` when another worker won a race (X7.3). */
  outcome?: "ok" | "discarded" | "error";
  /** The run failed without throwing (a poller reports its connector's error this way). */
  error?: string;
  /** More is waiting now: run again without waiting for the interval. */
  more?: boolean;
  /** Counts worth showing in status (envelopes submitted, sessions stored, records pruned). */
  summary?: Record<string, number>;
}

/** One kind of background work. */
export interface Job {
  /** Unique within an instance: `heartbeat`, `retention`, `source:<id>`, `assembler`. */
  readonly name: string;
  /** What kind of job it is: `heartbeat`, `retention`, `poller`, `assembler`, `indexer`. */
  readonly kind: string;
  readonly placement: JobPlacement;
  /** How long to wait after a run ends before the next starts. */
  readonly intervalMs: number;
  /** The source a poller polls. */
  readonly source?: string;
  /** One run. It should stop early when `signal` aborts. A throw is the run's error. */
  run(signal: AbortSignal): Promise<JobResult | undefined>;
  /** What is waiting (pending markers, checkpoint age), computed when status asks; on any
   * instance, not only the worker. */
  backlog?(): Promise<Record<string, number> | undefined>;
}

/** How soon a job whose run said `more` runs again. */
const MORE_DELAY_MS = 10;

/** The first retry after a failed run; each further failure in a row doubles it, up to the
 * job's interval (X4.8: a transient failure retries with backoff). */
export const RETRY_BASE_MS = 5_000;

const ERROR_LENGTH = 500;

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > ERROR_LENGTH ? `${text.slice(0, ERROR_LENGTH - 1)}…` : text;
}

export interface JobRunnerOptions {
  /** Whether this instance runs the worker role: jobs placed on `worker` run only then. */
  worker: boolean;
  now?: () => Date;
  log?: Logger;
  /** The first retry after a failed run (`RETRY_BASE_MS`); tests shorten it. */
  retryBaseMs?: number;
}

/** Runs an instance's jobs. `register` every job the instance knows (status lists them all,
 * on any role); `start` runs the ones this instance's roles call for; `stop` ends them. */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly records = new Map<string, JobRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Map<string, Promise<JobRecord>>();
  private controller = new AbortController();
  private started = false;
  private readonly worker: boolean;
  private readonly now: () => Date;
  private readonly log: Logger | undefined;
  private readonly retryBaseMs: number;
  /** Failed runs in a row, by job: how far the next retry backs off. */
  private readonly failing = new Map<string, number>();

  constructor(options: JobRunnerOptions) {
    this.worker = options.worker;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  }

  /** How long after a run ends the next starts: at once when it said more is waiting; after
   * a failure, `retryBaseMs` doubled per failure in a row, never past the interval; otherwise
   * the interval. */
  delayAfter(job: Job, record: JobRecord): number {
    if (record.last_outcome === "error") {
      const n = this.failing.get(job.name) ?? 1;
      return Math.min(job.intervalMs, this.retryBaseMs * 2 ** Math.min(n - 1, 30));
    }
    if (record.last_outcome === "ok" && this.moreWaiting.has(job.name)) return MORE_DELAY_MS;
    return job.intervalMs;
  }

  /** Add a job. Names are unique. A job registered after `start` is scheduled at once if this
   * instance runs it. */
  register(job: Job): void {
    if (this.jobs.has(job.name)) throw new Error(`a job named '${job.name}' is already registered`);
    if (!(job.intervalMs > 0)) throw new Error(`job '${job.name}' needs an interval above 0`);
    this.jobs.set(job.name, job);
    if (this.started && this.runsHere(job)) this.schedule(job, 0);
  }

  /** Every registered job, in registration order. */
  list(): Job[] {
    return [...this.jobs.values()];
  }

  get(name: string): Job | undefined {
    return this.jobs.get(name);
  }

  /** Whether this instance runs `job` when started. */
  runsHere(job: Job): boolean {
    return job.placement === "every" || this.worker;
  }

  /** The record of every job that has run in this process, by name. */
  snapshot(): Record<string, JobRecord> {
    return Object.fromEntries([...this.records].map(([name, r]) => [name, structuredClone(r)]));
  }

  get running(): boolean {
    return this.started;
  }

  /** Schedule every job this instance runs, each starting now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.controller = new AbortController();
    for (const job of this.jobs.values()) if (this.runsHere(job)) this.schedule(job, 0);
  }

  /** Stop scheduling, abort running jobs, and wait up to `timeoutMs` for them to end. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.controller.abort();
    const running = [...this.inflight.values()];
    if (running.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(running),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Run one job now, whatever this instance's roles, and return its record. When it is
   * already running, waits for that run instead of starting another. */
  runNow(name: string): Promise<JobRecord> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`no job named '${name}'`);
    return this.execute(job);
  }

  private schedule(job: Job, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(job.name);
      if (!this.started) return;
      void this.execute(job).then((record) => {
        if (!this.started) return;
        this.schedule(job, this.delayAfter(job, record));
      });
    }, delayMs);
    // A timer alone never keeps the process alive: the server or the command does.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(job.name, timer);
  }

  private readonly moreWaiting = new Set<string>();

  private execute(job: Job): Promise<JobRecord> {
    const current = this.inflight.get(job.name);
    if (current) return current;
    const run = this.runOnce(job).finally(() => this.inflight.delete(job.name));
    this.inflight.set(job.name, run);
    return run;
  }

  private async runOnce(job: Job): Promise<JobRecord> {
    const record: JobRecord = this.records.get(job.name) ?? { runs: 0, failures: 0 };
    record.last_started = this.now().toISOString();
    this.records.set(job.name, record);
    let result: JobResult | undefined;
    let error: string | undefined;
    try {
      result = await job.run(this.controller.signal);
      if (result?.outcome === "error") error = result.error ?? "the run failed";
    } catch (err) {
      error = message(err);
    }
    const finished = this.now().toISOString();
    record.runs += 1;
    record.last_finished = finished;
    if (result?.summary) record.last_summary = { ...result.summary };
    if (result?.more) this.moreWaiting.add(job.name);
    else this.moreWaiting.delete(job.name);
    if (error !== undefined) {
      this.failing.set(job.name, (this.failing.get(job.name) ?? 0) + 1);
      record.failures += 1;
      record.last_outcome = "error";
      record.last_error = { at: finished, message: error };
      this.log?.warn(`job ${job.name}: ${error}`);
    } else {
      this.failing.delete(job.name);
      record.last_outcome = result?.outcome === "discarded" ? "discarded" : "ok";
      record.last_ok = finished;
      if (record.last_outcome === "discarded" && result?.error) {
        this.log?.warn(`job ${job.name}: ${result.error}`);
      }
      delete record.last_error;
    }
    return structuredClone(record);
  }
}
