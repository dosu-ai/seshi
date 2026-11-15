/** Where the CLI keeps credentials (F8.2): the OS keychain through `Bun.secrets` (macOS
 * Keychain, Windows Credential Manager, libsecret on Linux), falling back to a file only its
 * owner can read (`credentials.json`, mode 0600, next to the CLI config) where there is no
 * keychain, such as a Linux machine without a secret service. Each secret is its own entry,
 * so a long IdP refresh token never pushes a short key over a keychain's size limit; one the
 * keychain refuses goes to the file alone. */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The keychain service every seshi entry is filed under. */
export const KEYCHAIN_SERVICE = "seshi";

export interface SecretBackend {
  /** What holds the secrets, for `whoami` and messages: `keychain`, `file`, or a test's own. */
  readonly kind: string;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /** Whether there was one to delete. */
  delete(name: string): Promise<boolean>;
}

/** The OS keychain. */
export function keychainSecrets(service = KEYCHAIN_SERVICE): SecretBackend {
  return {
    kind: "keychain",
    async get(name) {
      return (await Bun.secrets.get({ service, name })) ?? null;
    },
    async set(name, value) {
      await Bun.secrets.set({ service, name, value });
    },
    async delete(name) {
      return Bun.secrets.delete({ service, name });
    },
  };
}

/** Write `text` to `path` readable by its owner only: a temporary file made 0600, then renamed
 * into place, so the file is never briefly readable by others or half written. */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** A JSON file of name → secret, mode 0600. On Windows the mode is not enforced; the file is
 * under the user's own `%APPDATA%`. */
export class FileSecrets implements SecretBackend {
  readonly kind = "file";

  constructor(readonly path: string) {}

  private read(): Record<string, string> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const parsed = JSON.parse(text) as { secrets?: Record<string, string> };
    return parsed.secrets ?? {};
  }

  private write(secrets: Record<string, string>): void {
    if (Object.keys(secrets).length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    writePrivateFile(
      this.path,
      `${JSON.stringify({ schema: "seshi/secrets/1", secrets }, null, 2)}\n`,
    );
  }

  async get(name: string): Promise<string | null> {
    return this.read()[name] ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    const secrets = this.read();
    secrets[name] = value;
    this.write(secrets);
  }

  async delete(name: string): Promise<boolean> {
    const secrets = this.read();
    if (!(name in secrets)) return false;
    delete secrets[name];
    this.write(secrets);
    return true;
  }
}

/** Secrets in memory, for tests and for a process that must not persist anything. */
export class MemorySecrets implements SecretBackend {
  readonly kind = "memory";
  readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<boolean> {
    return this.values.delete(name);
  }
}

/** The keychain first, the file when the keychain cannot be used. Reads look in both, so a
 * secret written to the file while the keychain was locked is still found. `fellBack` says
 * why the last write went to the file, for a warning. */
export class FallbackSecrets implements SecretBackend {
  /** Why a secret went to the file, when one did. */
  fellBack: string | undefined;
  /** Which backend took each secret written in this process. */
  readonly placed = new Map<string, string>();

  constructor(
    readonly primary: SecretBackend,
    readonly fallback: SecretBackend,
  ) {}

  get kind(): string {
    return this.fellBack === undefined ? this.primary.kind : this.fallback.kind;
  }

  async get(name: string): Promise<string | null> {
    try {
      const value = await this.primary.get(name);
      if (value !== null) return value;
    } catch {
      // No keychain here: the file is the only place it can be.
    }
    return this.fallback.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    try {
      await this.primary.set(name, value);
      this.placed.set(name, this.primary.kind);
      // A stale copy in the file would be found if the keychain entry went away.
      await this.fallback.delete(name);
      return;
    } catch (err) {
      this.fellBack = err instanceof Error ? err.message : String(err);
    }
    await this.fallback.set(name, value);
    this.placed.set(name, this.fallback.kind);
  }

  async delete(name: string): Promise<boolean> {
    let deleted = false;
    try {
      deleted = await this.primary.delete(name);
    } catch {
      // Nothing can be in a keychain that is not there.
    }
    return (await this.fallback.delete(name)) || deleted;
  }
}
