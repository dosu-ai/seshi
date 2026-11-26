import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { sqlBackend } from "../backends";
import type { SqlJob, SqlWorkerResponse } from "./protocol";
import { protocolLine } from "./worker";

/** The queue is full, or the caller already has its queries in flight (`429 sql_busy`). */
export class SqlBusy extends Error {
  readonly code = "sql_busy";
  constructor(message: string) {
    super(message);
    this.name = "SqlBusy";
  }
}

export interface SqlPoolOptions {
  /** How to start a worker: `[seshi, "sql-worker"]` from a binary. */
  command: readonly string[];
  /** Workers, each running one query at a time (2 on a server, 1 on a laptop). */
  workers: number;
  /** Kill a worker whose resident memory passes this many bytes (2 GiB). */
  workerMemory: number;
  /** Queries waiting for a worker before more are refused (8). */
  maxQueue?: number;
  /** Queries one principal may have waiting or running at once (2). */
  perPrincipal?: number;
  /** How often the watchdog reads a busy worker's memory, in ms (250). */
  pollMs?: number;
  /** Extra time past a query's `timeout_ms` before the watchdog kills it (0: SQLite has no
   * interrupt to wait for; DuckDB's worker interrupts its own query at the timeout). */
  graceMs?: number;
  /** What the workers' environment holds besides `PATH`, `HOME` and `TMPDIR` (the read-only
   * storage credential, on LanceDB). */
  env?: Readonly<Record<string, string>>;
  /** How long queries wait while no worker is up (all starting or restarting) before they are
   * answered `internal`, in ms (20 s). A wait for busy workers has no limit here: the queue's
   * length and each query's timeout bound it. */
  startMs?: number;
  log?: (line: string) => void;
  /** Reads a process's resident memory in bytes, or undefined where it cannot. */
  rss?: (pid: number) => Promise<number | undefined>;
}

export interface SqlPoolStatus {
  workers: number;
  busy: number;
  queued: number;
  /** Workers killed by the watchdog or that exited, since the pool started. */
  restarts: number;
}

/** The command that runs a worker script with this Bun: for tests and `bun run`, where there is
 * no seshi binary to name. `worker-main.ts` here, or, in a process given DuckDB (`provideSql`),
 * the DuckDB engine's own, which gives its worker DuckDB too. A compiled binary passes
 * `[seshi, "sql-worker"]` instead. */
export function scriptWorkerCommand(): string[] {
  const script =
    sqlBackend()?.script ?? fileURLToPath(new URL("./worker-main.ts", import.meta.url));
  return [process.execPath, script];
}

type Request = SqlJob;

interface Job {
  principal: string;
  request: Request;
  resolve: (response: SqlWorkerResponse) => void;
}

interface Slot {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  ready: boolean;
  job?: {
    id: string;
    job: Job;
    timer: ReturnType<typeof setTimeout>;
    poll?: ReturnType<typeof setInterval>;
  };
  /** Set when the watchdog killed it: the job is answered already. */
  killed?: boolean;
  /** Set when its process exited: no job goes to it while it waits to be replaced. */
  exited?: boolean;
}

/** A worker that can take a job now, or will once it has started. */
function free(slot: Slot): boolean {
  return slot.job === undefined && !slot.killed && !slot.exited;
}

/** A worker that has started and is not going away: it will take a job once it is done. */
function up(slot: Slot): boolean {
  return slot.ready && !slot.killed && !slot.exited;
}

