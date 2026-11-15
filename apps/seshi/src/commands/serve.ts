/** `seshi serve` (`bun start`): the server, configured by `@seshi/config` (F1): flags, then
 * `SESHI_*` env, then the TOML file (`--config`, `SESHI_CONFIG`, `./seshi.toml`,
 * `/etc/seshi/seshi.toml`), then defaults. Bun reads `.env` on its own. Changes apply on
 * restart (F1.5). docs/config.md lists every setting.
 *
 *   seshi serve [--config <file>] [--listen <host:port>] [--roles api,worker] [--set path=value]…
 *
 * It builds one Instance (X1.2) and runs the roles `server.roles` names (X7.1): `api` serves
 * the HTTP API; `worker` runs the background jobs (pollers, retention, the heartbeat). The
 * default runs both, which is what one container wants; exactly one instance should run the
 * worker (X7.2). An instance without `api` still answers `/healthz`. */

import { parseArgs } from "node:util";
import { createApp, maxBodyBytes } from "@seshi/api";
import { checkServerConfig } from "@seshi/config";
import { lineLogger } from "@seshi/instance";
import { VERSION } from "@seshi/model";
import { EXIT } from "../cli/exit";
import type { CommandContext } from "./index";
import { openServer, serverFailure } from "./server-instance";

export { ServeConfigError, serveSettings } from "./serve-settings";

const USAGE =
  "usage: seshi serve [--config <file>] [--listen <host:port>] [--roles api,worker] [--set path=value]…";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Build the instance (config, bucket, marker), serve, and start the jobs; runs until a
 * signal. */
async function start(ctx: CommandContext, argv: string[]): Promise<number | undefined> {
  let values: { config?: string; listen?: string; roles?: string; set?: string[] };
  try {
    ({ values } = parseArgs({
      args: argv,
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
    ctx.stderr(`seshi: ${message(err)}`);
    ctx.stderr(USAGE);
    return EXIT.usage;
  }
  const log = lineLogger(ctx.stdout, ctx.stderr);
  const { instance, loaded, settings } = await openServer(ctx, values, { log });
  for (const warning of checkServerConfig(loaded.config).warnings) log.warn(warning);
  const { owners, url } = settings;

  // Without static tokens or an IdP, only tokens in the bucket let anyone in.
  if (instance.api && owners.length === 0 && !settings.auth.oidc) {
    const live = await instance.auth.tokens.list().catch(() => []);
    if (live.length === 0) {
      log.warn(
        "no token can call this server yet: run `seshi admin init` where this config is, or set auth.tokens",
      );
    }
  }

  const app = createApp(instance);
  const server = Bun.serve({
    hostname: settings.hostname,
    port: settings.port,
    // A transcript up to limits.max_upload_bytes, as JSON; a gzipped body is held to the same
    // cap once decoded.
    maxRequestBodySize: maxBodyBytes(settings.limits.max_upload_bytes),
    // A large upload or a long list against a bucket can take more than Bun's 10s default.
    idleTimeout: 120,
    fetch: app.fetch,
  });
  instance.start();

  const host = ["0.0.0.0", "::"].includes(settings.hostname) ? "localhost" : settings.hostname;
  const who = [
    ...(settings.auth.orgKey ? ["the org key"] : []),
    ...(settings.auth.oidc ? [`sign-in through ${settings.auth.oidc.issuer}`] : []),
    ...(owners.length > 0 ? [`static tokens for ${owners.join(", ")}`] : []),
    "seshi tokens",
  ].join(", ");
  const serving = instance.api ? `accepting ${who}` : "worker only: /healthz and nothing else";
  const jobs = instance.jobs
    .list()
    .filter((job) => instance.jobs.runsHere(job))
    .map((job) => job.name);
  ctx.stdout(
    `roles: ${instance.roles.join(", ")} (instance ${instance.id})${
      jobs.length > 0 ? `; jobs: ${jobs.join(", ")}` : ""
    }`,
  );
  if (instance.redaction) {
    ctx.stdout(
      `redaction from ${settings.redactionPacks.join(", ")}: ${instance.redaction.patterns.length} pattern(s) on top of the built-in rules`,
    );
  }
  // Last, so whoever waits for the address has read everything before it.
  ctx.stdout(
    `seshi ${VERSION} listening on http://${host}:${server.port}, storing sessions in ${url} (deployment ${instance.deployment}); ${serving}${
      loaded.file ? ` (config ${loaded.file})` : ""
    }`,
  );

  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    server.stop();
    // Stop the jobs and write what source health counted; best-effort, and bounded.
    await instance.close(5000);
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return undefined;
}

/** Serves until a signal; returns `config` (3) when a setting stops it from starting and
 * `usage` (2) for a bad flag. */
export async function run(ctx: CommandContext): Promise<number | undefined> {
  try {
    return await start(ctx, ctx.argv);
  } catch (err) {
    const code = serverFailure(ctx, false, err);
    if (code === undefined) throw err;
    return code;
  }
}
