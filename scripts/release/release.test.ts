/** The release path end to end on this machine, with the real compiler: build the host's
 * release, install it with install.sh from a local HTTP server, run it through the npm
 * launcher, and put the installed binary through the smoke test (keychain off, so the real
 * keychain is never touched). Everything stays on 127.0.0.1 and in temporary folders. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease, type ReleaseAsset, repositoryVersion } from "./build";
import { buildNpm } from "./npm";
import { serveDir } from "./serve-dir";
import {
  commandsIn,
  SMOKE_PACK,
  smoke,
  smokeEnv,
  smokeTranscript,
  startsWithProgram,
} from "./smoke";
import { extensionAsset, hostTarget, TARGETS } from "./targets";
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

  it("keeps capture's state in the temporary folder", () => {
    expect(smokeEnv(base, "/tmp/s", "required").XDG_STATE_HOME).toBe(join("/tmp/s", "state"));
    expect(smokeEnv(base, "/tmp/s", "required").LOCALAPPDATA).toBe(join("/tmp/s", "localappdata"));
  });

  it("keeps the real home for the keychain, and a temporary one with it off", () => {
    expect(smokeEnv(base, "/tmp/s", "required").HOME).toBe("/home/me");
    const off = smokeEnv(base, "/tmp/s", "off");
    expect(off.HOME).toBe(join("/tmp/s", "home"));
    expect(off.SESHI_KEYCHAIN).toBe("false");
  });
});

describe("the smoke test's upload and install checks", () => {
  it("has a pack whose rule matches the transcript's secret, and a transcript long enough to keep", () => {
    const text = smokeTranscript("/work/code");
    expect(SMOKE_PACK).toContain("pattern = 'SMOKE-[0-9]{6}'");
    expect(text).toMatch(/SMOKE-\d{6}/);
    expect(text.length).toBeGreaterThan(2000);
    expect(JSON.parse(text.split("\n")[0] as string).cwd).toBe("/work/code");
  });

  it("finds every command in an agent's settings, and tells the binary's path from bare seshi", () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/opt/seshi/seshi hook claude-code Stop" }] }],
      },
      statusLine: { type: "command", command: '"/my apps/seshi" statusline' },
    };
    expect(commandsIn(settings)).toEqual([
      "/opt/seshi/seshi hook claude-code Stop",
      '"/my apps/seshi" statusline',
    ]);
    expect(startsWithProgram("/opt/seshi/seshi hook claude-code Stop", "/opt/seshi/seshi")).toBe(
      true,
    );
    expect(startsWithProgram('"/my apps/seshi" statusline', "/my apps/seshi")).toBe(true);
    expect(startsWithProgram("seshi hook claude-code Stop", "/opt/seshi/seshi")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("smoke", () => {
  it("stops and reports a server that never comes up, rather than waiting on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seshi-smoke-stuck-"));
    try {
      const binary = join(dir, "seshi");
      writeFileSync(
        binary,
        [
          "#!/bin/sh",
          'case "$1" in',
          // Slower than the readiness wait, as a loaded machine can be: it must not count.
          '  --version) sleep 1.5; echo "seshi 9.9.9" ;;',
          '  admin) printf "org key\\n  sk-test\\n" ;;',
          '  serve) echo "never listening" >&2; exec sleep 600 ;;',
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const started = Date.now();
      // Only the wait for the server is short; commands keep the per-command timeout.
      await expect(smoke({ binary, keychain: "off", readyTimeout: 1_000 })).rejects.toThrow(
        /did not come up[\s\S]*never listening/,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
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
    // The extension is packaged by vsce, fetched from npm; CI's test job packages it for real.
    assets = await buildRelease({
      out: release,
      targets: [hostTarget()],
      packageExtension: async (outfile) => writeFileSync(outfile, "a vsix"),
    });
  }, 180_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is one archive, the install scripts, the Cursor extension and SHA256SUMS", () => {
    expect(assets.map((a) => a.name)).toEqual([
      hostTarget().asset,
      "install.sh",
      "install.ps1",
      extensionAsset(repositoryVersion()),
    ]);
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

      // Through the launcher, hooks still name the platform package's binary, never the
      // launcher: an agent's turn does not start Node.
      const home = join(dir, "npm-home");
      mkdirSync(home, { recursive: true });
      const install = await exec(
        [Bun.which("node") as string, launcher, "capture", "install", "claude-code", "--json"],
        {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            XDG_CONFIG_HOME: join(home, "config"),
            XDG_STATE_HOME: join(home, "state"),
            SESHI_KEYCHAIN: "false",
            NO_COLOR: "1",
          },
        },
      );
      expect(install.code, install.err).toBe(0);
      const binary = realpathSync(
        join(project, "node_modules", hostTarget().npm, "bin", hostTarget().binary),
      );
      const commands = commandsIn(
        JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")),
      );
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(startsWithProgram(command, binary)).toBe(true);
    },
    60_000,
  );
});
