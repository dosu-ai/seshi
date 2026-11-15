/** Where an index file lives when `search.path` does not say. The index is derived and can be
 * rebuilt from the change feed at any time (X6.1), so it belongs in the user's cache folder,
 * one file per deployment: an instance pointed at another bucket starts its own index rather
 * than mixing two deployments' sessions. */

import { homedir } from "node:os";
import { join, win32 } from "node:path";

/** The in-memory index: nothing on disk, rebuilt on every start. */
export const MEMORY_INDEX = ":memory:";

export interface IndexPathOptions {
  /** The deployment id (the layout marker's), which names the file. */
  deployment: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
}

/** `<cache>/seshi/search/<deployment>.sqlite`, where `<cache>` is `$XDG_CACHE_HOME` (else
 * `~/.cache`) on Linux, `~/Library/Caches` on macOS and `%LOCALAPPDATA%` on Windows. */
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
