import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PYTHON_VERSION_FILE,
  setVersion,
  syncLock,
  syncPythonVersion,
  VERSIONED,
} from "./release-version";

const LOCK = `{
  "workspaces": {
    "packages/ts/model": {
      "name": "@seshi/model",
      "version": "0.9.0",
    },
    "packages/ts/kit": {
      "name": "@seshi/kit",
    },
  },
}
`;

describe("syncLock", () => {
  it("sets the version of the named workspaces only", () => {
    const synced = syncLock(LOCK, ["@seshi/model"], "1.2.3");
    expect(synced).toContain('"name": "@seshi/model",\n      "version": "1.2.3"');
    expect(synced.replace("1.2.3", "0.9.0")).toBe(LOCK);
  });
});

describe("setVersion", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seshi-release-"));
    mkdirSync(join(root, "packages/ts/model"), { recursive: true });
    writeFileSync(
      join(root, "packages/ts/model/package.json"),
      JSON.stringify({ name: "@seshi/model", version: "0.9.0" }),
    );
    mkdirSync(join(root, "integrations/cursor/extension"), { recursive: true });
    writeFileSync(
      join(root, "integrations/cursor/extension/package.json"),
      JSON.stringify({ name: "seshi-cursor", version: "0.9.0" }),
    );
    writeFileSync(join(root, "bun.lock"), LOCK);
    mkdirSync(join(root, "packages/py/client/src/seshi"), { recursive: true });
    writeFileSync(join(root, PYTHON_VERSION_FILE), '"""The release."""\n\n__version__ = "0.9.0"\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes the version into the manifest and the lockfile", async () => {
    await setVersion(root, "1.0.0");
    const manifest = JSON.parse(readFileSync(join(root, "packages/ts/model/package.json"), "utf8"));
    expect(manifest.version).toBe("1.0.0");
    const extension = JSON.parse(
      readFileSync(join(root, "integrations/cursor/extension/package.json"), "utf8"),
    );
    expect(extension.version).toBe("1.0.0");
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toContain('"version": "1.0.0"');
    expect(readFileSync(join(root, PYTHON_VERSION_FILE), "utf8")).toBe(
      '"""The release."""\n\n__version__ = "1.0.0"\n',
    );
  });

  it("refuses something that is not a version", async () => {
    await expect(setVersion(root, "v1")).rejects.toThrow(/not a version/);
  });

  it("names the Python client's version file, which holds the same version", () => {
    const root = resolve(import.meta.dirname, "..");
    const python = readFileSync(join(root, PYTHON_VERSION_FILE), "utf8");
    const model = JSON.parse(readFileSync(join(root, "packages/ts/model/package.json"), "utf8"));
    expect(syncPythonVersion(python, model.version)).toBe(python);
    expect(() => syncPythonVersion("VERSION = 1\n", "1.0.0")).toThrow(/no __version__ line/);
  });

  it("names folders that exist in this repository and hold a version", () => {
    for (const pkg of VERSIONED) {
      const manifest = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "..", pkg, "package.json"), "utf8"),
      );
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
