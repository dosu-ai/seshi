import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logins } from "../account/logins";
import { MemorySecrets } from "../account/secrets";
import { adminTarget } from "./admin-target";
import type { CommandContext } from "./index";

let dir: string;
let secrets: MemorySecrets;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-target-"));
  secrets = new MemorySecrets();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(env: Record<string, string> = {}): CommandContext {
  return {
    argv: [],
    env: { HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), ...env },
    stdout: () => {},
    stderr: () => {},
    integrations: async () => [],
    secrets,
  };
}

function cliConfig(toml: string): void {
  mkdirSync(join(dir, "config", "seshi"), { recursive: true });
  writeFileSync(join(dir, "config", "seshi", "config.toml"), toml);
}

const none = {
  exists: () => false,
  get cwd() {
    return dir;
  },
};

describe("where admin status is read from", () => {
  it("is the bucket when a server config is here or named", async () => {
    expect(await adminTarget(ctx(), { config: "x.toml" }, none)).toEqual({ kind: "local" });
    expect(await adminTarget(ctx(), { set: ["store.url=file:///x"] }, none)).toEqual({
      kind: "local",
    });
    expect(await adminTarget(ctx({ SESHI_CONFIG: "/x.toml" }), {}, none)).toEqual({
      kind: "local",
    });
  });

  it("never reads ./seshi.toml (only serve does), and says how to use it", async () => {
    const here = { exists: (p: string) => p === join(dir, "seshi.toml"), cwd: dir };
    const errors: string[] = [];
    const quiet = { ...ctx(), stderr: (line: string) => errors.push(line) };
    // The CLI config's server wins over a seshi.toml in the folder.
    cliConfig('server = "https://seshi.acme.com"\n');
    await expect(adminTarget(quiet, {}, here)).rejects.toThrow(/not signed in/);
    expect(errors).toEqual([expect.stringMatching(/pass --config \.\/seshi\.toml/)]);
    cliConfig("");
    expect(await adminTarget(quiet, {}, here)).toEqual({ kind: "local" });
  });

  it("is the serverless bucket, else the signed-in server, else env alone", async () => {
    expect(await adminTarget(ctx(), {}, none)).toEqual({ kind: "local" });
    cliConfig('[local]\nconfig = "~/seshi.toml"\n');
    expect(await adminTarget(ctx(), {}, none)).toEqual({ kind: "serverless" });
    cliConfig('[serverless]\nurl = "s3://acme/seshi"\n');
    expect(await adminTarget(ctx(), {}, none)).toEqual({ kind: "serverless" });
    cliConfig('server = "https://seshi.acme.com"\n');
    await expect(adminTarget(ctx(), {}, none)).rejects.toThrow(/not signed in/);
    await new Logins(join(dir, "config", "seshi"), secrets).save(
      { server: "https://seshi.acme.com", mode: "token", signed_in_at: "2026-11-14T00:00:00Z" },
      { token: "t" },
    );
    const target = await adminTarget(ctx(), {}, none);
    expect(target).toMatchObject({ kind: "remote", server: "https://seshi.acme.com" });
    // --server wins over everything.
    const named = await adminTarget(ctx({ SESHI_CONFIG: "/x.toml" }), {
      server: "https://seshi.acme.com/",
    });
    expect(named.kind).toBe("remote");
  });
});
