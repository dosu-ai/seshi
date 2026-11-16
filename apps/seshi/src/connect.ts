import { homedir } from "node:os";
import { join } from "node:path";
import { usernameOwner } from "@seshi/auth";
import { HttpSessionDB } from "@seshi/client";
import { type CliConfig, loadServerConfig } from "@seshi/config";
import { buildInstance, type Instance } from "@seshi/instance";
import type { Integration } from "@seshi/kit";
import type { SessionDB } from "@seshi/model";
import { buildFormats } from "./integrations";
import { USER_AGENT } from "./user-agent";

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
  /** For a server: the credential `seshi login` stored. */
  token?: string;
  user?: string;
  integrations: readonly Integration[];
}

/** `~` and `~/…` as the home folder. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function localOwner(cli: CliConfig, env: Record<string, string | undefined>): string {
  const named = cli.local?.owner ?? cli.user ?? env.USER ?? env.USERNAME ?? "local";
  return usernameOwner(named) ?? "local";
}

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
        userAgent: USER_AGENT,
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
