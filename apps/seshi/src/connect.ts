import { HttpSessionDB } from "@seshi/client";
import type { CliConfig } from "@seshi/config";
import type { Instance } from "@seshi/instance";
import type { Integration } from "@seshi/kit";
import type { SessionDB } from "@seshi/model";
import type { SecretBackend } from "./account/secrets";
import { openServerless, SERVERLESS_BASIS, type ServerlessBucket } from "./serverless/open";
import { isServerless, serverlessOwner } from "./serverless/settings";
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
  mode: "server" | "serverless";
  /** Serverless mode's instance, for commands that need more than the session API. */
  instance?: Instance;
  /** Serverless mode: the bucket as this machine opened it. */
  bucket?: ServerlessBucket;
  /** Let go of what was opened. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  cli: CliConfig;
  env: Record<string, string | undefined>;
  /** The home folder, for `~` in `serverless.config`. */
  home?: string;
  /** For a server: the credential `seshi login` stored. */
  token?: string;
  user?: string;
  integrations: readonly Integration[];
  /** Serverless mode: where the bucket key and review keys are kept. */
  secrets?: SecretBackend;
  /** Serverless mode: the command writes (see `openServerless`). */
  write?: boolean;
  /** Serverless mode: keep a search index; the CLI config's `[search] enabled` when unset. */
  search?: boolean;
  log?: (line: string) => void;
}

export { expandHome } from "./serverless/settings";

/** The owner a serverless laptop writes as. */
export function localOwner(cli: CliConfig, env: Record<string, string | undefined>): string {
  return serverlessOwner(cli, env);
}

export async function connect(options: ConnectOptions): Promise<Connection> {
  const { cli, env } = options;
  if (isServerless(cli)) {
    const bucket = await openServerless({
      cli,
      env,
      ...(options.home !== undefined ? { home: options.home } : {}),
      integrations: options.integrations,
      ...(options.secrets ? { secrets: options.secrets } : {}),
      write: options.write ?? false,
      ...(options.search !== undefined ? { search: options.search } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    return {
      db: bucket.instance.localSessions(bucket.owner, SERVERLESS_BASIS),
      mode: "serverless",
      instance: bucket.instance,
      bucket,
      close: () => bucket.close(),
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
    "no server or bucket configured: run seshi login --server <url>, or seshi init --serverless",
  );
}
