/** Upload some sessions now, in this process, and say on stderr what did not go: a hook on a
 * machine that may be gone once the agent's run ends (a Cursor Cloud VM), where nothing can be
 * left to the background uploader. Loaded only by such a hook. */

import {
  acquireUploaderLock,
  appendLog,
  type CapturePaths,
  readState,
  sessionToggle,
  updateState,
} from "@seshi/capture";
import { captureRuntime } from "../capture-runtime";
import type { CommandContext } from "./index";
import { passUntilSettled } from "./passes";

const LOCK_POLL_MS = 250;

export interface UploadNowResult {
  /** Sessions the server now holds all of. */
  uploaded: string[];
  /** Sessions it does not, and why. */
  failed: { key: string; message: string }[];
}

/** Upload (or retract) `keys` for at most `deadlineMs`. When time runs out mid-pass the pass is
 * left running and this returns: the hook answers and exits, the process ends with it, and the
 * next hook (or one that finds this one's lock dead) takes over. */
export async function uploadNow(
  ctx: CommandContext,
  paths: CapturePaths,
  keys: readonly string[],
  options: { deadlineMs: number },
): Promise<UploadNowResult> {
  const deadline = Date.now() + options.deadlineMs;
  // Waiting for another uploader gets half the time, leaving the rest for the upload.
  const lockDeadline = Date.now() + options.deadlineMs / 2;
  const log = (line: string) => appendLog(paths.log, `upload now: ${line}`);
  const only = new Set(keys);
  let signIn: string | undefined;
  let error: string | undefined;

  const work = async () => {
    const runtime = await captureRuntime(ctx, { log, continueOnConflict: true });
    try {
      let lock = acquireUploaderLock(paths);
      while (!lock && Date.now() < lockDeadline) {
        await Bun.sleep(LOCK_POLL_MS);
        lock = acquireUploaderLock(paths);
      }
      if (!lock) {
        error = "another uploader kept the lock while this hook waited";
        return;
      }
      try {
        // A failure's backoff is for a background uploader that comes back; this machine may
        // not, so this hook tries now.
        await updateState(paths, (state) => {
          let changed = false;
          for (const key of only) {
            const s = state.sessions[key];
            if (s?.next_attempt_at === undefined) continue;
            delete s.next_attempt_at;
            changed = true;
          }
          return changed;
        });
        signIn = await passUntilSettled(runtime.uploader, lock, only);
      } finally {
        lock.release();
      }
    } finally {
      await runtime.close();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()));
  });
  // Settles either way, so a pass that fails after the hook stopped waiting rejects nothing.
  const running = work().then(
    () => ({ failed: undefined }),
    (err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) }),
  );
  const finished = await Promise.race([running, outOfTime]);
  clearTimeout(timer);
  if (finished === "late") {
    error = "the hook's time ran out while uploading; the next stop sends the rest";
  } else if (finished.failed !== undefined) error = finished.failed;

  const state = readState(paths);
  const result: UploadNowResult = { uploaded: [], failed: [] };
  for (const key of keys) {
    const s = state.sessions[key];
    const why = signIn ?? error;
    if (!s) {
      // Not even taken in from the spool: nothing ran for it.
      if (why) result.failed.push({ key, message: why });
      continue;
    }
    if (sessionToggle(state, s.agent, s) === "off") {
      if (s.retract === "failed") {
        result.failed.push({ key, message: `not retracted: ${s.retract_error ?? "refused"}` });
      } else if (s.retract === "pending") {
        result.failed.push({ key, message: `not retracted yet${why ? `: ${why}` : ""}` });
      }
      continue;
    }
    const failure = why ?? s.error?.message;
    if (failure) result.failed.push({ key, message: failure });
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
