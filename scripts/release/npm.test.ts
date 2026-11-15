import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tarGz } from "./archive";
import { buildRelease, repositoryVersion } from "./build";
import {
  buildNpm,
  LIBRARIES,
  launcherManifest,
  libraryDependencies,
  type NpmPackage,
  platformManifest,
} from "./npm";
import { CHECKSUMS, hostTarget, TARGETS, targetById } from "./targets";
import { exec, installPackages, standInCompile } from "./testing";

const VERSION = repositoryVersion();
const posix = process.platform !== "win32";
const node = Bun.which("node");

describe("manifests", () => {
  it("platform packages install only on their own os, cpu and libc", () => {
    expect(platformManifest(targetById("linux-arm64"), "1.2.3")).toMatchObject({
      name: "@seshi/cli-linux-arm64",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["arm64"],
      libc: ["glibc"],
      files: ["bin/"],
      license: "MIT",
    });
    const win = platformManifest(targetById("windows-x64"), "1.2.3");
    expect(win).toMatchObject({ os: ["win32"], cpu: ["x64"] });
    expect(win).not.toHaveProperty("libc");
    expect(win).not.toHaveProperty("bin");
  });

  it("the launcher pins every platform package at its own version", () => {
    const manifest = launcherManifest("1.2.3");
    expect(manifest).toMatchObject({ name: "seshi", bin: { seshi: "bin/seshi.js" } });
    expect(manifest.optionalDependencies).toEqual(
      Object.fromEntries(TARGETS.map((t) => [t.npm, "1.2.3"])),
    );
    expect(manifest).not.toHaveProperty("private");
    expect(manifest).not.toHaveProperty("dependencies");
  });

  it("libraries depend on published workspace packages at the release's version", () => {
    expect(libraryDependencies({ "@seshi/model": "workspace:*" }, "1.2.3")).toEqual({
      "@seshi/model": "1.2.3",
    });
    expect(libraryDependencies({ "@letta-ai/trajectory": "^0.3.0" }, "1.2.3")).toEqual({
      "@letta-ai/trajectory": "^0.3.0",
    });
    expect(() => libraryDependencies({ "@seshi/store": "workspace:*" }, "1.2.3")).toThrow(
      /not published/,
    );
    expect(libraryDependencies(undefined, "1.2.3")).toEqual({});
  });
});

