/** `seshi serve` (`bun start`): the server, configured by `@seshi/config` (F1): flags, then
 * `SESHI_*` env, then the TOML file (`--config`, `SESHI_CONFIG`, `./seshi.toml`,
 * `/etc/seshi/seshi.toml`), then defaults. Bun reads `.env` on its own. Changes apply on
 * restart (F1.5). docs/config.md lists every setting.
 *
 *   seshi serve [--config <file>] [--listen <host:port>] [--roles api,worker] [--set path=value]… */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createApp } from "@seshi/api";
import { ConfigError, filterFor, loadServerConfig } from "@seshi/config";
import type { FormatRegistry } from "@seshi/formats";
import { VERSION } from "@seshi/model";
import { StoreHealthCounters } from "@seshi/pipeline";
import {
  parseRedactionConfig,
  type RedactionConfig,
  type RedactionRules,
  redactionRules,
} from "@seshi/redact";
import {
  ensureLayout,
  LayoutError,
  openStore,
  probe,
  type StorageView,
  type Store,
} from "@seshi/store";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";
import { configFlags, ServeConfigError, serveSettings } from "./serve-settings";

export { ServeConfigError, serveSettings } from "./serve-settings";

function fail(message: string): never {
  throw new ServeConfigError(message);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The operator's rule packs, each checked on its own (so a bad pattern names its file), then
 * merged on top of the built-in rules. Today's JSON file is a pack (F2.1). */
async function readPacks(paths: readonly string[]): Promise<RedactionRules | undefined> {
  if (paths.length === 0) return undefined;
  const merged: Required<RedactionConfig> = {
    patterns: [],
    sensitive_files: [],
    secret_commands: [],
  };
  for (const path of paths) {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (err) {
      fail(`cannot read redaction pack ${path}: ${message(err)}`);
    }
    try {
      parseRedactionConfig(text);
    } catch (err) {
      fail(`${path}: ${message(err)}`);
    }
    const pack = JSON.parse(text) as RedactionConfig;
    merged.patterns.push(...(pack.patterns ?? []));
    merged.sensitive_files.push(...(pack.sensitive_files ?? []));
    merged.secret_commands.push(...(pack.secret_commands ?? []));
  }
  return redactionRules(merged);
}

/** Load the config, read the rule packs, open the bucket, check it can be written, then serve
 * until a signal. Every failure before serving is a `ServeConfigError` or `ConfigError`. */
async function start(ctx: CommandContext, formats: FormatRegistry): Promise<void> {
  let values: { config?: string; listen?: string; roles?: string; set?: string[] };
  try {
    ({ values } = parseArgs({
      args: ctx.argv,
      options: {
        config: { type: "string" },
        listen: { type: "string" },
        roles: { type: "string" },
        set: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    fail(message(err));
  }
  const loaded = loadServerConfig({
    configFlag: values.config,
    env: ctx.env,
    flags: configFlags(values),
  });
  for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
  const settings = serveSettings(loaded.config);
  const { tokens, tokenSecret, owners, url } = settings;
  const client = `seshi/${VERSION}`;

  const redaction = await readPacks(settings.redactionPacks);

  let store: Store;
  let storage: StorageView;
  try {
    ({ store, storage } = openStore(url, { ...settings.store, env: ctx.env }));
  } catch (err) {
    fail(message(err));
  }

  // Fail at boot, not on the first session, when the bucket or its keys are wrong, or the
  // prefix is another deployment's (X1.4) or a sessiondb store.
  let deployment: string;
  try {
    const marker = await ensureLayout(store, {
      createdBy: client,
      deploymentId: settings.deploymentId,
      org: settings.org,
    });
    deployment = marker.deployment_id;
    for (const owner of owners) await probe(store, owner);
  } catch (err) {
    if (err instanceof LayoutError) fail(`cannot use ${url}: ${message(err)}`);
    fail(`cannot write to ${url}: ${message(err)}`);
  }

  const app = createApp({
    store,
    storage,
    formats,
    tokens,
    tokenSecret,
    client,
    redaction,
    // Each source's own rules over [filter] (X4.10); uploads get [filter].
    filter: (sourceId) => filterFor(loaded.config, sourceId),
    limits: settings.limits,
    // This process's own shard of the source health counters (X4.8).
    health: new StoreHealthCounters(store, {
      instance: `serve-${randomUUID().slice(0, 8)}`,
      onError: (err) => ctx.stderr(`seshi: warning: source health not recorded: ${message(err)}`),
    }),
  });

  const server = Bun.serve({
    hostname: settings.hostname,
    port: settings.port,
    // A raw transcript can be large; gzipped uploads are decoded after this check.
    maxRequestBodySize: Math.max(256 * 1024 * 1024, settings.limits.max_upload_bytes),
    // A large upload or a long list against a bucket can take more than Bun's 10s default.
    idleTimeout: 120,
    fetch: app.fetch,
  });

  const host = ["0.0.0.0", "::"].includes(settings.hostname) ? "localhost" : settings.hostname;
  const who = [...owners, ...(tokenSecret ? ["whoever holds a signed token"] : [])].join(", ");
  ctx.stdout(
    `seshi ${VERSION} listening on http://${host}:${server.port}, storing sessions in ${url} (deployment ${deployment}) for ${who}${
      loaded.file ? ` (config ${loaded.file})` : ""
    }`,
  );
  if (redaction) {
    ctx.stdout(
      `redaction from ${settings.redactionPacks.join(", ")}: ${redaction.patterns.length} pattern(s) on top of the built-in rules`,
    );
  }

  function shutdown(): void {
    server.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Serves until a signal; returns 1 when a setting stops it from starting. */
export async function run(ctx: CommandContext): Promise<number | undefined> {
  try {
    await start(ctx, buildFormats(await ctx.integrations()));
    return undefined;
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const issue of err.issues) ctx.stderr(`seshi: ${issue}`);
      return 1;
    }
    if (!(err instanceof ServeConfigError)) throw err;
    ctx.stderr(`seshi: ${err.message}`);
    return 1;
  }
}
