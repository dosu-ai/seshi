/** Everything a command needs to know about this machine's seshi setup: the CLI config, where
 * it lives, the stored logins and the secret store. Built per command from its context; nothing
 * here is module state (X1.2). */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CliConfig, cliConfigPath, loadCliConfig } from "@seshi/config";
import type { CommandContext } from "../commands/index";
import { type Credential, credentialFor, type Purpose } from "./credential";
import { Logins, normalizeServer, SECRETS_FILE } from "./logins";
import { FallbackSecrets, FileSecrets, keychainSecrets, type SecretBackend } from "./secrets";

export interface Account {
  cli: CliConfig;
  /** The CLI config file (it may not exist yet). */
  cliFile: string;
  /** The folder the CLI config, logins and the credentials file are in. */
  dir: string;
  home: string;
  env: Record<string, string | undefined>;
  logins: Logins;
  secrets: SecretBackend;
}

/** The home folder from the command's env (tests point it elsewhere), else the OS's. */
export function homeOf(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** The OS keychain, falling back to `credentials.json` (0600) in `dir` (F8.2). */
export function defaultSecrets(dir: string): FallbackSecrets {
  return new FallbackSecrets(keychainSecrets(), new FileSecrets(join(dir, SECRETS_FILE)));
}

/** Load the CLI config and open the logins. Throws the loader's `ConfigError` for a CLI config
 * it cannot use. */
export function openAccount(ctx: CommandContext): Account {
  const env = ctx.env;
  const home = homeOf(env);
  const cliFile = cliConfigPath({ env, home, platform: process.platform });
  const dir = dirname(cliFile);
  const loaded = loadCliConfig({ env, home });
  for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
  const secrets = ctx.secrets ?? defaultSecrets(dir);
  return { cli: loaded.config, cliFile, dir, home, env, logins: new Logins(dir, secrets), secrets };
}

/** The server a command talks to: `--server`, else the CLI config's `server`; undefined when
 * neither names one. */
export function serverOf(account: Account, flag?: string): string | undefined {
  const named = flag ?? account.cli.server;
  return named === undefined ? undefined : normalizeServer(named);
}

/** The stored credential for `server` and `purpose`, renewed if it must be. */
export function accountCredential(
  account: Account,
  server: string,
  purpose: Purpose,
): Promise<Credential> {
  return credentialFor(
    {
      logins: account.logins,
      env: account.env,
      ...(account.cli.user ? { configuredUser: account.cli.user } : {}),
    },
    server,
    purpose,
  );
}

/** Where secrets went, for messages: a warning when the keychain could not be used. */
export function fallbackWarning(account: Account): string | undefined {
  const secrets = account.secrets;
  if (secrets instanceof FallbackSecrets && secrets.fellBack !== undefined) {
    return `no OS keychain here (${secrets.fellBack}); credentials are in ${join(account.dir, SECRETS_FILE)}, readable only by you`;
  }
  return undefined;
}
