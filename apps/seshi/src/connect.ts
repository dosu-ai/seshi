/** Which sessions a CLI command reads and writes (F8.3): a seshi server over HTTP through
 * `@seshi/client`, or, in local mode (X3.5), an Instance built in-process for the one person
 * who owns the bucket. Nothing else touches a bucket: `@seshi/client` is HTTP only, and the old
 * direct-to-bucket client is gone.
 *
 * The CLI config picks: `server = "https://…"` for a team server, or
 * `[local] config = "~/.config/seshi/seshi.toml"` (a server config naming the bucket and its
 * keys) for local mode. Either way the caller gets a `SessionDB`, so the session commands
 * (branch 13) and the uploader (14) do not care which. */

import { homedir } from "node:os";
import { join } from "node:path";
import { usernameOwner } from "@seshi/auth";
import { HttpSessionDB } from "@seshi/client";
import { type CliConfig, loadServerConfig } from "@seshi/config";
import { buildInstance, type Instance } from "@seshi/instance";
import type { Integration } from "@seshi/kit";
import type { SessionDB } from "@seshi/model";
import { buildFormats } from "./integrations";

/** The CLI config names neither a server nor local mode, or names one it cannot use. */
export class NotConnected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConnected";
  }
}

export interface Connection {
  db: SessionDB;
  mode: "server" | "local";
  /** Local mode's instance, for commands that need more than the session API. */
  instance?: Instance;
  /** Write what is pending (local mode's source health) and let go. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  cli: CliConfig;
  env: Record<string, string | undefined>;
  /** The home folder, for `~` in `local.config`. */
  home?: string;
  /** For a server: the credential `seshi login` stored (branch 13). */
  token?: string;
  /** With the org key: the username to state (X5.7). */
  user?: string;
  integrations: readonly Integration[];
}

/** `~` and `~/…` as the home folder. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** The owner local mode stores sessions under: `local.owner`, else the CLI's `user`, else the
 * OS user, as an owner id (X5.8). */
export function localOwner(cli: CliConfig, env: Record<string, string | undefined>): string {
  const named = cli.local?.owner ?? cli.user ?? env.USER ?? env.USERNAME ?? "local";
  return usernameOwner(named) ?? "local";
}

/** The session API the CLI config names. */
export async function connect(options: ConnectOptions): Promise<Connection> {
  const { cli, env } = options;
  if (cli.local) {
    const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
    const file = expandHome(cli.local.config, home);
    const loaded = loadServerConfig({ configFlag: file, env });
    const owner = localOwner(cli, env);
    const instance = await buildInstance(loaded.config, {
      formats: buildFormats(options.integrations),
      integrations: options.integrations,
      env,
      // A CLI process serves nothing and runs no jobs; it only writes as its owner.
      roles: [],
      probe: [owner],
    });
    return {
      db: instance.localSessions(owner),
      mode: "local",
      instance,
      close: () => instance.close(),
    };
  }
  if (cli.server) {
    if (!options.token) {
      throw new NotConnected(`not signed in to ${cli.server}: run seshi login`);
    }
    return {
      db: new HttpSessionDB({
        server: cli.server,
        token: options.token,
        ...(options.user ? { user: options.user } : {}),
      }),
      mode: "server",
      close: async () => {},
    };
  }
  throw new NotConnected(
    "no server or local bucket configured: run seshi login --server <url>, or set [local] config in the CLI config",
  );
}
