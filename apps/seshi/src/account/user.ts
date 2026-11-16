import { userInfo } from "node:os";

export type UserSource = "SESHI_USER" | "config" | "git" | "os";

export interface ResolvedUser {
  user: string;
  from: UserSource;
}

export class BadUsername extends Error {
  constructor(
    readonly user: string,
    readonly from: UserSource,
  ) {
    super(
      `the username '${user}' (from ${from}) is not printable ASCII, which an HTTP header needs; set SESHI_USER or user in the CLI config`,
    );
    this.name = "BadUsername";
  }
}

export interface ResolveUserOptions {
  env: Record<string, string | undefined>;
  configured?: string;
  gitEmail?: () => Promise<string | undefined>;
  osUser?: () => string | undefined;
}

/** `git config --get user.email`, or undefined. Bounded at 2 s so a broken git cannot hold up
 * the CLI. `env` (the command's environment) is laid over the process's, so git reads the
 * global config of the home the command runs in. */
export async function gitUserEmail(
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "config", "--get", "user.email"], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), 2000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return undefined;
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

function osUserName(env: Record<string, string | undefined>): string | undefined {
  try {
    return userInfo().username || env.USER || env.USERNAME;
  } catch {
    return env.USER || env.USERNAME;
  }
}

/** Whether `user` can be sent as `X-Seshi-User`. */
export function sendableUser(user: string): boolean {
  return /^[\x20-\x7e]+$/.test(user) && user.trim() === user && user.length <= 256;
}

/** The username to state with the org key. Throws `BadUsername` for one that cannot be sent. */
export async function resolveUser(options: ResolveUserOptions): Promise<ResolvedUser> {
  const fromEnv = options.env.SESHI_USER?.trim();
  const configured = options.configured?.trim();
  let found: ResolvedUser | undefined;
  if (fromEnv) found = { user: fromEnv, from: "SESHI_USER" };
  else if (configured) found = { user: configured, from: "config" };
  else {
    const email = (await (options.gitEmail ?? (() => gitUserEmail(options.env)))())?.trim();
    if (email) found = { user: email, from: "git" };
    else {
      const os = (options.osUser ?? (() => osUserName(options.env)))()?.trim();
      found = { user: os || "unknown", from: "os" };
    }
  }
  if (!sendableUser(found.user)) throw new BadUsername(found.user, found.from);
  return found;
}
