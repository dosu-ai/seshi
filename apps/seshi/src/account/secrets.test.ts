import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FallbackSecrets,
  FileSecrets,
  MemorySecrets,
  type SecretBackend,
  writePrivateFile,
} from "./secrets";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-secrets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A keychain that is not there, as on a Linux machine without a secret service. */
function brokenKeychain(): SecretBackend {
  const fail = () => Promise.reject(new Error("no secret service"));
  return { kind: "keychain", get: fail, set: fail, delete: fail };
}

describe("the credentials file (F8.2 fallback)", () => {
  it("keeps secrets in a file only its owner can read, and removes it when empty", async () => {
    const path = join(dir, "seshi", "credentials.json");
    const file = new FileSecrets(path);
    expect(await file.get("a")).toBeNull();
    await file.set("a", "one");
    await file.set("b", "two");
    expect(await file.get("a")).toBe("one");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schema: "seshi/secrets/1" });
    expect(await file.delete("a")).toBe(true);
    expect(await file.delete("a")).toBe(false);
    expect(await file.delete("b")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("writes atomically and leaves no temporary file", () => {
    const path = join(dir, "x", "f.json");
    writePrivateFile(path, "one");
    writePrivateFile(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(existsSync(join(dir, "x"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, "x")).mode & 0o777).toBe(0o700);
  });
});

describe("the keychain with a file fallback", () => {
  it("uses the keychain when it works, and keeps no copy in the file", async () => {
    const keychain = new MemorySecrets();
    const file = new FileSecrets(join(dir, "credentials.json"));
    await file.set("k", "stale");
    const secrets = new FallbackSecrets(keychain, file);
    await secrets.set("k", "v");
    expect(keychain.values.get("k")).toBe("v");
    expect(await file.get("k")).toBeNull();
    expect(secrets.kind).toBe("memory");
    expect(secrets.placed.get("k")).toBe("memory");
    expect(await secrets.get("k")).toBe("v");
    expect(await secrets.delete("k")).toBe(true);
    expect(await secrets.get("k")).toBeNull();
  });

  it("falls back to the file when there is no keychain, and says why", async () => {
    const file = new FileSecrets(join(dir, "credentials.json"));
    const secrets = new FallbackSecrets(brokenKeychain(), file);
    await secrets.set("k", "v");
    expect(secrets.fellBack).toBe("no secret service");
    expect(secrets.kind).toBe("file");
    expect(await file.get("k")).toBe("v");
    expect(await secrets.get("k")).toBe("v");
    expect(await secrets.delete("k")).toBe(true);
    expect(await secrets.get("k")).toBeNull();
  });

  it("finds a secret in the file when the keychain lacks it", async () => {
    const file = new FileSecrets(join(dir, "credentials.json"));
    await file.set("k", "from-file");
    expect(await new FallbackSecrets(new MemorySecrets(), file).get("k")).toBe("from-file");
  });
});
