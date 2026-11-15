/** `seshi admin init` (X5.12): the first admin token and the org key. It runs where the server's
 * config and bucket keys are, writes straight to the bucket, and prints each token once; after
 * that, admins manage tokens through the API (`/v1/tokens`).
 *
 *   seshi admin init [--config <file>] [--set path=value]… [--owner <id>] [--force]
 *                    [--rotate-org-key]
 *
 * - The admin token belongs to `--owner` (`admin` by default): what it writes is that owner's.
 * - The org key is made when `auth.org_key.enabled` and none is live. `--rotate-org-key`
 *   revokes the live ones and makes a new one: without an IdP, the only way to cut someone off
 *   (X5.11). Every member then sets the new key.
 * - Run again, it refuses: an admin token already exists. `--force` makes another one. */

import { parseArgs } from "node:util";
import { AdminInitError, Auth } from "@seshi/auth";
import { ConfigError, loadServerConfig } from "@seshi/config";
import { VERSION } from "@seshi/model";
import { ensureLayout, LayoutError, openStore } from "@seshi/store";
import type { CommandContext } from "./index";
import { configFlags, ServeConfigError, serveSettings } from "./serve-settings";

const USAGE = `usage: seshi admin init [--config <file>] [--set path=value]… [--owner <id>] [--force] [--rotate-org-key]`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function init(ctx: CommandContext, argv: string[]): Promise<number> {
  let values: {
    config?: string;
    set?: string[];
    owner?: string;
    force?: boolean;
    "rotate-org-key"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        set: { type: "string", multiple: true },
        owner: { type: "string" },
        force: { type: "boolean" },
        "rotate-org-key": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    ctx.stderr(`seshi: ${message(err)}`);
    ctx.stderr(USAGE);
    return 2;
  }
  const loaded = loadServerConfig({
    configFlag: values.config,
    env: ctx.env,
    flags: configFlags({ set: values.set }),
  });
  for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
  const settings = serveSettings(loaded.config);
  let store: ReturnType<typeof openStore>["store"];
  try {
    ({ store } = openStore(settings.url, { ...settings.store, env: ctx.env }));
  } catch (err) {
    throw new ServeConfigError(message(err));
  }
  let deployment: string;
  try {
    const marker = await ensureLayout(store, {
      createdBy: `seshi/${VERSION}`,
      deploymentId: settings.deploymentId,
      org: settings.org,
    });
    deployment = marker.deployment_id;
  } catch (err) {
    if (err instanceof LayoutError) {
      throw new ServeConfigError(`cannot use ${settings.url}: ${message(err)}`);
    }
    throw new ServeConfigError(`cannot write to ${settings.url}: ${message(err)}`);
  }
  const auth = new Auth(settings.auth, {
    store,
    deployment,
    sources: loaded.config.sources.map((s) => s.id),
  });
  const result = await auth.initAdmin({
    owner: values.owner ?? "admin",
    force: values.force === true,
    rotateOrgKey: values["rotate-org-key"] === true,
  });
  for (const old of result.revoked) {
    ctx.stdout(`revoked the old org key ${old.id}`);
  }
  if (result.admin) {
    ctx.stdout(
      `admin token for ${result.admin.record.owner} (id ${result.admin.record.id}); shown once, keep it safe:`,
    );
    ctx.stdout(`  ${result.admin.token}`);
  }
  if (result.org_key) {
    ctx.stdout(
      `org key (id ${result.org_key.record.id}); give it to every member (seshi login --key); shown once:`,
    );
    ctx.stdout(`  ${result.org_key.token}`);
  }
  return 0;
}

export async function run(ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = ctx.argv;
  if (sub !== "init") {
    ctx.stderr(sub === undefined ? USAGE : `seshi: unknown admin command '${sub}'\n${USAGE}`);
    return 2;
  }
  try {
    return await init(ctx, rest);
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const issue of err.issues) ctx.stderr(`seshi: ${issue}`);
      return 1;
    }
    if (err instanceof ServeConfigError || err instanceof AdminInitError) {
      ctx.stderr(`seshi: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
