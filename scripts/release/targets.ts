/** The platforms seshi ships a binary for (F8.4): macOS arm64 and x64, Linux arm64 and x64
 * (glibc), Windows x64, and Windows arm64, which Bun's compiler supports. Every channel ships
 * the same files: the GitHub release archives, the npm platform packages
 * (`@seshi/cli-<id>`) and the install scripts all use the ids below.
 *
 * x64 builds use Bun's `-baseline` target: it runs on CPUs without AVX2, and under Rosetta 2
 * on Apple silicon, which has no AVX. (Bun 1.4 ships one x64 runtime for both names; the
 * suffix keeps older Bun versions on the safe one.) */

export type Os = "darwin" | "linux" | "windows";
export type Cpu = "x64" | "arm64";

export interface Target {
  /** `darwin-arm64`, `windows-x64`…: the asset, npm package and install-script name. */
  id: string;
  os: Os;
  cpu: Cpu;
  /** The `bun build --compile --target` value. */
  bun: string;
  /** Node's `process.platform` for this OS (npm's `os` field). */
  nodePlatform: NodeJS.Platform;
  /** The binary's file name inside an archive or package. */
  binary: "seshi" | "seshi.exe";
  /** The release asset that holds the binary. */
  asset: string;
  /** The npm package that holds the binary. */
  npm: string;
  /** Linux only: the C library the binary links against (npm's `libc` field). */
  libc?: "glibc";
}

function target(os: Os, cpu: Cpu): Target {
  const id = `${os}-${cpu}`;
  const windows = os === "windows";
  return {
    id,
    os,
    cpu,
    bun: `bun-${id}${cpu === "x64" ? "-baseline" : ""}`,
    nodePlatform: windows ? "win32" : os,
    binary: windows ? "seshi.exe" : "seshi",
    asset: `seshi-${id}.${windows ? "zip" : "tar.gz"}`,
    npm: `@seshi/cli-${id}`,
    ...(os === "linux" ? { libc: "glibc" as const } : {}),
  };
}

/** Every release target, in the order they are built and listed. */
export const TARGETS: readonly Target[] = [
  target("darwin", "arm64"),
  target("darwin", "x64"),
  target("linux", "x64"),
  target("linux", "arm64"),
  target("windows", "x64"),
  target("windows", "arm64"),
];

/** The checksum file every release carries: `sha256sum` format, one line per asset. */
export const CHECKSUMS = "SHA256SUMS";

/** The install scripts attached to every release, so
 * `…/releases/latest/download/install.sh` is a stable URL. */
export const INSTALL_SCRIPTS = ["install.sh", "install.ps1"] as const;

/** Where releases are published. One place, so a repository rename (X3.8) is one edit here and
 * in the two install scripts (a test keeps them in step). */
export const REPOSITORY = "dosu-ai/sessiondb";

export function targetById(id: string): Target {
  const found = TARGETS.find((t) => t.id === id);
  if (!found) {
    throw new Error(`unknown target ${JSON.stringify(id)}; one of ${TARGETS.map((t) => t.id)}`);
  }
  return found;
}

/** The target for a Node/Bun `platform` and `arch`, or undefined when seshi ships none. */
export function targetFor(platform: string, arch: string): Target | undefined {
  return TARGETS.find((t) => t.nodePlatform === platform && t.cpu === arch);
}

/** This machine's target. Throws on a platform seshi does not ship. */
export function hostTarget(platform = process.platform, arch = process.arch): Target {
  const found = targetFor(platform, arch);
  if (!found) throw new Error(`seshi ships no binary for ${platform}-${arch}`);
  return found;
}
