import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../commands/index";
import { openAccount } from "./account";
import { FallbackSecrets, FileSecrets, MemorySecrets } from "./secrets";

describe("openAccount: where secrets go", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seshi-account-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const ctx = (env: Record<string, string> = {}, secrets?: MemorySecrets): CommandContext => ({
    argv: [],
    // The CLI config folder under home/config whatever the platform (%APPDATA% on Windows).
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      APPDATA: join(home, "config"),
      ...env,
    },
    stdout: () => {},
    stderr: () => {},
    integrations: async () => [],
    ...(secrets ? { secrets } : {}),
  });

  function cliConfig(toml: string) {
    mkdirSync(join(home, "config/seshi"), { recursive: true });
    writeFileSync(join(home, "config/seshi/config.toml"), toml);
  }

  it("uses the keychain with the file as fallback by default (nothing is asked yet)", () => {
    expect(openAccount(ctx()).secrets).toBeInstanceOf(FallbackSecrets);
  });

  it("keeps credentials in credentials.json only with keychain = false", () => {
    cliConfig("keychain = false\n");
    const secrets = openAccount(ctx()).secrets;
    expect(secrets).toBeInstanceOf(FileSecrets);
    expect((secrets as FileSecrets).path).toBe(join(home, "config/seshi/credentials.json"));
  });

  it("takes SESHI_KEYCHAIN=false from the environment, over the file", () => {
    cliConfig("keychain = true\n");
    expect(openAccount(ctx({ SESHI_KEYCHAIN: "false" })).secrets).toBeInstanceOf(FileSecrets);
  });

  it("warns when keychain = false hides a login whose secrets are in the keychain", () => {
    mkdirSync(join(home, "config/seshi"), { recursive: true });
    writeFileSync(
      join(home, "config/seshi/logins.json"),
      JSON.stringify({
        schema: "seshi/logins/1",
        logins: {
          "https://a.example": { server: "https://a.example", mode: "key", stored_in: "keychain" },
          "https://b.example": { server: "https://b.example", mode: "key", stored_in: "file" },
        },
      }),
    );
    const warnings: string[] = [];
    const quiet: string[] = [];
    openAccount({ ...ctx(), stderr: (line: string) => quiet.push(line) });
    expect(quiet).toEqual([]);
    openAccount({
      ...ctx({ SESHI_KEYCHAIN: "false" }),
      stderr: (line: string) => warnings.push(line),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("https://a.example keeps its secrets in the OS keychain");
  });

  it("a test's own store wins over either", () => {
    const memory = new MemorySecrets();
    expect(openAccount(ctx({ SESHI_KEYCHAIN: "false" }, memory)).secrets).toBe(memory);
  });
});
