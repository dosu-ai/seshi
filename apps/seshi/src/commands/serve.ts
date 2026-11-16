import { parseArgs } from "node:util";
import { createApp, maxBodyBytes } from "@seshi/api";
import { checkServerConfig } from "@seshi/config";
import { lineLogger } from "@seshi/instance";
import { VERSION } from "@seshi/model";
import { EXIT } from "../cli/exit";
import { fail, helpOrUsageError } from "../cli/output";
import type { CommandContext } from "./index";
import { openServer, serverFailure } from "./server-instance";

export { ServeConfigError } from "../cli/failures";
export { serveSettings } from "./serve-settings";

export function requestBodyCap(limits: {
  max_upload_bytes: number;
  max_otlp_bytes: number;
}): number {
  const uploadCapAsJson = maxBodyBytes(limits.max_upload_bytes);
  const otlpCap = limits.max_otlp_bytes;
  return Math.max(uploadCapAsJson, otlpCap);
}

const USAGE =
  "usage: seshi serve [--config <file>] [--listen <host:port>] [--roles api,worker] [--set path=value]…";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
    return helpOrUsageError(ctx, false, message(err), USAGE);
  }
  const log = lineLogger(ctx.stdout, ctx.stderr);
  const { instance, loaded, settings } = await openServer(ctx, values, {
    log,
    trustCwdConfig: true,
  });
  for (const warning of checkServerConfig(loaded.config).warnings) log.warn(warning);
  const { owners, url } = settings;

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

  function stopWithin(graceMs: number): Promise<unknown> {
    return Promise.race([server.stop(), Bun.sleep(graceMs)]);
  }
  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await Promise.all([stopWithin(5000), instance.close(5000)]);
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function announceListening(): void {
    ctx.stdout(
      `seshi ${VERSION} listening on http://${host}:${server.port}, storing sessions in ${url} (deployment ${instance.deployment}); ${serving}${
        loaded.file ? ` (config ${loaded.file})` : ""
      }`,
    );
  }
  announceListening();
  return undefined;
}

export async function run(ctx: CommandContext): Promise<number | undefined> {
  try {
    return await start(ctx, ctx.argv);
  } catch (err) {
    const code = serverFailure(ctx, false, err);
    if (code === undefined) throw err;
    return code;
  }
}
