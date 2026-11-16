import { homedir } from "node:os";
import { join, win32 } from "node:path";

export const MEMORY_INDEX = ":memory:";

export interface IndexPathOptions {
  deployment: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
}

export function defaultIndexPath(options: IndexPathOptions): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const file = `${options.deployment.replace(/[^A-Za-z0-9._-]+/g, "_") || "seshi"}.sqlite`;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return win32.join(local, "seshi", "cache", "search", file);
  }
  if (platform === "darwin" && !env.XDG_CACHE_HOME) {
    return join(home, "Library", "Caches", "seshi", "search", file);
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "seshi", "search", file);
}
