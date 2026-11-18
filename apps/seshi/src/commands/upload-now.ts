/** Upload some sessions now, in this process, and say on stderr what did not go: a hook on a
 * machine that may be gone once the agent's run ends (a Cursor Cloud VM), where nothing can be
 * left to the background uploader. Loaded only by such a hook. */

import {
  acquireUploaderLock,
  appendLog,
  type CapturePaths,
  readState,
  sessionToggle,
} from "@seshi/capture";
import { captureRuntime } from "../capture-runtime";
import type { CommandContext } from "./index";

const LOCK_POLL_MS = 250;

export interface UploadNowResult {
  /** Sessions the server now holds all of. */
  uploaded: string[];
  /** Sessions it does not, and why. */
  failed: { key: string; message: string }[];
}

export async function uploadNow(
  ctx: CommandContext,
  paths: CapturePaths,
  keys: readonly string[],
  options: { deadlineMs: number },
): Promise<UploadNowResult> {
  const deadline = Date.now() + options.deadlineMs;
  const log = (line: string) => appendLog(paths.log, `upload now: ${line}`);
  const only = new Set(keys);
  let signIn: string | undefined;
  let error: string | undefined;
  try {
    const runtime = await captureRuntime(ctx, { log, continueOnConflict: true });
    try {
      let lock = acquireUploaderLock(paths);
      while (!lock && Date.now() < deadline) {
        await Bun.sleep(LOCK_POLL_MS);
        lock = acquireUploaderLock(paths);
      }
      if (!lock) error = "another uploader held the lock until the hook's time ran out";
      else {
        try {
          while (Date.now() < deadline && lock.beat()) {
            const summary = await runtime.uploader.pass({ only });
            if (summary.signIn) {
              signIn = summary.signIn;
              break;
            }
            if (summary.uploaded === 0 && summary.retracted === 0) break;
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await runtime.close();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const state = readState(paths);
  const result: UploadNowResult = { uploaded: [], failed: [] };
  for (const key of keys) {
    const s = state.sessions[key];
    if (!s || sessionToggle(state, s.agent, s) === "off") {
      if (s?.retract === "failed") {
        result.failed.push({ key, message: `not retracted: ${s.retract_error ?? "refused"}` });
      } else if (s?.retract === "pending") {
        result.failed.push({ key, message: "not retracted yet" });
      }
      continue;
    }
    const why = signIn ?? error ?? s.error?.message;
    if (why) result.failed.push({ key, message: why });
    else if (!s.path) {
      result.failed.push({
        key,
        message:
          "seshi found no transcript for it (the hook named none, and none is under ~/.cursor/projects)",
      });
    } else if (s.stored) result.uploaded.push(key);
  }
  for (const { key, message } of result.failed) {
    const line = `${key} was not uploaded: ${message}`;
    log(line);
    // The agent's run log shows a hook's stderr; seshi's own log keeps it too.
    ctx.stderr(`seshi: ${line.replace(/\n/g, " ")}`);
  }
  return result;
}
