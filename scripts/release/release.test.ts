/** The release path end to end on this machine, with the real compiler: build the host's
 * release, install it with install.sh from a local HTTP server, run it through the npm
 * launcher, and put the installed binary through the smoke test (keychain off, so the real
 * keychain is never touched). Everything stays on 127.0.0.1 and in temporary folders. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease, type ReleaseAsset, repositoryVersion } from "./build";
import { buildNpm } from "./npm";
import { serveDir } from "./serve-dir";
import { smoke, smokeEnv } from "./smoke";
import { hostTarget, TARGETS } from "./targets";
import { exec, installPackages } from "./testing";

const VERSION = repositoryVersion();
const INSTALL_SH = resolve(import.meta.dirname, "../install/install.sh");
const supported = TARGETS.some(
  (t) => t.nodePlatform === process.platform && t.cpu === process.arch,
);

describe("smokeEnv", () => {
  const base = {
    PATH: "/bin",
    HOME: "/home/me",
    SESHI_SERVER: "https://elsewhere",
    SESHI_STORE__URL: "s3://real",
    AWS_SECRET_ACCESS_KEY: "secret",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
  };

  it("passes on none of the caller's seshi settings or credentials", () => {
    const env = smokeEnv(base, "/tmp/s", "allowed");
    expect(Object.keys(env).filter((k) => k.startsWith("SESHI_"))).toEqual([]);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/bus");
    expect(env.XDG_CONFIG_HOME).toBe(join("/tmp/s", "config"));
    expect(env.APPDATA).toBe(join("/tmp/s", "appdata"));
  });

  it("keeps the real home for the keychain, and a temporary one with it off", () => {
    expect(smokeEnv(base, "/tmp/s", "required").HOME).toBe("/home/me");
    const off = smokeEnv(base, "/tmp/s", "off");
    expect(off.HOME).toBe(join("/tmp/s", "home"));
    expect(off.SESHI_KEYCHAIN).toBe("false");
  });
});

describe("serveDir", () => {
  it("serves files under its folder and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "seshi-serve-"));
    try {
      mkdirSync(join(root, "latest/download"), { recursive: true });
      writeFileSync(join(root, "latest/download/SHA256SUMS"), "sums\n");
      writeFileSync(join(tmpdir(), "seshi-serve-outside.txt"), "outside\n");
      const fetch = serveDir(root);
      const get = (path: string) => fetch(new Request(`http://127.0.0.1${path}`));
      expect(await get("/latest/download/SHA256SUMS").text()).toBe("sums\n");
      expect(get("/latest/download").status).toBe(404);
      expect(get("/missing").status).toBe(404);
      expect(get("/%2e%2e/seshi-serve-outside.txt").status).toBe(404);
      expect(get("/..%2Fseshi-serve-outside.txt").status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(tmpdir(), "seshi-serve-outside.txt"), { force: true });
    }
  });
});

describe.skipIf(!supported || process.platform === "win32")("the host's release", () => {
  let dir: string;
  let release: string;
  let assets: ReleaseAsset[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-e2e-"));
    release = join(dir, "releases/latest/download");
    assets = await buildRelease({ out: release, targets: [hostTarget()] });
  }, 180_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is one archive, the install scripts and SHA256SUMS", () => {
    expect(assets.map((a) => a.name)).toEqual([hostTarget().asset, "install.sh", "install.ps1"]);
    expect(existsSync(join(release, "SHA256SUMS"))).toBe(true);
  });

  it("installs with install.sh from a local server, and the binary runs", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: serveDir(dir),
    });
    try {
      const bin = join(dir, "bin");
      const ran = await exec(
        [
          "sh",
          INSTALL_SH,
          "--base-url",
          `http://127.0.0.1:${server.port}/releases`,
          "--dir",
          bin,
          "--no-modify-path",
        ],
        { env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home") } },
      );
      expect(ran.err).toBe("");
      expect(ran.out).toContain(`Installed seshi ${VERSION} to ${bin}/seshi`);
      const version = await exec([join(bin, "seshi"), "--version"]);
      expect(version.out.trim()).toBe(`seshi ${VERSION}`);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  it("signs in and out with the installed binary (keychain off)", async () => {
    const binary = join(release, "bin", hostTarget().id, hostTarget().binary);
    const result = await smoke({ binary, version: VERSION, keychain: "off" });
    expect(result).toEqual({ version: VERSION, storedIn: "file" });
  }, 120_000);

  it.skipIf(!Bun.which("node"))(
    "runs through the npm launcher",
    async () => {
      const out = join(dir, "npm");
      const packages = await buildNpm({
        version: VERSION,
        from: release,
        out,
        targets: [hostTarget()],
        libraries: false,
      });
      const project = join(dir, "project");
      installPackages(project, packages);
      const launcher = join(project, "node_modules/seshi/bin/seshi.js");
      const version = await exec([Bun.which("node") as string, launcher, "--version"]);
      expect(version).toMatchObject({ code: 0, out: `seshi ${VERSION}\n` });
      const unknown = await exec([Bun.which("node") as string, launcher, "no-such-command"]);
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("unknown command");
    },
    60_000,
  );
});
