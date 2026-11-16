import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CliConfig } from "@seshi/config";
import {
  type BaseLayer,
  ConfigError,
  DEFAULT_BASE_URLS,
  type FlagValue,
  formatPath,
  loadServerlessConfig,
  resolveSteps,
  type ServerConfig,
  secretsIn,
} from "@seshi/config";
import { buildInstance, type Instance, readRedactionPacks } from "@seshi/instance";
import type { Integration } from "@seshi/kit";
import { type LayoutMarker, type OwnerBasis, type StorageView, VERSION } from "@seshi/model";
import { noHealth, type Reviewer } from "@seshi/pipeline";
import { ProviderError, providerFactory, reviewerFromConfig } from "@seshi/review";
import { SearchService } from "@seshi/search";
import {
  FsStore,
  NoLayout,
  openStore,
  readLayout,
  type StorageTestResult,
  type Store,
  storageTest,
  versionAtLeast,
} from "@seshi/store";
import type { SecretBackend } from "../account/secrets";
import { writePrivateFile } from "../account/secrets";
import { EXIT } from "../cli/exit";
import { Refused } from "../cli/failures";
import { buildFormats } from "../integrations";
import { readBucketKey, readReviewKey } from "./keys";
import { refusalOf } from "./refusal";
import {
  expandHome,
  homeFor,
  type ServerlessPaths,
  type ServerlessSettings,
  serverlessOf,
  serverlessOwner,
  serverlessPaths,
} from "./settings";
import { type SharedSettings, sharedSettings } from "./shared";

export { refusalOf, refusedMessage } from "./refusal";

/** How the owner of a serverless session was established (F11.4): nothing seshi controls
 * checked the name. */
export const SERVERLESS_BASIS: OwnerBasis = "claimed";

/** How often the storage test runs again (F11). */
export const STORAGE_TEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A review policy whose key cannot be found on this machine. */
export interface MissingReviewKey {
  policy: string;
  provider: string;
  /** The environment variable the policy's `api_key` names, when it names one. */
  env?: string;
}

export interface ServerlessOpenOptions {
  cli: CliConfig;
  env: Record<string, string | undefined>;
  home?: string;
  integrations: readonly Integration[];
  /** Where the bucket key and review keys are kept; none read when omitted. */
  secrets?: SecretBackend;
  /** The command writes: below the bucket's minimum version it is refused, the owner's folder
   * is probed, and a missing review key under `review.required` holds it. */
  write: boolean;
  /** `--set` values, applied last. */
  flags?: readonly FlagValue[];
  /** Keep a search index (`[search] enabled`, else the shared config's). */
  search?: boolean;
  /** Run the storage test now when the cached result is older than a day (writes only). */
  storageTest?: boolean;
  /** Refresh the shared settings even when the cache is fresh. */
  refreshShared?: boolean;
  now?: () => Date;
  /** For tests: the bucket, already open. */
  store?: Store;
  log?: (line: string) => void;
}

