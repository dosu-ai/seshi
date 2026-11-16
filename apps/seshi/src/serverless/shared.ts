import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BaseLayer, ConfigError, DEFAULT_BASE_URLS, parseConfigToml } from "@seshi/config";
import { VERSION } from "@seshi/model";
import { accessDeniedIn, type Store } from "@seshi/store";
import { writePrivateFile } from "../account/secrets";
import type { ServerlessPaths } from "./settings";

/** The bucket's shared settings live under this prefix (F11.6). */
export const SHARED_PREFIX = "config/";
export const SHARED_CONFIG = "seshi.toml";
/** How long a cached copy is used before the bucket is asked again. */
export const SHARED_MAX_AGE_MS = 5 * 60 * 1000;

/** The providers' own endpoints: the only ones a shared config may send a key to. */
const PROVIDER_ENDPOINTS = new Set(Object.values(DEFAULT_BASE_URLS));

const SAFE_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

interface SharedIndex {
  url: string;
  /** When the bucket was last asked. */
  checked_at?: string;
  /** The good copy in the cache: each file under `config/` and its ETag. */
  files: Record<string, string>;
  /** The last copy that failed the checks, so it is not fetched and checked again on every
   * command; the good copy stays in use. */
  rejected?: {
    files: Record<string, string>;
    message: string;
    at: string;
    version?: string;
    /** `SharedOptions.local` when it was rejected. */
    local?: string;
  };
}

export interface SharedSettings {
  /** `config/seshi.toml`, parsed, its relative paths made to point into the cache; undefined
   * when the bucket has none. */
  base?: BaseLayer;
  /** The files under `config/`, relative to it. */
  files: string[];
  /** When the bucket was last asked. */
  checkedAt?: string;
  /** The bucket's current copy failed the checks; the cached one is in use. */
  problem?: string;
  /** The bucket could not be asked; the cached copy, if any, is in use. */
  unreachable?: string;
  /** The bucket holds shared settings and this machine has no copy it can use: it failed the
   * checks and there was no good one before, or the cache is gone. Writes wait (F11.6). */
  unusable?: string;
  /** Whether a copy came from the bucket this time. */
  refreshed: boolean;
}

export interface SharedOptions {
  now?: () => Date;
  maxAgeMs?: number;
  /** Ask the bucket even when the cached copy is fresh. */
  force?: boolean;
  /** The checks `seshi serve` runs at start, on a candidate copy (F11.6); throws to reject it. */
  check?: (base: BaseLayer | undefined) => Promise<void>;
  /** A fingerprint of what on this machine `check` also reads (the local config file,
   * `SESHI_*` settings, `--set`): a copy rejected under other local settings is checked
   * again. */
  local?: string;
}

function readIndex(paths: ServerlessPaths, url: string): SharedIndex {
  try {
    const parsed = JSON.parse(readFileSync(paths.sharedIndex, "utf8")) as Partial<SharedIndex>;
    if (parsed.url === url && parsed.files && typeof parsed.files === "object") {
      return parsed as SharedIndex;
    }
  } catch {}
  return { url, files: {} };
}

function writeIndex(paths: ServerlessPaths, index: SharedIndex): void {
  writePrivateFile(paths.sharedIndex, `${JSON.stringify(index, null, 2)}\n`);
}

function same(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A secret read from a file is the laptop's own: a shared config may not name one. */
function fileSecrets(value: unknown, path: string[], found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      fileSecrets(v, [...path, String(i)], found);
    });
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "file") found.push(path.join("."));
    else for (const [k, v] of Object.entries(value)) fileSecrets(v, [...path, k], found);
  }
}

/** `config/seshi.toml` from a copy of the folder, with the paths it names relative to
 * `config/` (redaction packs, review prompt files) made absolute into that copy. A path must
 * stay inside the copy, no secret may be read from a file (a shared config names nothing on
 * the laptop), and a policy with a key may name no endpoint but its provider's (a key from a
 * laptop's environment goes nowhere the shared config chose). */
