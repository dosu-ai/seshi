import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BadServerUrl, Logins, normalizeServer } from "./logins";
import { MemorySecrets } from "./secrets";

let dir: string;
let secrets: MemorySecrets;
let logins: Logins;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-logins-"));
  secrets = new MemorySecrets();
  logins = new Logins(dir, secrets);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  server: "https://seshi.acme.com/",
  mode: "oidc" as const,
  owner: "alice",
  signed_in_at: "2026-11-14T00:00:00.000Z",
};

describe("server URLs", () => {
  it("files credentials under one spelling", () => {
    expect(normalizeServer("https://Seshi.Acme.com/")).toBe("https://seshi.acme.com");
    expect(normalizeServer(" http://localhost:7200/seshi// ")).toBe("http://localhost:7200/seshi");
    expect(normalizeServer("https://seshi.acme.com:443")).toBe("https://seshi.acme.com");
  });

  it("refuses what is not a server URL", () => {
    for (const url of [
      "seshi.acme.com",
      "ftp://x",
      "https://u:p@x",
      "https://x/?a=1",
      "https://x/#y",
    ]) {
      expect(() => normalizeServer(url), url).toThrow(BadServerUrl);
    }
  });
});

describe("logins (F8.2)", () => {
  it("keeps the profile in a file and each secret in the secret store", async () => {
    const saved = await logins.save(base, { session: "jwt", refresh: "rt", device: "seshi_d" });
    expect(saved).toMatchObject({ server: "https://seshi.acme.com", stored_in: "memory" });
    expect(logins.get("https://seshi.acme.com")).toEqual(saved);
    expect(await logins.secret("https://seshi.acme.com/", "refresh")).toBe("rt");
    expect([...secrets.values.keys()].sort()).toEqual([
      "https://seshi.acme.com device",
      "https://seshi.acme.com refresh",
      "https://seshi.acme.com session",
    ]);
    // No secret in the profile file.
    const text = readFileSync(logins.file, "utf8");
    expect(text).not.toContain("jwt");
    expect(text).not.toContain("seshi_d");
    if (process.platform !== "win32") expect(statSync(logins.file).mode & 0o777).toBe(0o600);
  });

  it("replaces a login's secrets on save, and updates some on update", async () => {
    await logins.save(base, { session: "jwt", refresh: "rt" });
    await logins.save({ ...base, mode: "org_key", user: "alice" }, { org_key: "seshi_k" });
    expect(await logins.secret(base.server, "session")).toBeNull();
    expect(await logins.secret(base.server, "org_key")).toBe("seshi_k");
    const updated = await logins.update(base.server, { owner: "bob" }, { org_key: "seshi_k2" });
    expect(updated).toMatchObject({ owner: "bob", user: "alice" });
    expect(await logins.secret(base.server, "org_key")).toBe("seshi_k2");
    expect(await logins.update("https://elsewhere.test", { owner: "x" })).toBeUndefined();
  });

  it("forgets everything of a server on remove, and keeps the machine id", async () => {
    const machine = logins.machineId();
    expect(machine).toMatch(/^m-[0-9a-f]{24}$/);
    await logins.save(base, { session: "jwt", device: "d" });
    await logins.save({ ...base, server: "https://other.test" }, { token: "t" });
    expect(await logins.remove(base.server)).toBe(true);
    expect(await logins.remove(base.server)).toBe(false);
    expect(logins.get(base.server)).toBeUndefined();
    expect(logins.list().map((p) => p.server)).toEqual(["https://other.test"]);
    expect([...secrets.values.keys()]).toEqual(["https://other.test token"]);
    expect(new Logins(dir, secrets).machineId()).toBe(machine);
  });
});
