/** install.sh against local release fixtures: file:// folders and a local HTTP server, with
 * stand-in `uname`, `sysctl` and `ldd` on the PATH to play other machines, and a shell script
 * standing in for the binary. Nothing leaves this machine. install.ps1 runs only where `pwsh`
 * is installed; its text is checked against the release targets everywhere. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumFile, tarGz, zip } from "../release/archive";
import { CHECKSUMS, REPOSITORY, TARGETS } from "../release/targets";

const SCRIPT = resolve(import.meta.dirname, "install.sh");
const PS1 = resolve(import.meta.dirname, "install.ps1");
const enc = (s: string) => new TextEncoder().encode(s);
const windows = process.platform === "win32";
const shells = windows ? [] : ["sh", ...(Bun.which("dash") ? ["dash"] : [])];

/** A release under `<root>/releases`: `latest/download/` and `download/v<version>/`, each with
 * every archive (a shell script that prints `seshi <version>`) and SHA256SUMS. */
function writeRelease(root: string, version: string, where: "latest" | "tag" = "latest") {
  const folder =
    where === "latest"
      ? join(root, "releases/latest/download")
      : join(root, `releases/download/v${version}`);
  mkdirSync(folder, { recursive: true });
  const files = new Map<string, Uint8Array>();
  for (const target of TARGETS) {
    const binary = enc(`#!/bin/sh\necho "seshi ${version}"\n`);
    const entries = [
      { name: target.binary, data: binary, mode: 0o755 },
      { name: "LICENSE", data: enc("MIT\n") },
    ];
    const archive = target.os === "windows" ? zip(entries) : tarGz(entries);
    writeFileSync(join(folder, target.asset), archive);
    files.set(target.asset, archive);
  }
  writeFileSync(join(folder, CHECKSUMS), checksumFile(files));
  return folder;
}

interface Machine {
  os?: string;
  arch?: string;
  /** What `sysctl -n sysctl.proc_translated` prints (Rosetta). */
  translated?: string;
  /** What `ldd --version` prints. */
  ldd?: string;
  /** What `getconf GNU_LIBC_VERSION` prints (it fails when not given). */
  glibc?: string;
}