export interface ServerlessBucket {
  instance: Instance;
  owner: string;
  marker: LayoutMarker;
  settings: ServerlessSettings;
  paths: ServerlessPaths;
  shared: SharedSettings;
  /** Settings this mode ignores, by where they were set. */
  ignored: string[];
  /** What the person should know: an old seshi, a bucket in server mode, the old `[local]`. */
  warnings: string[];
  review: { required: boolean; missing: MissingReviewKey[] };
  /** This seshi is at or above the bucket's minimum version. */
  writable: boolean;
  /** The storage test's last result for this bucket, when there is one. */
  storage?: StorageTestResult;
  close(): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function missingKeyMessage(missing: readonly MissingReviewKey[]): string {
  const first = missing[0] as MissingReviewKey;
  const setIt = first.env ? `Set ${first.env}, or store a key with` : "Store a key with";
  return [
    `this team requires model review, and no key for ${first.provider} is set.`,
    "Sessions are kept on this machine until one is: nothing has been uploaded unreviewed.",
    `  ${setIt}: seshi review key set ${first.provider}`,
    "  Then check with: seshi doctor",
  ].join("\n");
}

function storeFlags(settings: ServerlessSettings): FlagValue[] {
  const flags: FlagValue[] = [];
  const add = (name: string, path: string, value: string | undefined) => {
    if (value !== undefined) flags.push({ name, path, value });
  };
  add("serverless.url", "store.url", settings.url);
  add("serverless.region", "store.region", settings.region);
  add("serverless.endpoint", "store.endpoint", settings.endpoint);
  add("serverless.account_id", "store.account_id", settings.account_id);
  return flags;
}

interface Resolved {
  config: ServerConfig;
  ignored: string[];
  missing: MissingReviewKey[];
}

/** Load the server config as a serverless laptop sees it, resolve its secrets, and say which
 * review policies have no key here. Review keys stored with `seshi review key set` fill the
 * environment variables policies name. */
async function resolveConfig(
  options: ServerlessOpenOptions,
  settings: ServerlessSettings,
  base: BaseLayer | undefined,
): Promise<Resolved> {
  const home = homeFor(options.env, options.home);
  const file = settings.config !== undefined ? expandHome(settings.config, home) : undefined;
  const flags = [...storeFlags(settings), ...(options.flags ?? [])];
  const first = loadServerlessConfig({
    ...(base ? { base } : {}),
    ...(file !== undefined ? { file } : {}),
    env: options.env,
    flags,
    resolveSecrets: false,
  });
  const env = { ...options.env };
  const policies = first.config.review.policies;
  for (const policy of policies) {
    const steps = resolveSteps(policy);
    for (const step of [steps.decision, steps.redactor]) {
      const ref = step.api_key?.ref;
      if (ref?.kind !== "env" || env[ref.name]) continue;
      // A stored key goes only to the provider's own endpoint, never to one a shared config
      // names.
      if (step.base_url !== DEFAULT_BASE_URLS[step.provider]) continue;
      const stored = options.secrets ? await readReviewKey(options.secrets, step.provider) : null;
      if (stored) env[ref.name] = stored;
    }
  }
  const missing: MissingReviewKey[] = [];
  const problems: string[] = [];
  const readFile = (path: string) => readFileSync(path, "utf8");
  for (const { path, secret } of secretsIn(first.config)) {
    try {
      secret.resolve({ env, readFile });
    } catch (err) {
      if (path[0] === "review" && path[1] === "policies" && typeof path[2] === "number") {
        const policy = policies[path[2]];
        if (policy) {
          const step = resolveSteps(policy)[path[3] === "redactor" ? "redactor" : "decision"];
          const env = secret.ref.kind === "env" ? secret.ref.name : undefined;
          if (!missing.some((m) => m.policy === policy.id && m.provider === step.provider)) {
            missing.push({
              policy: policy.id,
              provider: step.provider,
              ...(env ? { env } : {}),
            });
          }
          continue;
        }
      }
      problems.push(`${formatPath(path)}: ${message(err)}`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return { config: first.config, ignored: first.ignored, missing };
}

/** What on this machine the shared settings' check reads besides the shared copy: the local
 * config file, `SESHI_*` settings and `--set` values. */
function localFingerprint(options: ServerlessOpenOptions, settings: ServerlessSettings): string {
  const file =
    settings.config !== undefined
      ? expandHome(settings.config, homeFor(options.env, options.home))
      : undefined;
  let text: string | null = null;
  if (file !== undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch {}
  }
  const seshiEnv = Object.entries(options.env)
    .filter(([name, value]) => name.startsWith("SESHI_") && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify({ file, text, env: seshiEnv, flags: options.flags ?? [] }))
    .digest("hex")
    .slice(0, 16);
}

/** A reviewer whose policies without a key here fail at once, as a model that cannot be
 * reached would, with no retries, and so are stored as `skipped` (F11: `review.required =
 * false`). */
async function reviewerFor(
  config: ServerConfig,
  missing: readonly MissingReviewKey[],
  log: (line: string) => void,
): Promise<Reviewer | undefined> {
  if (config.review.policies.length === 0) return undefined;
  const keyless = new Set(missing.map((m) => m.policy));
  const policies = config.review.policies.map((p) =>
    keyless.has(p.id) ? { ...p, on_failure: "skip" as const, retries: 0 } : p,
  );
  const real = providerFactory();
  return reviewerFromConfig(
    { review: { policies } },
    {
      providers: (step, role, policy) => {
        if (!keyless.has(policy)) return real(step, role, policy);
        return {
          kind: step.provider,
          model: step.model,
          endpoint: step.base_url ?? "",
          complete: async () => {
            throw new ProviderError("no_key", false, `no ${step.provider} key on this machine`);
          },
        };
      },
      log: { warn: log },
    },
  );
}

function settingsOf(cli: CliConfig): ServerlessSettings {
  const settings = serverlessOf(cli);
  if (!settings) {
    throw new Refused(EXIT.config, "not_configured", "no [serverless] bucket in the CLI config");
  }
  return settings;
}

function noBucket(url: string): Refused {
  return new Refused(
    EXIT.config,
    "no_bucket",
    `no seshi bucket at ${url}: run seshi init --serverless`,
  );
}

/** What a seshi below the bucket's minimum version is told (F11.7). */
export function needsUpdate(minVersion: string): string {
  return `this bucket needs seshi ${minVersion} or newer; you have ${VERSION}. Update seshi, then try again.`;
}

/** The bucket URL the CLI config names: `serverless.url`, else the local config's `[store]`. */
export function serverlessBucketUrl(
  cli: CliConfig,
  env: Record<string, string | undefined>,
  home?: string,
): string {
  const settings = settingsOf(cli);
  if (settings.url !== undefined) return settings.url;
  const file = expandHome(settings.config as string, homeFor(env, home));
  return loadServerlessConfig({ file, env, resolveSecrets: false }).config.store.url;
}

/** This machine's drop and failure records for the CLI config's bucket (F11.10). */
export function serverlessRecords(
  cli: CliConfig,
  env: Record<string, string | undefined>,
  home?: string,
): FsStore {
  const url = serverlessBucketUrl(cli, env, home);
  return new FsStore(serverlessPaths(env, homeFor(env, home), url).records);
}

function readStorageTest(paths: ServerlessPaths): StorageTestResult | undefined {
  try {
    return JSON.parse(readFileSync(paths.storageTest, "utf8")) as StorageTestResult;
  } catch {
    return undefined;
  }
}

/** Run the storage test and keep its result for this bucket. */
export async function runStorageTest(
  store: Store,
  owner: string,
  paths: ServerlessPaths,
  now?: () => Date,
): Promise<StorageTestResult> {
  const result = await storageTest(store, owner, now ? { now } : {});
  writePrivateFile(paths.storageTest, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function storageRefusal(url: string, result: StorageTestResult): Refused {
  return new Refused(
    EXIT.config,
    "store_unsupported",
    `${url}: ${result.missing ?? "conditional writes failed"}; seshi can't use this store`,
  );
}

/** The bucket a server config's `[store]` names, with the key `[store].credentials` gives,
 * else the one `seshi init --serverless` stored, else the store's environment fallbacks. */
export async function openBucketStore(
  config: Pick<ServerConfig, "store">,
  secrets: SecretBackend | undefined,
  env: Record<string, string | undefined>,
): Promise<{ store: Store; storage: StorageView }> {
  const { url } = config.store;
  const key = secrets ? await readBucketKey(secrets, url) : undefined;
  const fromConfig = config.store.credentials;
  const credentials = fromConfig
    ? {
        accessKeyId: fromConfig.access_key_id.reveal(),
        secretAccessKey: fromConfig.secret_access_key.reveal(),
        ...(fromConfig.session_token ? { sessionToken: fromConfig.session_token.reveal() } : {}),
      }
    : key
      ? {
          accessKeyId: key.access_key_id,
          secretAccessKey: key.secret_access_key,
          ...(key.session_token ? { sessionToken: key.session_token } : {}),
        }
      : undefined;
  try {
    return openStore(url, {
      ...(config.store.region ? { region: config.store.region } : {}),
      ...(config.store.endpoint ? { endpoint: config.store.endpoint } : {}),
      ...(config.store.account_id ? { accountId: config.store.account_id } : {}),
      ...(credentials ? { credentials } : {}),
      env,
    });
  } catch (err) {
    throw new Refused(EXIT.config, "config", message(err));
  }
}

/** The CLI config's serverless bucket, opened with its key, without reading anything in it:
 * for `seshi admin` and `seshi init --serverless`. */
export async function openServerlessStore(options: {
  cli: CliConfig;
  env: Record<string, string | undefined>;
  home?: string;
  secrets?: SecretBackend;
  flags?: readonly FlagValue[];
}): Promise<{ store: Store; storage: StorageView; owner: string; paths: ServerlessPaths }> {
  const settings = settingsOf(options.cli);
  const home = homeFor(options.env, options.home);
  const file = settings.config !== undefined ? expandHome(settings.config, home) : undefined;
  const loaded = loadServerlessConfig({
    ...(file !== undefined ? { file } : {}),
    env: options.env,
    flags: [...storeFlags(settings), ...(options.flags ?? [])],
    resolveSecrets: false,
  });
  for (const { path, secret } of secretsIn(loaded.config.store)) {
    try {
      secret.resolve({ env: options.env, readFile: (p) => readFileSync(p, "utf8") });
    } catch (err) {
      throw new ConfigError([`store.${formatPath(path)}: ${message(err)}`]);
    }
  }
  const opened = await openBucketStore(loaded.config, options.secrets, options.env);
  return {
    ...opened,
    owner: serverlessOwner(options.cli, options.env),
    paths: serverlessPaths(options.env, home, loaded.config.store.url),
  };
}

/** Open a serverless bucket (F11, "Opening the bucket"): read its marker, compare the minimum
 * version and the mode, load the shared settings, and build the instance this machine runs
 * the pipeline in. */
export async function openServerless(options: ServerlessOpenOptions): Promise<ServerlessBucket> {
  const settings = settingsOf(options.cli);
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const home = homeFor(options.env, options.home);
  const owner = serverlessOwner(options.cli, options.env);
  const warnings: string[] = [];
  if (settings.oldName) {
    warnings.push(
      "[local] is the old name of [serverless]: seshi config check prints the new table",
    );
  }

  const local = await resolveConfig(options, settings, undefined);
  const url = local.config.store.url;
  const paths = serverlessPaths(options.env, home, url);

  const { store, storage } = options.store
    ? { store: options.store, storage: { url: options.store.url } }
    : await openBucketStore(local.config, options.secrets, options.env);

  let marker: LayoutMarker | null;
  try {
    marker = await readLayout(store);
  } catch (err) {
    throw refusalOf(err, owner);
  }
  if (marker === null) {
    throw noBucket(url);
  }
  const writable = marker.min_version === undefined || versionAtLeast(VERSION, marker.min_version);
  if (!writable) {
    const needs = needsUpdate(marker.min_version as string);
    if (options.write) throw new Refused(EXIT.config, "needs_update", needs);
    warnings.push(needs);
  }
  if (marker.mode === "server") {
    warnings.push(
      `${url} is in server mode: laptops should upload through the server (seshi login --server), not write it directly`,
    );
  }

  let shared: SharedSettings;
  try {
    shared = await sharedSettings(store, paths, {
      now,
      local: localFingerprint(options, settings),
      ...(options.refreshShared ? { force: true } : {}),
      check: async (base) => {
        const candidate = await resolveConfig(options, settings, base);
        await readRedactionPacks(candidate.config.redaction.packs);
      },
    });
  } catch (err) {
    const refused = refusalOf(err, owner);
    if (options.write || !(refused instanceof Refused)) throw refused;
    warnings.push(`cannot read the shared settings: ${refused.message}`);
    shared = { files: [], refreshed: false };
  }
  if (shared.problem) warnings.push(`the shared settings fail their checks: ${shared.problem}`);
  if (shared.unusable) {
    const why = `${url} has shared settings this machine can't use (${shared.unusable}); fix them (seshi admin config pull, push) or update seshi`;
    if (options.write)
      throw new Refused(EXIT.config, "shared_settings", `${why}. Uploads wait until then.`);
    warnings.push(why);
  }
  if (shared.unreachable && shared.files.length === 0 && options.write && !shared.checkedAt) {
    throw new Refused(
      EXIT.unavailable,
      "unavailable",
      `cannot read the shared settings in ${url}: ${shared.unreachable}`,
    );
  }
  const resolved = shared.base ? await resolveConfig(options, settings, shared.base) : local;
  const config = resolved.config;
  const required = config.review.required;
  if (options.write && required && resolved.missing.length > 0) {
    throw new Refused(EXIT.config, "needs_review_key", missingKeyMessage(resolved.missing));
  }
  const reviewer = options.write ? await reviewerFor(config, resolved.missing, log) : undefined;

  const searchOn = options.search ?? options.cli.search.enabled ?? config.search.enabled;
  const scope = options.cli.search.scope;
  const records = new FsStore(paths.records);

  let instance: Instance;
  try {
    instance = await buildInstance(config, {
      store: { store, storage },
      formats: buildFormats(options.integrations),
      integrations: options.integrations,
      env: options.env,
      roles: [],
      probe: options.write ? [owner] : [],
      initialize: false,
      claimOrg: false,
      health: noHealth(),
      records,
      createLayout: false,
      reviewer: reviewer ?? { review: async () => ({ action: "allow" }) },
      ...(options.now ? { now: options.now } : {}),
      search: searchOn
        ? new SearchService({
            store,
            deployment: marker.deployment_id,
            scope: scope === "all" ? "all" : `${scope}:${owner}`,
            settings: {
              ...(config.search.path ? { path: config.search.path } : {}),
              events: config.search.events,
            },
            ...(options.now ? { now: options.now } : {}),
            indexer: {
              ...(scope === "mine" ? { owners: [owner] } : {}),
              ...(scope === "visible"
                ? {
                    admit: (s: { owner: string; visibility?: string }) =>
                      s.owner === owner || (s.visibility ?? "org") === "org",
                  }
                : {}),
            },
          })
        : null,
    });
  } catch (err) {
    if (err instanceof NoLayout) {
      throw noBucket(url);
    }
    throw refusalOf(err, owner);
  }

  let storage_ = readStorageTest(paths);
  if (options.write && options.storageTest !== false) {
    const age = storage_ ? now().getTime() - Date.parse(storage_.at) : Infinity;
    if (!(age < STORAGE_TEST_MAX_AGE_MS)) {
      try {
        storage_ = await runStorageTest(store, owner, paths, now);
      } catch (err) {
        await instance.close();
        throw refusalOf(err, owner);
      }
    }
    if (storage_ && !storage_.conditionalWrites) {
      await instance.close();
      throw storageRefusal(url, storage_);
    }
  }

  return {
    instance,
    owner,
    marker,
    settings,
    paths,
    shared,
    ignored: resolved.ignored,
    warnings,
    review: { required, missing: resolved.missing },
    writable,
    ...(storage_ ? { storage: storage_ } : {}),
    close: () => instance.close(),
  };
}
