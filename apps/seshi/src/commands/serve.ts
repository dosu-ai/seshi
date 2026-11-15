/** `seshi serve` (`bun start`): the server, configured by `@seshi/config` (F1): flags, then
 * `SESHI_*` env, then the TOML file (`--config`, `SESHI_CONFIG`, `./seshi.toml`,
 * `/etc/seshi/seshi.toml`), then defaults. From a checkout (`bun start`) Bun reads `.env` on its
 * own; the compiled binary does not (scripts/build-binary.ts). Changes apply on restart (F1.5).
 * docs/config.md lists every setting.
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
import { fail, usageError } from "../cli/output";
import type { CommandContext } from "./index";
import { openServer, serverFailure } from "./server-instance";

export { ServeConfigError, serveSettings } from "./serve-settings";

/** The largest request body the listener takes: a transcript up to `limits.max_upload_bytes`,
 * as JSON (a gzipped body is held to the same cap once decoded), or an OTLP body up to
 * `limits.max_otlp_bytes`, whichever is larger, so the OTLP route's own 413 (which names the
 * key) is the one an exporter sees. */
export function requestBodyCap(limits: {
  max_upload_bytes: number;
  max_otlp_bytes: number;
}): number {
  return Math.max(maxBodyBytes(limits.max_upload_bytes), limits.max_otlp_bytes);
}

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
    return usageError(ctx, false, message(err), USAGE);
  }
  const log = lineLogger(ctx.stdout, ctx.stderr);
  // Only serve reads ./seshi.toml unasked: it runs where its own config is.
  const { instance, loaded, settings } = await openServer(ctx, values, { log, cwdFile: true });
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
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: settings.hostname,
      port: settings.port,
      maxRequestBodySize: requestBodyCap(settings.limits),
      // A large upload or a long list against a bucket can take more than Bun's 10s default.
      idleTimeout: 120,
      fetch: app.fetch,
    });
  } catch (err) {
    await instance.close(1000);
    const code = (err as { code?: unknown }).code;
    const why =
      code === "EADDRINUSE"
        ? "the address is in use (another seshi serve, or another program)"
        : message(err);
    return fail(
      ctx,
      false,
      EXIT.config,
      "listen",
      `cannot listen on ${loaded.config.server.listen}: ${why}; set server.listen or --listen`,
    );
  }
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
  if (instance.redaction.packs.length > 0) {
    const packs = instance.redaction.packs.map((p) => p.id).join(", ");
    ctx.stdout(
      `redaction: packs ${packs} (from ${settings.redactionPacks.join(", ")}) on top of the built-in rules ${instance.redaction.builtinVersion}; rule set ${instance.redaction.hash.slice(0, 12)}`,
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
    // Take no new requests and let the ones in flight finish (an upload is written whole or
    // not at all, and its client resends), while the jobs stop and source health is written;
    // each bounded, so a stuck request cannot hold the process past its grace period.
    await Promise.all([Promise.race([server.stop(), Bun.sleep(5000)]), instance.close(5000)]);
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
