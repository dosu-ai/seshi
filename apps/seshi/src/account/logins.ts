import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonFile, type SecretBackend, writePrivateFile } from "./secrets";

export const LOGINS_FILE = "logins.json";
export const SECRETS_FILE = "credentials.json";

export type LoginMode = "oidc" | "org_key" | "token";
export type SecretName = "org_key" | "token" | "session" | "refresh" | "device";
const SECRET_NAMES: readonly SecretName[] = ["org_key", "token", "session", "refresh", "device"];

export interface LoginProfile {
  /** The server's base URL, as `normalizeServer` writes it. */
  server: string;
  mode: LoginMode;
  /** Who the server says the caller is. */
  owner?: string;
  role?: string;
  scopes?: string[];
  /** The org key's stated username at sign-in; it is resolved again on every use (X5.7). */
  user?: string;
  /** The credential's id, never its secret. */
  credential_id?: string;
  /** With an IdP: where to renew the session token. */
  oidc?: { issuer: string; client_id: string; token_endpoint: string; flow: "device" | "browser" };
  /** The session token's times (X5.3: a delete needs one issued in the last 10 minutes). */
  session?: { issued_at: string; expires_at: string };
  delete_fresh_seconds?: number;
  /** The device token's id and expiry: it is renewed by signing in again (X5.9). */
  device?: { id: string; expires_at: string };
  /** With a pasted token: when the server said it stops working (a device token's 90 days). */
  token_expires_at?: string;
  /** Where the secrets went: `keychain` or `file`. */
  stored_in: string;
  signed_in_at: string;
}

interface LoginsFile {
  schema: "seshi/logins/1";
  machine_id?: string;
  logins: Record<string, LoginProfile>;
}

export class BadServerUrl extends Error {
  constructor(url: string, reason: string) {
    super(`'${url}' is not a server URL: ${reason}`);
    this.name = "BadServerUrl";
  }
}

/** The one spelling of a server URL that credentials are filed under: scheme, host, port and
 * path, no trailing slash, no query, no user info. */
export function normalizeServer(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new BadServerUrl(url, "not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BadServerUrl(url, "use http:// or https://");
  }
  if (parsed.username || parsed.password) throw new BadServerUrl(url, "no user or password");
  if (parsed.search || parsed.hash) throw new BadServerUrl(url, "no query or fragment");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export class Logins {
  readonly file: string;

  constructor(
    readonly dir: string,
    readonly secrets: SecretBackend,
  ) {
    this.file = join(dir, LOGINS_FILE);
  }

  private read(): LoginsFile {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema: "seshi/logins/1", logins: {} };
      }
      throw err;
    }
    const parsed = parseJsonFile(this.file, text) as Partial<LoginsFile>;
    return {
      schema: "seshi/logins/1",
      ...(parsed.machine_id ? { machine_id: parsed.machine_id } : {}),
      logins: parsed.logins ?? {},
    };
  }

  private write(file: LoginsFile): void {
    writePrivateFile(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  private static secretName(server: string, name: SecretName): string {
    return `${server} ${name}`;
  }

  get(server: string): LoginProfile | undefined {
    return this.read().logins[normalizeServer(server)];
  }

  list(): LoginProfile[] {
    return Object.values(this.read().logins);
  }

  /** This machine's stable id for the IdP exchange (X5.2), made the first time. */
  machineId(): string {
    const file = this.read();
    if (file.machine_id) return file.machine_id;
    const id = `m-${randomBytes(12).toString("hex")}`;
    this.write({ ...file, machine_id: id });
    return id;
  }

  /** Replace a server's login: its profile and exactly the secrets given (any other secret it
   * had is deleted). `stored_in` is filled from where the secrets went. */
  async save(
    profile: Omit<LoginProfile, "stored_in">,
    secrets: Partial<Record<SecretName, string>>,
  ): Promise<LoginProfile> {
    const server = normalizeServer(profile.server);
    for (const name of SECRET_NAMES) {
      const value = secrets[name];
      if (value === undefined) await this.secrets.delete(Logins.secretName(server, name));
      else await this.secrets.set(Logins.secretName(server, name), value);
    }
    const saved: LoginProfile = { ...profile, server, stored_in: this.secrets.kind };
    const file = this.read();
    file.logins[server] = saved;
    this.write(file);
    return saved;
  }

  /** Change a server's profile; the secrets given are written (deleted when null), the rest
   * kept. */
  async update(
    server: string,
    patch: Partial<Omit<LoginProfile, "server">>,
    secrets: Partial<Record<SecretName, string | null>> = {},
  ): Promise<LoginProfile | undefined> {
    const key = normalizeServer(server);
    for (const [name, value] of Object.entries(secrets)) {
      const secretName = Logins.secretName(key, name as SecretName);
      if (value === null) await this.secrets.delete(secretName);
      else if (value !== undefined) await this.secrets.set(secretName, value);
    }
    const file = this.read();
    const current = file.logins[key];
    if (!current) return undefined;
    file.logins[key] = { ...current, ...patch, server: key };
    this.write(file);
    return file.logins[key];
  }

  secret(server: string, name: SecretName): Promise<string | null> {
    return this.secrets.get(Logins.secretName(normalizeServer(server), name));
  }

  /** Forget a server's login: its profile and every secret. Whether there was one. */
  async remove(server: string): Promise<boolean> {
    const key = normalizeServer(server);
    let had = false;
    for (const name of SECRET_NAMES) {
      if (await this.secrets.delete(Logins.secretName(key, name))) had = true;
    }
    const file = this.read();
    if (file.logins[key]) {
      delete file.logins[key];
      this.write(file);
      had = true;
    }
    return had;
  }
}
