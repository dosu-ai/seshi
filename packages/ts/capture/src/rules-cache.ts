import { cliConfigPath, NOT_SETTINGS_ENV } from "@seshi/config/paths";
import type { CaptureHost } from "@seshi/kit";
import { expandTilde } from "@seshi/kit";
import { readExcludeEntry } from "@seshi/model/exclude";
import { tryReadJson, tryRealpath, tryStat, tryWritePrivateFile } from "./files";
import { readOrgRules } from "./org-rules";
import type { CapturePaths } from "./paths";
import { type CaptureRules, DEFAULT_RULES, type ExcludeRule, type PathRule } from "./rules";

// 2: rules gained `exclude`. A cache written before it would hide a new exclude list, or keep the
// error an older seshi gave for the unknown key, until the config file changed.
const CACHE_SCHEMA = "seshi/capture-rules/2";

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

/** One entry of `capture.exclude`, or undefined for a blank one or a `#` comment. A folder starts
 * with `/`, `~`, a drive (`C:\`) or a network share (`\\server`); anything else names a
 * repository. A folder's symbolic links are resolved up to its first wildcard. */
export function excludeRule(raw: string, home: string): ExcludeRule | undefined {
  const read = readExcludeEntry(raw);
  if (read === undefined) return undefined;
  if (read.repo !== undefined) return { entry: read.entry, repo: read.repo };
  const path = expandTilde(read.folder, home);
  const rule: ExcludeRule = { entry: read.entry, path };
  const real = realUpToWildcard(path);
  if (real !== undefined && real !== path) rule.real = real;
  return rule;
}

/** `path` with the symbolic links of its folders before the first wildcard resolved. */
function realUpToWildcard(path: string): string | undefined {
  const star = path.indexOf("*");
  if (star < 0) return tryRealpath(path);
  const cut = Math.max(path.lastIndexOf("/", star), path.lastIndexOf("\\", star));
  if (cut <= 0) return undefined;
  const real = tryRealpath(path.slice(0, cut));
  return real === undefined ? undefined : `${real}${path.slice(cut)}`;
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
        exclude: config.capture.exclude
          .map((e) => excludeRule(e, host.home))
          .filter((r): r is ExcludeRule => r !== undefined),
      },
      theme: config.theme,
    };
  } catch (err) {
    return { rules: DEFAULT_RULES, error: (err as Error).message };
  }
}

/** The rules, from `rules.json` when the CLI config has not changed since it was written, else
 * loaded again (and the cache rewritten), with the server's exclude list (the copy the uploader
 * fetched last) ahead of this machine's own. */
export async function captureRules(host: CaptureHost, paths: CapturePaths): Promise<RulesSnapshot> {
  return withServerExcludes(await localRules(host, paths), paths, host.home);
}

async function localRules(host: CaptureHost, paths: CapturePaths): Promise<RulesSnapshot> {
  const key = keyOf(host);
  const cached = tryReadJson(paths.rules) as CacheFile | null | undefined;
  if (cached?.schema === CACHE_SCHEMA && sameKey(cached.key, key)) return cached.snapshot;
  const snapshot = await loadRules(host);
  const file: CacheFile = { schema: CACHE_SCHEMA, key, snapshot };
  tryWritePrivateFile(paths.rules, JSON.stringify(file));
  return snapshot;
}

/** `snapshot` with the server's exclude list first: the org's list and this machine's are one
 * list, and an entry from either turns capture off; the server's is named first. */
export function withServerExcludes(
  snapshot: RulesSnapshot,
  paths: CapturePaths,
  home: string,
): RulesSnapshot {
  const exclude = readOrgRules(paths)?.exclude ?? [];
  const server = exclude
    .map((e) => excludeRule(e, home))
    .filter((r): r is ExcludeRule => r !== undefined)
    .map((r): ExcludeRule => ({ ...r, from: "server" }));
  if (server.length === 0) return snapshot;
  return {
    ...snapshot,
    rules: { ...snapshot.rules, exclude: [...server, ...snapshot.rules.exclude] },
  };
}
