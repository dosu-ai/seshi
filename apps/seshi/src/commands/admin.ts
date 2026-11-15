/** `seshi admin init` (X5.12): the first admin token and the org key. It runs where the server's
 * config and bucket keys are, writes straight to the bucket, and prints each token once; after
 * that, admins manage tokens through the API (`/v1/tokens`).
 *
 *   seshi admin init [--config <file>] [--set path=value]… [--owner <id>] [--force]
 *                    [--rotate-org-key] [--json]
 *
 * - The admin token belongs to `--owner` (`admin` by default): what it writes is that owner's.
 * - The org key is made when `auth.org_key.enabled` and none is live. `--rotate-org-key`
 *   revokes the live ones and makes a new one: without an IdP, the only way to cut someone off
 *   (X5.11). Every member then sets the new key.
 * - Run again, it refuses: an admin token already exists. `--force` makes another one.
 * - `--json` prints one document, `{ admin?: {id, owner, token}, org_key?: {id, token},
 *   revoked: [id] }`, for a deployment script to keep the tokens (F8.1). */

import { parseArgs } from "node:util";
import { AdminInitError } from "@seshi/auth";
import { EXIT } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
import type { CommandContext } from "./index";
import { openServer, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE = `usage: seshi admin init [--config <file>] [--set path=value]… [--owner <id>] [--force] [--rotate-org-key] [--json]`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function init(ctx: CommandContext, argv: string[], json: boolean): Promise<number> {
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
        ...SERVER_OPTIONS,
        owner: { type: "string" },
        force: { type: "boolean" },
        "rotate-org-key": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return usageError(ctx, json, message(err), USAGE);
  }
  // A one-shot instance: no roles, nothing probed; the marker is still checked (X1.4).
  const { instance } = await openServer(ctx, values, { roles: [], probe: [] });
  let result: Awaited<ReturnType<typeof instance.auth.initAdmin>>;
  try {
    result = await instance.auth.initAdmin({
      owner: values.owner ?? "admin",
      force: values.force === true,
      rotateOrgKey: values["rotate-org-key"] === true,
    });
  } finally {
    await instance.close();
  }
  const { admin, org_key, revoked } = result;
  const document = {
    ...(admin
      ? { admin: { id: admin.record.id, owner: admin.record.owner, token: admin.token } }
      : {}),
    ...(org_key ? { org_key: { id: org_key.record.id, token: org_key.token } } : {}),
    revoked: revoked.map((old) => old.id),
  };
  emit(ctx, json, document, () => [
    ...revoked.map((old) => `revoked the old org key ${old.id}`),
    ...(admin
      ? [
          `admin token for ${admin.record.owner} (id ${admin.record.id}); shown once, keep it safe:`,
          `  ${admin.token}`,
        ]
      : []),
    ...(org_key
      ? [
          `org key (id ${org_key.record.id}); give it to every member (seshi login --key); shown once:`,
          `  ${org_key.token}`,
        ]
      : []),
  ]);
  return EXIT.ok;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest: argv } = takeJson(ctx.argv);
  const [sub, ...rest] = argv;
  if (sub !== "init") {
    return usageError(
      ctx,
      json,
      sub === undefined ? "admin needs a subcommand" : `unknown admin command '${sub}'`,
      USAGE,
    );
  }
  try {
    return await init(ctx, rest, json);
  } catch (err) {
    if (err instanceof AdminInitError)
      return fail(ctx, json, EXIT.conflict, "conflict", err.message);
    const code = serverFailure(ctx, json, err);
    if (code === undefined) throw err;
    return code;
  }
}