export function baseLayerIn(dir: string, origin: string): BaseLayer | undefined {
  const file = join(dir, SHARED_CONFIG);
  if (!existsSync(file)) return undefined;
  const tree = parseConfigToml(origin, readFileSync(file, "utf8"));
  const problems: string[] = [];
  const local = (path: unknown, where: string) => {
    if (typeof path !== "string") return path;
    const inside = resolve(dir, path);
    const rel = relative(resolve(dir), inside);
    if (
      isAbsolute(path) ||
      path.startsWith("~") ||
      rel.startsWith("..") ||
      rel.split(sep)[0] === ".."
    ) {
      problems.push(`${where}: ${JSON.stringify(path)} is outside config/; name a file in it`);
      return path;
    }
    return inside;
  };
  const named: string[] = [];
  fileSecrets(tree, [], named);
  for (const where of named) {
    problems.push(
      `${where}: a secret read from a file names a path on each laptop; use { env = "NAME" }`,
    );
  }
  const redaction = tree.redaction as { packs?: unknown } | undefined;
  if (redaction && Array.isArray(redaction.packs)) {
    redaction.packs = redaction.packs.map((p, i) => local(p, `redaction.packs.${i}`));
  }
  const review = tree.review as { policies?: unknown } | undefined;
  if (review && Array.isArray(review.policies)) {
    (review.policies as Record<string, Record<string, unknown>>[]).forEach((policy, i) => {
      const keyed = ["decision", "redactor"].some((step) => {
        const s = policy?.[step];
        return !!s && typeof s === "object" && "api_key" in s;
      });
      for (const step of ["decision", "redactor"]) {
        const s = policy?.[step];
        if (!s || typeof s !== "object") continue;
        if ("prompt_file" in s) {
          s.prompt_file = local(s.prompt_file, `review.policies.${i}.${step}.prompt_file`);
        }
        if (keyed && typeof s.base_url === "string" && !PROVIDER_ENDPOINTS.has(s.base_url)) {
          problems.push(
            `review.policies.${i}.${step}.base_url: a shared config may not send each laptop's key to an endpoint it names; leave base_url unset, or set this policy in each laptop's own config (serverless.config)`,
          );
        }
      }
    });
  }
  if (problems.length > 0) throw new ConfigError(problems.map((p) => `${origin}: ${p}`));
  return { path: origin, tree };
}

/** A name under `config/` a laptop or `seshi admin config` will read or write: a relative
 * path of plain names, none of them `.` or `..`, so it stays inside the folder it lands in. */
export function safeSharedName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.split("/").some((part) => part === ".." || part === ".");
}

/** Each object under `config/` with a safe name (`safeSharedName`), by its name there. */
export async function listSharedKeys(store: Store): Promise<{ name: string; etag?: string }[]> {
  const out: { name: string; etag?: string }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(SHARED_PREFIX, { startAfter: after, details: true });
    const objects = page.objects ?? page.keys.map((key) => ({ key, etag: undefined }));
    for (const { key, etag } of objects) {
      const name = key.slice(SHARED_PREFIX.length);
      if (safeSharedName(name)) out.push({ name, ...(etag ? { etag } : {}) });
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return out;
  }
}

/** Each shared file and its version: the ETag the listing gives (S3 does), else one `stat`. */
async function listShared(store: Store): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const { name, etag } of await listSharedKeys(store)) {
    if (etag) {
      files[name] = etag;
      continue;
    }
    const stat = await store.stat(`${SHARED_PREFIX}${name}`);
    if (stat) files[name] = stat.etag ?? stat.modified ?? "";
  }
  return files;
}

/** The bucket's shared settings, from the cache when it is fresh, else from the bucket
 * (F11.6). A copy that fails `check` is not used: the last good one stays, and `problem`
 * says why. When the bucket cannot be reached the cache is used and `unreachable` says why. */
