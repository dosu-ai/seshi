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

export const NO_UPLOADER_ENV = "SESHI_NO_UPLOADER";

export async function startUploader(ctx: CommandContext, paths: CapturePaths): Promise<boolean> {
  if (ctx.env[NO_UPLOADER_ENV] === "1" || !ctx.spawn) return false;
  const { uploaderRunning } = await import("@seshi/capture/fast");
  if (uploaderRunning(paths)) return false;
  await ctx.spawn(["daemon"], { self: true });
  return true;
}
