import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { usernameOwner } from "@seshi/auth";
import { captureDir } from "@seshi/capture";
import type { CliConfig } from "@seshi/config";

/** This machine's serverless settings (F11): `[serverless]`, or `[local]` read as it. */
export interface ServerlessSettings {
  url?: string;
  region?: string;
  endpoint?: string;
  account_id?: string;
  account_name?: string;
  owner?: string;
  /** A local server config layered over the shared one; `~` not yet expanded. */
  config?: string;
  /** Read from `[local]`, the old name (F11.1). */
  oldName: boolean;
}

export function serverlessOf(cli: CliConfig): ServerlessSettings | undefined {
  if (cli.serverless) return { ...cli.serverless, oldName: false };
  if (cli.local) {
    return {
      config: cli.local.config,
      ...(cli.local.owner !== undefined ? { owner: cli.local.owner } : {}),
      oldName: true,
    };
  }
  return undefined;
}

export function isServerless(cli: CliConfig): boolean {
  return cli.serverless !== undefined || cli.local !== undefined;
}

/** The owner sessions are written under: `serverless.owner`, else `user`, else the OS user, as
 * an owner id (lowercased; a name that cannot be a folder becomes a hashed `h-…` id). */
export function serverlessOwner(cli: CliConfig, env: Record<string, string | undefined>): string {
  const named = serverlessOf(cli)?.owner ?? cli.user ?? env.USER ?? env.USERNAME ?? "local";
  return usernameOwner(named) ?? "local";
}

/** `~` and `~/…` as the home folder. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function homeFor(env: Record<string, string | undefined>, home?: string): string {
  return home ?? env.HOME ?? env.USERPROFILE ?? homedir();
}

/** Where this machine keeps what it knows about one bucket: the shared settings it cached,
 * the storage test's result, and its drop and failure records (F11.10). */
export interface ServerlessPaths {
  dir: string;
  /** The cached copy of the bucket's `config/` and its ETags. */
  shared: string;
  sharedIndex: string;
  /** The storage test's last result. */
  storageTest: string;
  /** The folder store drop and failure records are written to
   * (`sources/upload/{dropped,failed}/` under it). */
  records: string;
}

export function serverlessPaths(
  env: Record<string, string | undefined>,
  home: string,
  bucketUrl: string,
): ServerlessPaths {
  const id = createHash("sha256").update(bucketUrl).digest("hex").slice(0, 16);
  const dir = join(captureDir({ platform: process.platform, env, home }), "serverless", id);
  return {
    dir,
    shared: join(dir, "shared"),
    sharedIndex: join(dir, "shared.json"),
    storageTest: join(dir, "storage-test.json"),
    records: join(dir, "records"),
  };
}
