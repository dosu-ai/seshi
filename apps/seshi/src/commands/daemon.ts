import { parseArgs } from "node:util";
import {
  acquireUploaderLock,
  appendLog,
  capturePaths,
  type HeldUploaderLock,
} from "@seshi/capture";
import { parseDuration } from "@seshi/config";
import { captureRuntime } from "../capture-runtime";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, helpOrUsageError, takeJson } from "../cli/output";
import { hostOf } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi daemon [--keep-alive] [--once] [--idle <duration>] [--json]";

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: { "keep-alive"?: boolean; once?: boolean; idle?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        "keep-alive": { type: "boolean" },
        once: { type: "boolean" },
        idle: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  const idleMs = values.idle === undefined ? undefined : parseDuration(values.idle);
  if (values.idle !== undefined && idleMs === undefined) {
    return helpOrUsageError(
      ctx,
      json,
      `--idle takes a duration (5m, 1h), not '${values.idle}'`,
      USAGE,
    );
  }

  const paths = capturePaths(hostOf(ctx));
  const log = (line: string) => appendLog(paths.log, `uploader: ${line}`);
  const keepAlive = values["keep-alive"] === true && values.once !== true;
  let lock = acquireUploaderLock(paths);
  // A service entry (`--keep-alive`) waits its turn instead of exiting: launchd would restart
  // it every few seconds, and systemd (`Restart=on-failure`) never would, while an uploader a
  // hook started is still running.
  if (!lock && !keepAlive) {
    emit(ctx, json, { running: true, started: false }, () => [
      "seshi: an uploader is already running",
    ]);
    return EXIT.ok;
  }
  let runtime: Awaited<ReturnType<typeof captureRuntime>> | undefined;
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    runtime = await captureRuntime(ctx, {
      log,
      ...(idleMs !== undefined ? { idleMs } : {}),
    });
    if (values.once && lock) {
      const summary = await runtime.uploader.pass({ sweep: true });
      await runtime.upkeep();
      emit(ctx, json, summary, () => [
        `taken ${summary.taken} · found ${summary.found} · uploaded ${summary.uploaded} · retracted ${summary.retracted} · failed ${summary.failed} · queued ${summary.queued}`,
        ...(summary.signIn ? [`held: ${summary.signIn.split("\n")[0]}`] : []),
      ]);
      return summary.signIn ? EXIT.auth : EXIT.ok;
    }
    for (;;) {
      lock ??= await waitForLock(paths, stop.signal, LOCK_WAIT_MS);
      if (!lock) break;
      log(`started (pid ${process.pid})`);
      const upkeep = upkeepEvery(runtime, UPKEEP_TICK_MS);
      try {
        await runtime.uploader.run({ signal: stop.signal, keepAlive, lock });
      } finally {
        upkeep.stop();
        lock.release();
        lock = null;
      }
      log("stopped");
      if (!keepAlive || stop.signal.aborted) break;
    }
    return EXIT.ok;
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return failWith(ctx, json, err);
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await runtime?.close();
    lock?.release();
  }
}

const LOCK_WAIT_MS = 30_000;

/** How often the daemon looks for due upkeep jobs (serverless mode); each job has its own
 * period. */
export const UPKEEP_TICK_MS = 60_000;

function upkeepEvery(runtime: { upkeep(): Promise<void> }, everyMs: number): { stop(): void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runtime.upkeep().finally(() => {
      running = false;
    });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  tick();
  return { stop: () => clearInterval(timer) };
}

export async function waitForLock(
  paths: ReturnType<typeof capturePaths>,
  signal: AbortSignal,
  everyMs: number,
): Promise<HeldUploaderLock | null> {
  while (!signal.aborted) {
    const lock = acquireUploaderLock(paths);
    if (lock) return lock;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, everyMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  return null;
}