/** Resident memory of `pid` in bytes: `/proc` on Linux, `ps` elsewhere, nothing on Windows. */
export async function residentBytes(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb === undefined ? undefined : Number(kb) * 1024;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") return undefined;
  try {
    const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(ps.stdout).text();
    const kb = Number.parseInt(out.trim(), 10);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

const RESTART_MIN_MS = 100;
const RESTART_MAX_MS = 5_000;

/** The `sql` workers (docs/seshi/session-tools.md, "The worker"): processes, because neither a
 * `bun:sqlite` query nor a Worker thread running one can be stopped from inside. Each runs one
 * query at a time; the watchdog kills one that runs past its deadline or its memory limit,
 * answers its query `timeout` or `memory`, and starts another. */
export class SqlPool {
  private readonly options: Required<Omit<SqlPoolOptions, "log" | "rss" | "env">> &
    Pick<SqlPoolOptions, "log" | "env">;
  private readonly rss: (pid: number) => Promise<number | undefined>;
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<string, number>();
  private readonly home: string;
  private restarts = 0;
  private backoff = RESTART_MIN_MS;
  private closed = false;
  private seq = 0;
  /** Armed while queries wait and no worker is up (`startMs`). */
  private stalled?: ReturnType<typeof setTimeout>;

  constructor(options: SqlPoolOptions) {
    this.options = {
      maxQueue: 8,
      perPrincipal: 2,
      pollMs: 250,
      graceMs: 0,
      startMs: 20_000,
      ...options,
    };
    this.rss = options.rss ?? residentBytes;
    // The workers' own folder: their HOME and TMPDIR, nothing of this process's.
    this.home = mkdtempSync(join(tmpdir(), "seshi-sql-"));
    for (let i = 0; i < Math.max(1, options.workers); i++) this.slots.push(this.spawn());
  }

  /** The workers' environment, built, not inherited: no seshi settings, tokens or keys, only
   * what `env` names for them. */
  private env(): Record<string, string> {
    const env: Record<string, string> = {
      ...this.options.env,
      // DuckDB's bindings write TIMESTAMPTZ values in the process's time zone; Lance's times
      // are UTC, and so is every answer.
      TZ: "UTC",
      HOME: this.home,
      TMPDIR: this.home,
      TMP: this.home,
      TEMP: this.home,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Windows cannot start a process without it.
    for (const key of ["SystemRoot", "SYSTEMROOT"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }

  private spawn(): Slot {
    const [program, ...args] = this.options.command;
    const proc = Bun.spawn([program as string, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env(),
      cwd: this.home,
    });
    const slot: Slot = { proc, ready: false };
    void this.readLines(proc.stdout, (line) => this.onLine(slot, line));
    void this.readLines(proc.stderr, (line) =>
      this.options.log?.(`sql worker ${proc.pid}: ${line}`),
    );
    void proc.exited.then((code) => this.onExit(slot, code));
    return slot;
  }

  private async readLines(stream: ReadableStream<Uint8Array>, each: (line: string) => void) {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        let nl = buffered.indexOf("\n");
        while (nl !== -1) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (line.trim() !== "") this.deliver(line, each);
          nl = buffered.indexOf("\n");
        }
      }
    } catch {
      // The process went away; onExit answers what it was running.
    }
  }

  /** One line to its handler. A handler's failure is logged, and never ends the read: this
   * worker's later answers still arrive. */
  private deliver(line: string, each: (line: string) => void): void {
    try {
      each(line);
    } catch (err) {
      this.options.log?.(`sql pool: handling a worker's line failed: ${(err as Error).message}`);
    }
  }

  private onLine(slot: Slot, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.log?.(`sql worker ${slot.proc.pid} wrote a line that is not JSON`);
      return;
    }
    if (typeof message === "object" && message !== null && "ready" in message) {
      slot.ready = true;
      this.pump();
      return;
    }
    const response = message as SqlWorkerResponse;
    const current = slot.job;
    if (current === undefined || current.id !== response.id) return;
    this.finish(slot, response);
    this.backoff = RESTART_MIN_MS;
  }

  private finish(slot: Slot, response: SqlWorkerResponse): void {
    const current = slot.job;
    if (current === undefined) return;
    clearTimeout(current.timer);
    if (current.poll) clearInterval(current.poll);
    slot.job = undefined;
    this.settle(current.job, response);
    this.pump();
  }

  private settle(job: Job, response: SqlWorkerResponse): void {
    const left = (this.inFlight.get(job.principal) ?? 1) - 1;
    if (left <= 0) this.inFlight.delete(job.principal);
    else this.inFlight.set(job.principal, left);
    job.resolve(response);
  }

  private onExit(slot: Slot, code: number | null): void {
    slot.exited = true;
    const index = this.slots.indexOf(slot);
    const current = slot.job;
    if (current !== undefined) {
      clearTimeout(current.timer);
      if (current.poll) clearInterval(current.poll);
      slot.job = undefined;
      this.settle(current.job, {
        id: current.id,
        ok: false,
        error: {
          kind: "internal",
          message: `the sql worker exited (${code ?? "killed"}) while running the query`,
        },
      });
    }
    this.watchStart();
    if (this.closed || index === -1) return;
    this.restarts++;
    if (slot.killed) {
      // The watchdog's kill: replace it at once.
      this.slots[index] = this.spawn();
      return;
    }
    this.options.log?.(
      `sql worker ${slot.proc.pid} exited (${code}); restarting in ${this.backoff} ms`,
    );
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS);
    setTimeout(() => {
      if (this.closed || this.slots[index] !== slot) return;
      this.slots[index] = this.spawn();
    }, wait).unref?.();
  }

  /** The watchdog: kill `slot`, answer its query with `kind`. */
  private kill(slot: Slot, kind: "timeout" | "memory", message: string): void {
    const current = slot.job;
    if (current === undefined || slot.killed) return;
    slot.killed = true;
    clearTimeout(current.timer);
    if (current.poll) clearInterval(current.poll);
    slot.job = undefined;
    this.settle(current.job, { id: current.id, ok: false, error: { kind, message } });
    slot.proc.kill("SIGKILL");
    this.watchStart();
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) break;
      if (!slot.ready || !free(slot)) continue;
      this.assign(slot, this.queue.shift() as Job);
    }
    this.watchStart();
  }

  /** Arm the give-up timer while queries wait and no worker is up; disarm it otherwise. */
  private watchStart(): void {
    if (this.closed || this.queue.length === 0 || this.slots.some(up)) {
      clearTimeout(this.stalled);
      this.stalled = undefined;
      return;
    }
    if (this.stalled !== undefined) return;
    this.stalled = setTimeout(() => {
      this.stalled = undefined;
      if (this.slots.some(up)) return;
      for (const job of this.queue.splice(0)) {
        this.settle(job, {
          id: "",
          ok: false,
          error: { kind: "internal", message: "no sql worker could start: see the server's log" },
        });
      }
    }, this.options.startMs);
    this.stalled.unref?.();
  }

  private assign(slot: Slot, job: Job): void {
    const id = `q${++this.seq}`;
    const timeout = job.request.limits.timeout_ms;
    const timer = setTimeout(
      () =>
        this.kill(
          slot,
          "timeout",
          `the query ran past ${Math.round(timeout / 100) / 10} s: narrow it, or add LIMIT`,
        ),
      timeout + this.options.graceMs,
    );
    const limit = this.options.workerMemory;
    const pid = slot.proc.pid;
    const poll = setInterval(() => {
      void this.rss(pid).then((bytes) => {
        if (bytes !== undefined && bytes > limit && slot.job?.id === id) {
          this.kill(slot, "memory", `the query used more than ${Math.round(limit / 2 ** 20)} MiB`);
        }
      });
    }, this.options.pollMs);
    slot.job = { id, job, timer, poll };
    try {
      slot.proc.stdin.write(`${protocolLine({ id, ...job.request })}\n`);
      const flushed = slot.proc.stdin.flush();
      // A flush that fails later means the process is going: onExit answers the job.
      if (flushed instanceof Promise) flushed.catch(() => undefined);
    } catch (err) {
      // Its process is going away (EPIPE): put the job back for another worker, and make sure
      // this one goes, so onExit replaces it.
      clearTimeout(timer);
      clearInterval(poll);
      slot.job = undefined;
      slot.exited = true;
      slot.proc.kill("SIGKILL");
      this.queue.unshift(job);
      this.options.log?.(
        `sql worker ${pid} could not take a query (${(err as Error).message}); replacing it`,
      );
    }
  }

  /** Run one request on the next free worker. Throws `SqlBusy` when the caller has
   * `perPrincipal` queries in flight already, or `maxQueue` are waiting. */
  run(principal: string, request: Request): Promise<SqlWorkerResponse> {
    if (this.closed) return Promise.reject(new Error("the sql workers are shut down"));
    const mine = this.inFlight.get(principal) ?? 0;
    if (mine >= this.options.perPrincipal) {
      return Promise.reject(
        new SqlBusy(`you have ${mine} sql queries running; wait for one to finish`),
      );
    }
    // Waiting: queued beyond the workers that are free or starting.
    const waiting = this.queue.length - this.slots.filter(free).length;
    if (waiting >= this.options.maxQueue) {
      return Promise.reject(new SqlBusy("the sql workers are busy; try again shortly"));
    }
    this.inFlight.set(principal, mine + 1);
    return new Promise((resolve) => {
      const job: Job = { principal, request, resolve };
      this.queue.push(job);
      this.pump();
    });
  }

  status(): SqlPoolStatus {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.job !== undefined).length,
      queued: this.queue.length,
      restarts: this.restarts,
    };
  }

  /** Stop every worker; queries waiting are answered `internal`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.stalled);
    for (const job of this.queue.splice(0)) {
      this.settle(job, {
        id: "",
        ok: false,
        error: { kind: "internal", message: "the sql workers are shut down" },
      });
    }
    await Promise.all(
      this.slots.map(async (slot) => {
        try {
          slot.proc.stdin.end();
        } catch {
          // Already gone.
        }
        slot.proc.kill("SIGKILL");
        await slot.proc.exited;
      }),
    );
    rmSync(this.home, { recursive: true, force: true });
  }
}