describe.skipIf(windows)("install.sh", () => {
  let dir: string;
  let home: string;
  let fakes: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-install-"));
    home = join(dir, "home");
    fakes = join(dir, "fakes");
    root = join(dir, "site");
    mkdirSync(home, { recursive: true });
    mkdirSync(fakes, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fake(name: string, body: string) {
    const path = join(fakes, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function machine(m: Machine) {
    fake(
      "uname",
      `case "$1" in -m) echo "${m.arch ?? "arm64"}" ;; *) echo "${m.os ?? "Darwin"}" ;; esac`,
    );
    fake("sysctl", `echo "${m.translated ?? "0"}"`);
    if (m.ldd !== undefined) fake("ldd", `echo "${m.ldd}"`);
    if (m.glibc !== undefined) {
      fake(
        "getconf",
        `case "$1" in GNU_LIBC_VERSION) echo "${m.glibc}" ;; LONG_BIT) echo 64 ;; *) exit 1 ;; esac`,
      );
    }
  }

  async function install(
    args: string[],
    options: { shell?: string; env?: Record<string, string>; machine?: Machine } = {},
  ) {
    machine(options.machine ?? {});
    const proc = Bun.spawn([options.shell ?? "sh", SCRIPT, ...args], {
      cwd: dir,
      env: {
        PATH: `${fakes}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        SHELL: "/bin/zsh",
        ...options.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }

  const base = () => pathToFileURL(join(root, "releases")).href;

  for (const shell of shells) {
    it(`installs the latest release from a file:// mirror (${shell})`, async () => {
      writeRelease(root, "1.2.3");
      const bin = join(dir, "bin");
      const ran = await install(["--base-url", base(), "--dir", bin], { shell });
      expect(ran.err).toBe("");
      expect(ran.code).toBe(0);
      expect(ran.out).toContain("Downloading seshi-darwin-arm64.tar.gz");
      expect(ran.out).toContain(`Installed seshi 1.2.3 to ${bin}/seshi`);
      const proc = Bun.spawn([join(bin, "seshi"), "--version"], { stdout: "pipe" });
      expect((await new Response(proc.stdout).text()).trim()).toBe("seshi 1.2.3");
      // The temporary copy was renamed into place, not left behind.
      expect(readdirSync(bin)).toEqual(["seshi"]);
    });
  }

  it("fetches a pinned version from a local HTTP server, with or without the v", async () => {
    writeRelease(root, "1.2.0", "tag");
    const requested: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requested.push(path);
        const file = join(root, decodeURIComponent(path));
        return existsSync(file)
          ? new Response(Bun.file(file))
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/releases/`;
      const bin = join(dir, "bin");
      for (const version of ["1.2.0", "v1.2.0"]) {
        const ran = await install(["--version", version, "--base-url", url, "--dir", bin], {
          machine: { os: "Linux", arch: "x86_64" },
        });
        expect(ran.code).toBe(0);
        expect(ran.out).toContain("Downloading seshi-linux-x64.tar.gz (v1.2.0)");
        expect(ran.out).toContain("Installed seshi 1.2.0");
      }
      expect(new Set(requested)).toEqual(
        new Set([
          "/releases/download/v1.2.0/seshi-linux-x64.tar.gz",
          "/releases/download/v1.2.0/SHA256SUMS",
        ]),
      );
      const missing = await install(["--version", "9.9.9", "--base-url", url, "--dir", bin]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("could not download");
      expect(missing.err).toContain("/releases/download/v9.9.9/seshi-darwin-arm64.tar.gz");
    } finally {
      server.stop(true);
    }
  });

  it("refuses an archive that does not match SHA256SUMS and installs nothing", async () => {
    const folder = writeRelease(root, "1.2.3");
    writeFileSync(
      join(folder, "seshi-darwin-arm64.tar.gz"),
      tarGz([{ name: "seshi", data: enc("evil") }]),
    );
    const bin = join(dir, "bin");
    const ran = await install(["--base-url", base(), "--dir", bin]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("checksum mismatch for seshi-darwin-arm64.tar.gz");
    expect(existsSync(join(bin, "seshi"))).toBe(false);
  });

  it("refuses when SHA256SUMS has no line for the archive", async () => {
    const folder = writeRelease(root, "1.2.3");
    writeFileSync(join(folder, CHECKSUMS), `${"0".repeat(64)}  other.tar.gz\n`);
    const ran = await install(["--base-url", base(), "--dir", join(dir, "bin")]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("SHA256SUMS has no line for seshi-darwin-arm64.tar.gz");
  });

  it("refuses a binary that does not run", async () => {
    const folder = join(root, "releases/latest/download");
    mkdirSync(folder, { recursive: true });
    const archive = tarGz([{ name: "seshi", data: enc("#!/bin/sh\nexit 3\n"), mode: 0o755 }]);
    writeFileSync(join(folder, "seshi-darwin-arm64.tar.gz"), archive);
    writeFileSync(
      join(folder, CHECKSUMS),
      checksumFile(new Map([["seshi-darwin-arm64.tar.gz", archive]])),
    );
    const ran = await install(["--base-url", base(), "--dir", join(dir, "bin")]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("was installed but does not run");
  });

  it.each([
    [{ os: "Darwin", arch: "arm64" }, "seshi-darwin-arm64.tar.gz"],
    [{ os: "Darwin", arch: "x86_64" }, "seshi-darwin-x64.tar.gz"],
    [{ os: "Darwin", arch: "x86_64", translated: "1" }, "seshi-darwin-arm64.tar.gz"],
    [{ os: "Linux", arch: "x86_64" }, "seshi-linux-x64.tar.gz"],
    [{ os: "Linux", arch: "aarch64" }, "seshi-linux-arm64.tar.gz"],
    [{ os: "Linux", arch: "amd64", ldd: "ldd (GNU libc) 2.39" }, "seshi-linux-x64.tar.gz"],
    [
      { os: "Linux", arch: "x86_64", ldd: "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39" },
      "seshi-linux-x64.tar.gz",
    ],
    // An ldd that says nothing useful: getconf names glibc.
    [{ os: "Linux", arch: "x86_64", ldd: "", glibc: "glibc 2.36" }, "seshi-linux-x64.tar.gz"],
  ] as [Machine, string][])("picks the archive for %o", async (m, asset) => {
    writeRelease(root, "1.2.3");
    const ran = await install(["--base-url", base(), "--dir", join(dir, "bin")], { machine: m });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(`Downloading ${asset}`);
  });

  it.each([
    [{ os: "MINGW64_NT-10.0", arch: "x86_64" }, "on Windows, use install.ps1"],
    [{ os: "FreeBSD", arch: "amd64" }, "seshi has no binary for FreeBSD"],
    [{ os: "Linux", arch: "riscv64" }, "seshi has no binary for Linux riscv64"],
    [{ os: "Linux", arch: "x86_64", ldd: "musl libc (x86_64) Version 1.2.4" }, "need glibc"],
  ] as [Machine, string][])("refuses %o", async (m, message) => {
    writeRelease(root, "1.2.3");
    const ran = await install(["--base-url", base(), "--dir", join(dir, "bin")], { machine: m });
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(message);
  });

  it("defaults to ~/.local/bin, or $XDG_BIN_HOME", async () => {
    writeRelease(root, "1.2.3");
    expect((await install(["--base-url", base()])).code).toBe(0);
    expect(existsSync(join(home, ".local/bin/seshi"))).toBe(true);
    const xdg = join(dir, "xdg-bin");
    expect((await install(["--base-url", base()], { env: { XDG_BIN_HOME: xdg } })).code).toBe(0);
    expect(existsSync(join(xdg, "seshi"))).toBe(true);
  });

  it("writes an absolute folder into the startup file when --dir is relative", async () => {
    writeRelease(root, "1.2.3");
    const ran = await install(["--base-url", base(), "--dir", "rel/bin"]);
    expect(ran.code).toBe(0);
    // The script runs in `dir`; its pwd is the real path (macOS's /var is /private/var).
    const abs = join(realpathSync(dir), "rel/bin");
    expect(ran.out).toContain(`Installed seshi 1.2.3 to ${abs}/seshi`);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(`export PATH="${abs}:$PATH"`);
  });

  it("adds the folder to PATH in zsh's startup file once", async () => {
    writeRelease(root, "1.2.3");
    const bin = join(dir, "bin");
    const first = await install(["--base-url", base(), "--dir", bin]);
    expect(first.out).toContain(`Added ${bin} to PATH in ${home}/.zshrc`);
    const second = await install(["--base-url", base(), "--dir", bin]);
    expect(second.out).toContain("already adds");
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rc).toBe(`\n# seshi\nexport PATH="${bin}:$PATH"\n`);
  });

  it.each([
    ["/bin/bash", "Linux", ".bashrc", (bin: string) => `export PATH="${bin}:$PATH"`],
    ["/bin/bash", "Darwin", ".bash_profile", (bin: string) => `export PATH="${bin}:$PATH"`],
    [
      "/usr/bin/fish",
      "Linux",
      ".config/fish/config.fish",
      (bin: string) => `fish_add_path "${bin}"`,
    ],
    ["/bin/ksh", "Linux", ".profile", (bin: string) => `export PATH="${bin}:$PATH"`],
  ])("with SHELL=%s on %s, edits %s", async (shell, os, rc, line) => {
    writeRelease(root, "1.2.3");
    const bin = join(dir, "bin");
    const ran = await install(["--base-url", base(), "--dir", bin], {
      env: { SHELL: shell },
      machine: { os, arch: "x86_64" },
    });
    expect(ran.code).toBe(0);
    expect(readFileSync(join(home, rc), "utf8")).toContain(line(bin));
  });

  it("leaves startup files alone when the folder is on PATH or with --no-modify-path", async () => {
    writeRelease(root, "1.2.3");
    const bin = join(dir, "bin");
    const onPath = await install(["--base-url", base(), "--dir", bin], {
      env: { PATH: `${fakes}:${bin}:${process.env.PATH}` },
    });
    expect(onPath.code).toBe(0);
    const told = await install(["--base-url", base(), "--dir", bin, "--no-modify-path"]);
    expect(told.code).toBe(0);
    expect(told.out).toContain(`${bin} is not on your PATH`);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  it("replaces an installed seshi", async () => {
    const bin = join(dir, "bin");
    writeRelease(root, "1.0.0");
    expect((await install(["--base-url", base(), "--dir", bin])).code).toBe(0);
    writeRelease(root, "1.1.0");
    const ran = await install(["--base-url", base(), "--dir", bin]);
    expect(ran.out).toContain("Installed seshi 1.1.0");
  });

  it("reads only flags: usage, unknown options and bad versions", async () => {
    const help = await install(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: install.sh");
    const unknown = await install(["--frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown option: --frobnicate");
    const bad = await install(["--version", "1.2.3;rm -rf /"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not a version");
    const empty = await install(["--dir"]);
    expect(empty.err).toContain("--dir needs a value");
  });
});

describe("install scripts and release targets agree", () => {
  const sh = readFileSync(SCRIPT, "utf8");
  const ps1 = readFileSync(PS1, "utf8");

  it("name the same repository and checksum file as scripts/release/targets.ts", () => {
    expect(sh).toContain(`REPOSITORY="${REPOSITORY}"`);
    expect(ps1).toContain(`$Repository = '${REPOSITORY}'`);
    expect(ps1).toContain(`[string]$BaseUrl = "https://github.com/${REPOSITORY}/releases"`);
    expect(sh).toContain(`CHECKSUMS="${CHECKSUMS}"`);
    expect(ps1).toContain(`$Checksums = '${CHECKSUMS}'`);
  });

  it("build only asset names the release has", () => {
    // install.sh: seshi-$os-$arch.tar.gz; install.ps1: seshi-windows-$cpu.zip.
    const unix = TARGETS.filter((t) => t.os !== "windows");
    for (const t of unix) {
      expect(t.asset).toBe(`seshi-${t.os}-${t.cpu}.tar.gz`);
      expect(sh).toMatch(new RegExp(`\\bos=${t.os}\\b`));
      expect(sh).toMatch(new RegExp(`\\barch=${t.cpu}\\b`));
    }
    expect(sh).toContain('asset="seshi-$os-$arch.tar.gz"');
    for (const t of TARGETS.filter((t) => t.os === "windows")) {
      expect(t.asset).toBe(`seshi-windows-${t.cpu}.zip`);
      expect(ps1).toContain(`$cpu = '${t.cpu}'`);
    }
    expect(ps1).toContain('$asset = "seshi-windows-$cpu.zip"');
  });

  it("never read SESHI_* variables (seshi refuses unknown ones)", () => {
    expect(sh).not.toMatch(/\$\{?SESHI_/);
    expect(ps1).not.toMatch(/\$env:SESHI_/i);
  });

  it("install.ps1 sets nothing in the caller's scope (`irm … | iex` runs it there)", () => {
    // After the param block, everything is inside one `& { … }` child scope.
    const after = ps1.slice(ps1.indexOf("\n)\n") + 3);
    const code = after.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(code[0]).toBe("& {");
    expect(code.at(-1)).toBe("}");
    expect(code.slice(1, -1).every((l) => l.startsWith("  "))).toBe(true);
    expect(code.slice(1, -1).join("\n")).toContain("$ErrorActionPreference = 'Stop'");
  });
});

describe.skipIf(!Bun.which("pwsh"))("install.ps1 (pwsh)", () => {
  it("parses", async () => {
    const proc = Bun.spawn(
      [
        "pwsh",
        "-NoProfile",
        "-Command",
        `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${PS1}', [ref]$null, [ref]$e) | Out-Null; if ($e) { $e; exit 1 }`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
  });

  // Off Windows the script stops at once ("this script is for Windows"), so nothing downloads.
  it.skipIf(process.platform === "win32")(
    "leaves the caller's session as it was when run through iex",
    async () => {
      const proc = Bun.spawn(
        [
          "pwsh",
          "-NoProfile",
          "-Command",
          [
            `try { Get-Content -Raw '${PS1}' | Invoke-Expression } catch { }`,
            "$ErrorActionPreference",
            "$ProgressPreference",
            "[bool](Get-Command Install-Seshi -ErrorAction SilentlyContinue)",
            "[bool](Get-Variable Repository -ErrorAction SilentlyContinue)",
            // Strict mode would make reading an unset variable throw.
            "try { $null = $notSetAnywhere; 'not strict' } catch { 'strict' }",
          ].join("; "),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out.trim().split(/\r?\n/)).toEqual([
        "Continue",
        "Continue",
        "False",
        "False",
        "not strict",
      ]);
    },
  );
});
