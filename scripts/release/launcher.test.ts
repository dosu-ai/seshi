import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { binaryPath, chooseTarget, detectLibc, ensureExecutable, locate } from "./launcher";
import { targetById } from "./targets";

describe("chooseTarget", () => {
  it.each([
    ["darwin", "arm64", undefined, "darwin-arm64"],
    ["darwin", "x64", undefined, "darwin-x64"],
    ["linux", "x64", "glibc", "linux-x64"],
    ["linux", "arm64", "glibc", "linux-arm64"],
    ["win32", "x64", undefined, "windows-x64"],
    ["win32", "arm64", undefined, "windows-arm64"],
  ] as const)("%s %s %s → %s", (platform, arch, libc, id) => {
    expect(chooseTarget(platform, arch, libc)).toEqual({ target: targetById(id) });
  });

  it("explains a platform without a binary, and musl", () => {
    const none = chooseTarget("freebsd", "x64");
    expect("error" in none && none.error).toMatch(/no binary for freebsd-x64.*darwin-arm64/);
    const musl = chooseTarget("linux", "x64", "musl");
    expect("error" in musl && musl.error).toMatch(/need glibc.*musl/);
    expect(chooseTarget("linux", "ia32", "glibc")).toHaveProperty("error");
  });
});

describe("detectLibc", () => {
  it("reads Node's report: a glibc version means glibc", () => {
    expect(detectLibc({ header: { glibcVersionRuntime: "2.39" } })).toBe("glibc");
    expect(detectLibc({ header: {} })).toBe("musl");
    expect(detectLibc(undefined)).toBe("musl");
  });
});

describe("binaryPath and locate", () => {
  const target = targetById("linux-x64");

  it("finds the binary next to the platform package's manifest", () => {
    const resolve = (request: string) => {
      expect(request).toBe("@dosu/seshi-linux-x64/package.json");
      return "/g/node_modules/@dosu/seshi-linux-x64/package.json";
    };
    expect(binaryPath(target, resolve)).toEqual({
      path: join("/g/node_modules/@dosu/seshi-linux-x64", "bin", "seshi"),
    });
    expect(
      locate({
        platform: "win32",
        arch: "x64",
        resolve: () => "/n/@dosu/seshi-windows-x64/package.json",
      }),
    ).toEqual({ path: join("/n/@dosu/seshi-windows-x64", "bin", "seshi.exe") });
  });

  it("says how to recover when npm skipped the optional dependency", () => {
    const missing = binaryPath(target, () => {
      throw new Error("Cannot find module");
    });
    expect("error" in missing && missing.error).toMatch(/@dosu\/seshi-linux-x64.*--omit=optional/);
    expect(locate({ platform: "aix", arch: "ppc64", resolve: () => "" })).toHaveProperty("error");
  });
});

describe.skipIf(process.platform === "win32")("ensureExecutable", () => {
  it("restores a dropped executable bit and leaves a good one alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "seshi-launcher-"));
    try {
      const file = join(dir, "seshi");
      writeFileSync(file, "#!/bin/sh\n");
      chmodSync(file, 0o644);
      ensureExecutable(file);
      expect(statSync(file).mode & 0o111).not.toBe(0);
      ensureExecutable(file);
      expect(statSync(file).mode & 0o777).toBe(0o755);
      // Windows has no executable bit to fix.
      chmodSync(file, 0o644);
      ensureExecutable(file, "win32");
      expect(statSync(file).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
