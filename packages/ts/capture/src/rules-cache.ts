import { cliConfigPath, NOT_SETTINGS_ENV } from "@seshi/config/paths";
import type { CaptureHost } from "@seshi/kit";
import { expandTilde } from "@seshi/kit";
import { readExcludeEntry } from "@seshi/model/exclude";
import { tryReadJson, tryRealpath, tryStat, tryWritePrivateFile } from "./files";
import { type LabelRules, labelRules } from "./labels";
import { readOrgRules } from "./org-rules";
import type { CapturePaths } from "./paths";
import { type CaptureRules, DEFAULT_RULES, type ExcludeRule, type PathRule } from "./rules";

// 2: rules gained `exclude`. A cache written before it would hide a new exclude list, or keep the
// error an older seshi gave for the unknown key, until the config file changed.
// 3: the snapshot gained `labels`.
// 4: rules gained `redactToolCalls`, for the same reason as 2.
const CACHE_SCHEMA = "seshi/capture-rules/4";

export interface RulesSnapshot {
  rules: CaptureRules;
  /** The config cannot be loaded: nothing is captured until it is fixed. */
  error?: string;
  theme?: "auto" | "dark" | "light";
  /** `[labels]`, unresolved: a hook resolves them with the agent's environment. */
  labels?: LabelRules;
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

function placeEntries(entries: readonly string[], home: string): ExcludeRule[] {
  return entries.map((e) => excludeRule(e, home)).filter((r): r is ExcludeRule => r !== undefined);
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
        exclude: placeEntries(config.capture.exclude, host.home),
        redactToolCalls: placeEntries(config.capture.redact_tool_calls, host.home),
      },
      theme: config.theme,
      labels: labelRules(config.labels, host.home),
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

/** An exclude list read for this machine (`~` expanded under `home`). */
export function compileExcludes(
  exclude: readonly string[],
  home: string,
): { home: string; rules: ExcludeRule[] } {
  return {
    home,
    rules: exclude
      .map((e) => excludeRule(e, home))
      .filter((r): r is ExcludeRule => r !== undefined),
  };
}

/** `snapshot` with the server's lists first: the org's exclude list and this machine's are one
 * list, and an entry from either turns capture off; so are the two tool-call redaction lists, and
 * an entry from either redacts. The server's entries are named first. */
export function withServerExcludes(
  snapshot: RulesSnapshot,
  paths: CapturePaths,
  home: string,
): RulesSnapshot {
  const copy = readOrgRules(paths);
  if (!copy?.exclude) return snapshot;
  // Read for this machine when it was fetched; again only for another home.
  const compiled = copy.compiled?.home === home ? copy.compiled : undefined;
  const rules = compiled?.rules ?? compileExcludes(copy.exclude, home).rules;
  const redact = compiled?.redact ?? compileExcludes(copy.redact_tool_calls ?? [], home).rules;
  // The last copy fetched, whichever server it came from: after a change of server the old list
  // goes on applying (named for its server) until the new one's is fetched.
  const fromServer = (r: ExcludeRule): ExcludeRule => ({
    ...r,
    from: "server",
    server: copy.server,
  });
  if (rules.length === 0 && redact.length === 0) return snapshot;
  return {
    ...snapshot,
    rules: {
      ...snapshot.rules,
      exclude: [...rules.map(fromServer), ...snapshot.rules.exclude],
      redactToolCalls: [...redact.map(fromServer), ...(snapshot.rules.redactToolCalls ?? [])],
    },
  };
}
