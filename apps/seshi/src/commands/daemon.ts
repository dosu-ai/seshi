/** `seshi daemon`: the background uploader and sweep (F9.1, F9.3). Hooks start it when it is not
 * running; it drains the spool, uploads, retracts, sweeps, and stops after a few idle minutes.
 * One runs per machine: a second exits at once. `--keep-alive` never stops (what the service
 * entry `seshi capture install --service` runs); `--once` makes one pass, sweep included, and
 * prints what it did.
 *
 *   seshi daemon [--keep-alive] [--once] [--idle <duration>] [--json]
 *
 * Exit codes: 0, also when another uploader is already running; 2 usage; 3 a CLI config it
 * cannot use; 5 (`--once`) when a sign-in is needed. */

import { parseArgs } from "node:util";
import { acquireUploaderLock, appendLog, capturePaths } from "@seshi/capture";
import { parseDuration } from "@seshi/config";
import { captureRuntime } from "../capture-runtime";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, takeJson, usageError } from "../cli/output";
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
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  const idleMs = values.idle === undefined ? undefined : parseDuration(values.idle);
  if (values.idle !== undefined && idleMs === undefined) {
    return usageError(ctx, json, `--idle takes a duration (5m, 1h), not '${values.idle}'`, USAGE);
  }

  const paths = capturePaths(hostOf(ctx));
  const log = (line: string) => appendLog(paths.log, `uploader: ${line}`);
  const lock = acquireUploaderLock(paths);
  if (!lock) {
    emit(ctx, json, { running: true, started: false }, () => [
      "seshi: an uploader is already running",
    ]);
    return EXIT.ok;
  }
  let runtime: Awaited<ReturnType<typeof captureRuntime>> | undefined;
  try {
    runtime = await captureRuntime(ctx, {
      log,
      ...(idleMs !== undefined ? { idleMs } : {}),
    });
    if (values.once) {
      const summary = await runtime.uploader.pass({ sweep: true });
      emit(ctx, json, summary, () => [
        `taken ${summary.taken} · found ${summary.found} · uploaded ${summary.uploaded} · retracted ${summary.retracted} · failed ${summary.failed} · queued ${summary.queued}`,
        ...(summary.signIn ? [`sign in: ${summary.signIn}`] : []),
      ]);
      return summary.signIn ? EXIT.auth : EXIT.ok;
    }
    log(`started (pid ${process.pid})`);
    const stop = new AbortController();
    const onSignal = () => stop.abort();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    try {
      await runtime.uploader.run({
        signal: stop.signal,
        keepAlive: values["keep-alive"] === true,
        lock,
      });
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
    log("stopped");
    return EXIT.ok;
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return failWith(ctx, json, err);
  } finally {
    await runtime?.close();
    lock.release();
  }
}
