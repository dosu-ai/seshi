/** The processes one process-mode scenario starts, and nothing else. Every child is started here
 * in a process group of its own (its pid is the group id), kept by that id, and killed by it
 * (never by name) when the scenario ends, passing or failing: killing the group takes along
 * anything the child started (a `git` the uploader ran). `survivors` proves it: no group this
 * run started has a process left. */

import type { Subprocess } from "bun";

export interface Exit {
  /** The exit code, or null when a signal ended it. */
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
}

export interface Child {
  /** A short name for messages: `serve`, `daemon --once`, `hook Stop`. */
  label: string;
  /** Also its process group's id. */
  pid: number;
  /** stdout and stderr, read to the end once it exits. */
  done: Promise<Exit>;
  exited: boolean;
  /** This harness killed it on purpose (a kill rule, a `kill` step, settle stopping a daemon). */
  killed: boolean;
}

export interface SpawnOptions {
  label: string;
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  /** Also write what it printed to this file once it exits (a server's log). */
  logFile?: string;
}

export class Procs {
  readonly all: Child[] = [];

  spawn(argv: string[], options: SpawnOptions): Child {
    const proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin !== undefined ? new Blob([options.stdin]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so a kill reaches whatever it started too.
      detached: true,
    }) as Subprocess<"ignore", "pipe", "pipe">;
    const child: Child = {
      label: options.label,
      pid: proc.pid,
      exited: false,
      killed: false,
      done: Promise.resolve({ code: null, signal: null, out: "", err: "" }),
    };
    child.done = (async () => {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      child.exited = true;
      if (options.logFile) await Bun.write(options.logFile, `${out}${err}`);
      return { code: proc.signalCode ? null : code, signal: proc.signalCode ?? null, out, err };
    })();
    this.all.push(child);
    return child;
  }

  running(): Child[] {
    return this.all.filter((c) => !c.exited);
  }

  /** Signal a child's process group (SIGKILL by default) and wait until the child is gone; a
   * SIGTERM not obeyed in `waitMs` becomes a SIGKILL. */
  async kill(
    child: Child,
    signal: "SIGKILL" | "SIGTERM" = "SIGKILL",
    waitMs = 5000,
  ): Promise<void> {
    if (child.exited) return;
    child.killed = true;
    signalGroup(child.pid, signal);
    const gone = await Promise.race([
      child.done.then(() => true),
      Bun.sleep(waitMs).then(() => false),
    ]);
    if (!gone && signal !== "SIGKILL") return this.kill(child, "SIGKILL", waitMs);
  }

  /** Kill every child still running, then whatever is left in their groups (a group id is not
   * given out again while a process of it lives, so these are this run's). Never throws. */
  async killAll(): Promise<void> {
    await Promise.all(this.all.map((c) => this.kill(c).catch(() => undefined)));
    const groups = new Set(this.all.map((c) => c.pid));
    const left = new Set(
      listProcesses()
        .filter((p) => groups.has(p.pgid))
        .map((p) => p.pgid),
    );
    for (const pgid of left) signalGroup(pgid, "SIGKILL");
    if (left.size > 0) await Bun.sleep(100);
  }

  /** Processes left in any group this run started. Empty after `killAll`. */
  survivors(): string[] {
    const groups = new Set(this.all.map((c) => c.pid));
    const labels = new Map(this.all.map((c) => [c.pid, c.label]));
    return listProcesses()
      .filter((p) => groups.has(p.pgid))
      .map((p) => `pid ${p.pid} in the group of ${labels.get(p.pgid)} (${p.pgid}): ${p.command}`);
  }
}

function signalGroup(pgid: number, signal: "SIGKILL" | "SIGTERM"): void {
  try {
    process.kill(-pgid, signal);
  } catch {}
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every process on the machine with its group (`ps` on macOS and Linux both take this). */
export function listProcesses(): { pid: number; pgid: number; command: string }[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out: { pid: number; pgid: number; command: string }[] = [];
  for (const line of new TextDecoder().decode(ps.stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), pgid: Number(m[2]), command: (m[3] ?? "").slice(0, 160) });
  }
  return out;
}
