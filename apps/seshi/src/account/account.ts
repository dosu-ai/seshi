import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CliConfig, cliConfigPath, type Loaded, loadCliConfig } from "@seshi/config";
import type { CommandContext } from "../commands/index";
import { type Credential, credentialFor, type Purpose } from "./credential";
import { Logins, normalizeServer, SECRETS_FILE } from "./logins";
import { FallbackSecrets, FileSecrets, keychainSecrets, type SecretBackend } from "./secrets";
import type { ConfiguredUser } from "./user";

export interface Account {
  cli: CliConfig;
  user?: ConfiguredUser;
  /** The CLI config file (it may not exist yet). */
  cliFile: string;
  /** The folder the CLI config, logins and the credentials file are in. */
  dir: string;
  home: string;
  env: Record<string, string | undefined>;
  logins: Logins;
  secrets: SecretBackend;
}

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
  const secrets =
    ctx.secrets ??
    (loaded.config.keychain ? defaultSecrets(dir) : new FileSecrets(join(dir, SECRETS_FILE)));
  const logins = new Logins(dir, secrets);
  if (!loaded.config.keychain && !ctx.secrets) warnKeychainLogins(ctx, logins);
  const user = configuredUser(loaded);
  return {
    cli: loaded.config,
    ...(user ? { user } : {}),
    cliFile,
    dir,
    home,
    env,
    logins,
    secrets,
  };
}

function configuredUser(loaded: Loaded<CliConfig>): ConfiguredUser | undefined {
  const user = loaded.config.user;
  if (!user) return undefined;
  const from = loaded.origins.get(["user"]).source === "env" ? "SESHI_USER" : "config";
  return { user, from };
}

function warnKeychainLogins(ctx: CommandContext, logins: Logins): void {
  let profiles: ReturnType<Logins["list"]>;
  try {
    profiles = logins.list();
  } catch {
    return;
  }
  for (const profile of profiles) {
    if (profile.stored_in !== "keychain") continue;
    ctx.stderr(
      `seshi: warning: keychain = false, but the login for ${profile.server} keeps its secrets in the OS keychain; run \`seshi logout\` with keychain = true to remove them, then sign in again`,
    );
  }
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
      ...(account.user ? { configuredUser: account.user } : {}),
    },
    server,
    purpose,
  );
}

export function fallbackWarning(account: Account): string | undefined {
  const secrets = account.secrets;
  if (secrets instanceof FallbackSecrets && secrets.fellBack !== undefined) {
    return `no OS keychain here (${secrets.fellBack}); credentials are in ${join(account.dir, SECRETS_FILE)}, readable only by you`;
  }
  return undefined;
}
