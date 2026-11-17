import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChecksums, readArchive, sha256 } from "./archive";
import { binaryEnv, buildRelease, repositoryVersion, selectTargets } from "./build";
import { CHECKSUMS, extensionAsset, hostTarget, INSTALL_SCRIPTS, TARGETS } from "./targets";
import { standInCompile } from "./testing";

const packageExtension = async (outfile: string) => writeFileSync(outfile, "a vsix");

describe("buildRelease", () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "seshi-release-"));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")(
    "archives every target's binary with the licence and checksums every asset",
    async () => {
      const { compile, compiled } = standInCompile();
      const assets = await buildRelease({
        out,
        compile,
        packageExtension,
        mtime: Date.UTC(2026, 10, 15),
      });
      expect(compiled).toEqual(TARGETS.map((t) => t.id));
      expect(assets.map((a) => a.name)).toEqual([
        ...TARGETS.map((t) => t.asset),
        ...INSTALL_SCRIPTS,
        extensionAsset(repositoryVersion()),
      ]);
      const sums = parseChecksums(readFileSync(join(out, CHECKSUMS), "utf8"));
      expect([...sums.keys()].sort()).toEqual(assets.map((a) => a.name).sort());
      for (const asset of assets) {
        const bytes = readFileSync(join(out, asset.name));
        expect(sums.get(asset.name)).toBe(sha256(bytes));
        expect(asset.sha256).toBe(sha256(bytes));
        expect(asset.size).toBe(bytes.byteLength);
      }
      for (const target of TARGETS) {
        const entries = readArchive(target.asset, readFileSync(join(out, target.asset)));
        expect(entries.map((e) => [e.name, e.mode])).toEqual([
          [target.binary, 0o755],
          ["LICENSE", 0o644],
        ]);
        expect(new TextDecoder().decode(entries[0]?.data)).toContain(`# ${target.id}`);
        expect(target.asset.endsWith(target.os === "windows" ? ".zip" : ".tar.gz")).toBe(true);
      }
      expect(readFileSync(join(out, "install.sh"), "utf8")).toContain("#!/bin/sh");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a host binary that prints another version",
    async () => {
      const { compile } = standInCompile("0.0.1");
      await expect(
        buildRelease({ out, compile, packageExtension, targets: [hostTarget()] }),
      ).rejects.toThrow(/--version printed "seshi 0.0.1"/);
    },
  );

  it("refuses a --version the repository does not carry", async () => {
    const { compile, compiled } = standInCompile();
    await expect(
      buildRelease({ out, compile, packageExtension, version: "99.0.0" }),
    ).rejects.toThrow(/release-version/);
    expect(compiled).toEqual([]);
  });
});

describe("selectTargets", () => {
  it("keeps the release order and knows host", () => {
    expect(selectTargets([])).toEqual(TARGETS);
    expect(selectTargets(["windows-x64", "darwin-arm64"]).map((t) => t.id)).toEqual([
      "darwin-arm64",
      "windows-x64",
    ]);
    expect(selectTargets(["host"])).toEqual([hostTarget()]);
    expect(() => selectTargets(["linux-ia32"])).toThrow(/unknown target/);
  });
});

describe("binaryEnv", () => {
  it("drops the caller's seshi settings and keeps the rest", () => {
    expect(
      binaryEnv({
        PATH: "/bin",
        SYSTEMROOT: "C:\\Windows",
        SESHI_SERVER: "https://elsewhere",
        seshi_keychain: "false",
        UNSET: undefined,
      }),
    ).toEqual({ PATH: "/bin", SYSTEMROOT: "C:\\Windows" });
  });
});
