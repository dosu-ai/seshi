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
  id: string;
  os: Os;
  cpu: Cpu;
  bun: string;
  nodePlatform: NodeJS.Platform;
  binary: "seshi" | "seshi.exe";
  asset: string;
  npm: string;
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

export const TARGETS: readonly Target[] = [
  target("darwin", "arm64"),
  target("darwin", "x64"),
  target("linux", "x64"),
  target("linux", "arm64"),
  target("windows", "x64"),
  target("windows", "arm64"),
];

export const CHECKSUMS = "SHA256SUMS";

export const INSTALL_SCRIPTS = ["install.sh", "install.ps1"] as const;

/** The Cursor extension, packaged for Open VSX (integrations/cursor/extension). */
export function extensionAsset(version: string): string {
  return `seshi-cursor-${version}.vsix`;
}

export const REPOSITORY = "dosu-ai/sessiondb";

export function targetById(id: string): Target {
  const found = TARGETS.find((t) => t.id === id);
  if (!found) {
    throw new Error(`unknown target ${JSON.stringify(id)}; one of ${TARGETS.map((t) => t.id)}`);
  }
  return found;
}

export function targetFor(platform: string, arch: string): Target | undefined {
  return TARGETS.find((t) => t.nodePlatform === platform && t.cpu === arch);
}

export function hostTarget(platform = process.platform, arch = process.arch): Target {
  const found = targetFor(platform, arch);
  if (!found) throw new Error(`seshi ships no binary for ${platform}-${arch}`);
  return found;
}
