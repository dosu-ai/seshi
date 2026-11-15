/** The capture rules from the CLI config (F9.5), with the same loader every command uses (F1.4),
 * but without paying for it on every hook. Loading and checking the config costs a hook tens of
 * milliseconds (the schema library), so the rules are kept in `rules.json` with what they were
 * read from: the config file's path, size and modification time, and the `SESHI_CAPTURE__*`
 * variables. A hook reads the cache when all of those still match, and loads the config again
 * only when one changed. The uploader, the sweep and the status line go through the same
 * function, so they all judge with the same rules (F9.3). */

import { realpathSync, statSync } from "node:fs";
import { cliConfigPath } from "@seshi/config/paths";
import type { CaptureHost } from "@seshi/kit";
import { expandTilde } from "@seshi/kit";
import { readText, writePrivateFile } from "./files";
import type { CapturePaths } from "./paths";
import { type CaptureRules, DEFAULT_RULES, type PathRule } from "./rules";

const CACHE_SCHEMA = "seshi/capture-rules/1";

/** What the CLI config says that capture and the status line need. */
export interface RulesSnapshot {
  rules: CaptureRules;
  /** The config cannot be loaded: nothing is captured until it is fixed. */
  error?: string;
  /** The CLI config's colour theme, for the status line (B1.4). */
  theme?: "auto" | "dark" | "light";
}

interface CacheKey {
  file: string;
  size: number | null;
  mtime: number | null;
  env: Record<string, string>;
}

interface CacheFile {
  schema: typeof CACHE_SCHEMA;
  key: CacheKey;
  snapshot: RulesSnapshot;
}

function keyOf(host: CaptureHost): CacheKey {
  const file = cliConfigPath({ env: host.env, home: host.home, platform: host.platform });
  let size: number | null = null;
  let mtime: number | null = null;
  try {
    const stat = statSync(file);
    size = stat.size;
    mtime = stat.mtimeMs;
  } catch {}
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host.env)) {
    if ((name.startsWith("SESHI_CAPTURE__") || name === "SESHI_THEME") && value !== undefined) {
      env[name] = value;
    }
  }
  return { file, size, mtime, env };
}

const sameKey = (a: CacheKey, b: CacheKey) => JSON.stringify(a) === JSON.stringify(b);

/** A folder rule with `~` expanded and, when it exists, its real path. */
function pathRule(path: string, capture: boolean, home: string): PathRule {
  const expanded = expandTilde(path, home);
  const rule: PathRule = { path: expanded, capture };
  try {
    const real = realpathSync(expanded);
    if (real !== expanded) rule.real = real;
  } catch {}
  return rule;
}

/** Load the CLI config with the full loader and turn its `[capture]` into rules. */
export async function loadRules(host: CaptureHost): Promise<RulesSnapshot> {
  try {
    const { loadCliConfig } = await import("@seshi/config");
    const { config } = loadCliConfig({
      env: { ...host.env },
      home: host.home,
      platform: host.platform,
    });
    return {
      rules: {
        enabled: config.capture.enabled,
        paths: config.capture.paths.map((p) => pathRule(p.path, p.capture, host.home)),
        remotes: [...config.capture.remotes],
      },
      theme: config.theme,
    };
  } catch (err) {
    return { rules: DEFAULT_RULES, error: (err as Error).message };
  }
}

/** The rules, from `rules.json` when the CLI config has not changed since it was written, else
 * loaded again (and the cache rewritten). */
export async function captureRules(host: CaptureHost, paths: CapturePaths): Promise<RulesSnapshot> {
  const key = keyOf(host);
  try {
    const cached = JSON.parse(readText(paths.rules) ?? "null") as CacheFile | null;
    if (cached?.schema === CACHE_SCHEMA && sameKey(cached.key, key)) return cached.snapshot;
  } catch {}
  const snapshot = await loadRules(host);
  try {
    const file: CacheFile = { schema: CACHE_SCHEMA, key, snapshot };
    writePrivateFile(paths.rules, JSON.stringify(file));
  } catch {
    // A cache that cannot be written only costs the next hook a load.
  }
  return snapshot;
}
