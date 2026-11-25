import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol";
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
   * interrupt to wait for). */
  graceMs?: number;
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

/** The command that runs `worker-main.ts` with this Bun: for tests and `bun run`, where there is
 * no seshi binary to name. A compiled binary passes `[seshi, "sql-worker"]` instead. */
export function scriptWorkerCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("./worker-main.ts", import.meta.url))];
}

type Request = Omit<SqlWorkerRequest, "id">;

interface Job {
  principal: string;
  request: Request;
  resolve: (response: SqlWorkerResponse) => void;
  /** Gives up on a job no worker took: none could start. */
  waiting?: ReturnType<typeof setTimeout>;
}

/** How long past its own timeout a query may wait for a worker before it is answered
 * `internal`: only when no worker could start. */
const QUEUE_GRACE_MS = 5_000;

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
  private readonly options: Required<Omit<SqlPoolOptions, "log" | "rss">> &
    Pick<SqlPoolOptions, "log">;
  private readonly rss: (pid: number) => Promise<number | undefined>;
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<string, number>();
  private readonly home: string;
  private restarts = 0;
  private backoff = RESTART_MIN_MS;
  private closed = false;
  private seq = 0;

  constructor(options: SqlPoolOptions) {
    this.options = {
      maxQueue: 8,
      perPrincipal: 2,
      pollMs: 250,
      graceMs: 0,
      ...options,
    };
    this.rss = options.rss ?? residentBytes;
    // The workers' own folder: their HOME and TMPDIR, nothing of this process's.
    this.home = mkdtempSync(join(tmpdir(), "seshi-sql-"));
    for (let i = 0; i < Math.max(1, options.workers); i++) this.slots.push(this.spawn());
  }

  /** The workers' environment, built, not inherited: no seshi settings, tokens or keys. */
  private env(): Record<string, string> {
    const env: Record<string, string> = {
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
          if (line.trim() !== "") each(line);
          nl = buffered.indexOf("\n");
        }
      }
    } catch {
      // The process went away; onExit answers what it was running.
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
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (!slot.ready || !free(slot)) continue;
      this.assign(slot, this.queue.shift() as Job);
    }
  }

  private assign(slot: Slot, job: Job): void {
    clearTimeout(job.waiting);
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
    slot.proc.stdin.write(`${protocolLine({ id, ...job.request })}\n`);
    slot.proc.stdin.flush();
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
      job.waiting = setTimeout(() => {
        const at = this.queue.indexOf(job);
        if (at === -1) return;
        this.queue.splice(at, 1);
        this.settle(job, {
          id: "",
          ok: false,
          error: { kind: "internal", message: "no sql worker could start: see the server's log" },
        });
      }, request.limits.timeout_ms + QUEUE_GRACE_MS);
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
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.waiting);
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
