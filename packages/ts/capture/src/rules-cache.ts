import { cliConfigPath, NOT_SETTINGS_ENV } from "@seshi/config/paths";
import type { CaptureHost } from "@seshi/kit";
import { expandTilde } from "@seshi/kit";
import { tryReadJson, tryRealpath, tryStat, tryWritePrivateFile } from "./files";
import type { CapturePaths } from "./paths";
import { type CaptureRules, DEFAULT_RULES, type PathRule } from "./rules";

const CACHE_SCHEMA = "seshi/capture-rules/1";

export interface RulesSnapshot {
  rules: CaptureRules;
  /** The config cannot be loaded: nothing is captured until it is fixed. */
  error?: string;
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
  const stat = tryStat(file);
  const size = stat?.size ?? null;
  const mtime = stat?.mtimeMs ?? null;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host.env)) {
    if (name.startsWith("SESHI_") && !NOT_SETTINGS_ENV.includes(name) && value !== undefined) {
      env[name] = value;
    }
  }
  return { file, size, mtime, env };
}

const sameKey = (a: CacheKey, b: CacheKey) => JSON.stringify(a) === JSON.stringify(b);

function pathRule(path: string, capture: boolean, home: string): PathRule {
  const expanded = expandTilde(path, home);
  const rule: PathRule = { path: expanded, capture };
  const real = tryRealpath(expanded);
  if (real !== undefined && real !== expanded) rule.real = real;
  return rule;
}

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
  const cached = tryReadJson(paths.rules) as CacheFile | null | undefined;
  if (cached?.schema === CACHE_SCHEMA && sameKey(cached.key, key)) return cached.snapshot;
  const snapshot = await loadRules(host);
  const file: CacheFile = { schema: CACHE_SCHEMA, key, snapshot };
  tryWritePrivateFile(paths.rules, JSON.stringify(file));
  return snapshot;
}
