import type { JobRecord } from "@seshi/store";
import type { Logger } from "./log";

export type JobPlacement = "worker" | "every";

export interface JobResult {
  /** `ok` unless said otherwise; `discarded` when another worker won a race (X7.3). */
  outcome?: "ok" | "discarded" | "error";
  error?: string;
  /** More is waiting now: run again without waiting for the interval. */
  more?: boolean;
  summary?: Record<string, number>;
}

export interface Job {
  readonly name: string;
  readonly kind: string;
  readonly placement: JobPlacement;
  /** How long to wait after a run ends before the next starts. */
  readonly intervalMs: number;
  readonly source?: string;
  /** One run. It should stop early when `signal` aborts. A throw is the run's error. */
  run(signal: AbortSignal): Promise<JobResult | undefined>;
  /** What is waiting (pending markers, checkpoint age), computed when status asks; on any
   * instance, not only the worker. */
  backlog?(): Promise<Record<string, number> | undefined>;
}

const MORE_DELAY_MS = 10;

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