export async function sharedSettings(
  store: Store,
  paths: ServerlessPaths,
  options: SharedOptions = {},
): Promise<SharedSettings> {
  const now = (options.now ?? (() => new Date()))();
  const index = readIndex(paths, store.url);
  const origin = (name: string) => `${store.url}/${SHARED_PREFIX}${name}`;
  const fromCache = (extra: Partial<SharedSettings>, listed?: Record<string, string>) => {
    let base: BaseLayer | undefined;
    let unusable: string | undefined;
    const hasConfig = SHARED_CONFIG in index.files;
    if (hasConfig) {
      try {
        base = baseLayerIn(paths.shared, origin(SHARED_CONFIG));
        if (!base) unusable = "the cached copy of the shared settings is gone";
      } catch (err) {
        unusable = message(err);
      }
    }
    const bucketHas = listed ? SHARED_CONFIG in listed : hasConfig || index.rejected !== undefined;
    if (!base && bucketHas && unusable === undefined && index.rejected) {
      unusable = index.rejected.message;
    }
    const settings: SharedSettings = {
      ...(base ? { base } : {}),
      files: Object.keys(index.files).sort(),
      ...(index.checked_at ? { checkedAt: index.checked_at } : {}),
      ...(index.rejected ? { problem: index.rejected.message } : {}),
      ...(unusable !== undefined ? { unusable } : {}),
      refreshed: false,
      ...extra,
    };
    return settings;
  };
  const age = index.checked_at ? now.getTime() - Date.parse(index.checked_at) : Infinity;
  const cacheBroken =
    SHARED_CONFIG in index.files && !existsSync(join(paths.shared, SHARED_CONFIG));
  if (!options.force && !cacheBroken && age < (options.maxAgeMs ?? SHARED_MAX_AGE_MS)) {
    return fromCache({});
  }

  let listed: Record<string, string>;
  try {
    listed = await listShared(store);
  } catch (err) {
    if (accessDeniedIn(err)) throw err;
    return fromCache({ unreachable: message(err) });
  }
  const checkedAt = now.toISOString();
  const rejectedHere =
    index.rejected !== undefined &&
    same(listed, index.rejected.files) &&
    (index.rejected.version ?? VERSION) === VERSION &&
    index.rejected.local === options.local;
  if ((same(listed, index.files) && !cacheBroken) || rejectedHere) {
    index.checked_at = checkedAt;
    writeIndex(paths, index);
    return fromCache({ checkedAt }, listed);
  }

  const next = `${paths.shared}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o700 });
  try {
    for (const name of Object.keys(listed)) {
      const object = await store.get(`${SHARED_PREFIX}${name}`);
      if (object === null) continue;
      const file = join(next, name);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, object.body, { mode: 0o600 });
    }
  } catch (err) {
    rmSync(next, { recursive: true, force: true });
    if (accessDeniedIn(err)) throw err;
    return fromCache({ unreachable: message(err) }, listed);
  }
  try {
    const base = baseLayerIn(next, origin(SHARED_CONFIG));
    await options.check?.(base);
  } catch (err) {
    rmSync(next, { recursive: true, force: true });
    index.checked_at = checkedAt;
    index.rejected = {
      files: listed,
      message: message(err),
      at: checkedAt,
      version: VERSION,
      ...(options.local !== undefined ? { local: options.local } : {}),
    };
    writeIndex(paths, index);
    return fromCache({ checkedAt }, listed);
  }
  const old = `${paths.shared}.old-${process.pid}`;
  rmSync(old, { recursive: true, force: true });
  try {
    if (existsSync(paths.shared)) renameSync(paths.shared, old);
    renameSync(next, paths.shared);
  } catch (err) {
    rmSync(next, { recursive: true, force: true });
    return fromCache({ unreachable: `another seshi was refreshing the cache: ${message(err)}` });
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
  const saved: SharedIndex = { url: store.url, checked_at: checkedAt, files: listed };
  writeIndex(paths, saved);
  const base = baseLayerIn(paths.shared, origin(SHARED_CONFIG));
  return {
    ...(base ? { base } : {}),
    files: Object.keys(listed).sort(),
    checkedAt,
    refreshed: true,
  };
}
