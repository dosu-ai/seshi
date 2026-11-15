/** The machine a capture command runs on, from its context: the environment, the home folder
 * (from the env, so tests point it at a temporary folder) and the platform. Imported by
 * `seshi hook` and `seshi statusline`, so it imports nothing heavy (X3.3). */

import { homedir } from "node:os";
import { type CapturePaths, capturePaths } from "@seshi/capture/fast";
import type { CaptureHost } from "@seshi/kit";
import type { CommandContext } from "./index";

export function hostOf(ctx: Pick<CommandContext, "env">): CaptureHost {
  return {
    env: ctx.env,
    home: ctx.env.HOME || ctx.env.USERPROFILE || homedir(),
    platform: process.platform,
  };
}

export function pathsOf(ctx: Pick<CommandContext, "env">): {
  host: CaptureHost;
  paths: CapturePaths;
} {
  const host = hostOf(ctx);
  return { host, paths: capturePaths(host) };
}

/** Set by CI and tests: hooks spool as usual but never start an uploader. */
export const NO_UPLOADER_ENV = "SESHI_NO_UPLOADER";

/** Start the uploader unless one is running (or the env says not to). */
export async function startUploader(ctx: CommandContext, paths: CapturePaths): Promise<boolean> {
  if (ctx.env[NO_UPLOADER_ENV] === "1" || !ctx.spawn) return false;
  const { uploaderRunning } = await import("@seshi/capture/fast");
  if (uploaderRunning(paths)) return false;
  await ctx.spawn(["daemon"], { self: true });
  return true;
}