describe.skipIf(!posix)("buildNpm", () => {
  let release: string;
  let out: string;
  let packages: NpmPackage[];

  beforeAll(async () => {
    release = mkdtempSync(join(tmpdir(), "seshi-npm-release-"));
    out = mkdtempSync(join(tmpdir(), "seshi-npm-out-"));
    // The stand-in binary echoes its arguments, its stdin, and exits with $EXIT (or signals).
    const body = [
      `if [ "$1" = "--version" ]; then echo "seshi ${VERSION}"; exit 0; fi`,
      `if [ "$1" = "--signal" ]; then kill -TERM $$; fi`,
      `echo "args:$*"`,
      `if [ "$1" = "--stdin" ]; then cat; fi`,
      `exit "\${EXIT:-0}"`,
    ].join("\n");
    await buildRelease({ out: release, compile: standInCompile(VERSION, body).compile });
    packages = await buildNpm({ version: VERSION, from: release, out });
  }, 120_000);
  afterAll(() => {
    rmSync(release, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("builds every package in publish order, the launcher last", () => {
    const names = [...TARGETS.map((t) => t.npm), ...LIBRARIES.map((l) => l.name), "seshi"];
    expect(packages.map((p) => p.name)).toEqual(names);
    const listed = JSON.parse(readFileSync(join(out, "packages.json"), "utf8"));
    expect(listed.map((p: { name: string }) => p.name)).toEqual(names);
    for (const p of packages) {
      const manifest = JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8"));
      expect(manifest.name).toBe(p.name);
      expect(manifest.version).toBe(VERSION);
      expect(manifest.private).toBeUndefined();
      expect(existsSync(join(p.dir, "LICENSE"))).toBe(true);
      expect(existsSync(join(p.dir, "README.md"))).toBe(true);
    }
  });

  it("puts each release archive's binary, executable, in its platform package", () => {
    for (const target of TARGETS) {
      const bin = join(out, `cli-${target.id}`, "bin", target.binary);
      expect(readFileSync(bin, "utf8")).toContain(`# ${target.id}`);
      expect(statSync(bin).mode & 0o777).toBe(0o755);
    }
    const launcher = join(out, "seshi/bin/seshi.js");
    expect(readFileSync(launcher, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(readFileSync(launcher, "utf8")).not.toContain(process.cwd());
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it("refuses archives that do not match SHA256SUMS, or a missing line", async () => {
    const bad = mkdtempSync(join(tmpdir(), "seshi-npm-bad-"));
    try {
      await buildRelease({ out: bad, compile: standInCompile(VERSION).compile });
      const target = TARGETS[2];
      if (!target) throw new Error("no target");
      writeFileSync(join(bad, target.asset), tarGz([{ name: "seshi", data: new Uint8Array(3) }]));
      const opts = { version: VERSION, from: bad, out: join(bad, "npm"), libraries: false };
      await expect(buildNpm(opts)).rejects.toThrow(`${target.asset} does not match its checksum`);
      writeFileSync(join(bad, CHECKSUMS), "");
      await expect(buildNpm(opts)).rejects.toThrow(/has no line for/);
      await expect(buildNpm({ ...opts, version: "nope" })).rejects.toThrow(/not a version/);
      await expect(buildNpm({ ...opts, version: "99.0.0", libraries: true })).rejects.toThrow(
        /build from the release's tag/,
      );
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  describe.skipIf(!node)("installed as npm lays it out, run by Node", () => {
    let project: string;
    let lonely: string;
    beforeAll(() => {
      project = mkdtempSync(join(tmpdir(), "seshi-npm-project-"));
      lonely = mkdtempSync(join(tmpdir(), "seshi-npm-lonely-"));
      const host = hostTarget();
      const wanted = new Set(["seshi", host.npm, ...LIBRARIES.map((l) => l.name)]);
      installPackages(
        project,
        packages.filter((p) => wanted.has(p.name)),
      );
      // The launcher alone, as with --omit=optional (a folder of its own, so Node's lookup
      // cannot climb into the project's node_modules).
      installPackages(
        lonely,
        packages.filter((p) => p.name === "seshi"),
      );
    });
    afterAll(() => {
      rmSync(project, { recursive: true, force: true });
      rmSync(lonely, { recursive: true, force: true });
    });

    const launcher = () => join(project, "node_modules/seshi/bin/seshi.js");

    it("runs this machine's binary with the same arguments, stdin and exit status", async () => {
      const version = await exec([node as string, launcher(), "--version"]);
      expect(version).toMatchObject({ code: 0, out: `seshi ${VERSION}\n` });
      const echoed = await exec([node as string, launcher(), "--stdin", "a b", "c"], {
        stdin: "from stdin\n",
        env: { PATH: process.env.PATH ?? "", EXIT: "7" },
      });
      expect(echoed.out).toBe("args:--stdin a b c\nfrom stdin\n");
      expect(echoed.code).toBe(7);
    });

    it("ends the way the binary ended when a signal ends it", async () => {
      const killed = await exec([node as string, launcher(), "--signal"]);
      expect(killed.signal).toBe("SIGTERM");
    });

    it("repairs a platform binary whose executable bit was lost", async () => {
      const bin = join(project, "node_modules", hostTarget().npm, "bin/seshi");
      chmodSync(bin, 0o644);
      expect((await exec([node as string, launcher(), "--version"])).code).toBe(0);
      expect(statSync(bin).mode & 0o111).not.toBe(0);
    });

    it("says what to do when the platform package is missing", async () => {
      const alone = join(lonely, "node_modules/seshi/bin/seshi.js");
      const ran = await exec([node as string, alone, "--version"]);
      expect(ran.code).toBe(1);
      expect(ran.err).toContain(`the package ${hostTarget().npm}`);
      expect(ran.err).toContain("--omit=optional");
    });

    it("imports @seshi/client and @seshi/model as ES modules", async () => {
      const script = join(project, "use.mjs");
      writeFileSync(
        script,
        [
          'import { HttpSessionDB, SessionRejected, authConfig } from "@seshi/client";',
          'import { VERSION, canonicalText, parseTrace } from "@seshi/model";',
          "const db = new HttpSessionDB({ server: 'http://127.0.0.1:1', token: 't' });",
          "console.log(JSON.stringify({ VERSION, db: typeof db.getSession, fns: [typeof authConfig, typeof canonicalText, typeof parseTrace], err: new SessionRejected('x', 'y') instanceof Error }));",
        ].join("\n"),
      );
      const ran = await exec([node as string, script], { cwd: project });
      expect(ran.err).toBe("");
      expect(JSON.parse(ran.out)).toEqual({
        VERSION,
        db: "function",
        fns: ["function", "function", "function"],
        err: true,
      });
    });

    it("gives TypeScript users the declarations", async () => {
      const file = join(project, "use.ts");
      writeFileSync(
        file,
        [
          'import { HttpSessionDB, type StoredTrace } from "@seshi/client";',
          'import type { Visibility } from "@seshi/model";',
          "const db: HttpSessionDB = new HttpSessionDB({ server: 'http://x', token: 't' });",
          "const v: Visibility = 'org';",
          "export async function f(): Promise<StoredTrace | null> { return db.getTrace('claude-code', 's'); }",
          "export { v };",
        ].join("\n"),
      );
      writeFileSync(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            lib: ["ES2023", "DOM"],
            types: [],
          },
          files: ["use.ts"],
        }),
      );
      const tsc = join(process.cwd(), "node_modules/typescript/bin/tsc");
      const ran = await exec([process.execPath, tsc, "-p", join(project, "tsconfig.json")]);
      expect(ran.out + ran.err).toBe("");
      expect(ran.code).toBe(0);
    });
  });
});
