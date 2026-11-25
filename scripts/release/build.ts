import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildCommand, checkLanceNative, stripLanceNative } from "../build-binary";
import { checksumFile, readArchive, sha256, tarGz, zip } from "./archive";
import { adhocSign } from "./macho-sign";
import {
  CHECKSUMS,
  extensionAsset,
  hostTarget,
  INSTALL_SCRIPTS,
  serverAsset,
  TARGETS,
  type Target,
  targetById,
} from "./targets";

export const ROOT = resolve(import.meta.dirname, "../..");

export interface ReleaseAsset {
  name: string;
  sha256: string;
  size: number;
  target?: string;
}

export interface BuildReleaseOptions {
  root?: string;
  out: string;
  targets?: readonly Target[];
  version?: string;
  mtime?: number;
  /** Compiles `target`; with `server`, the server build (`main-server.ts`, with LanceDB). */
  compile?: (target: Target, outfile: string, server: boolean) => Promise<void>;
  /** Packages the Cursor extension into `outfile` (a .vsix). */
  packageExtension?: (outfile: string) => Promise<void>;
  log?: (line: string) => void;
}

export async function packageCursorExtension(outfile: string, root = ROOT): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "run", join(root, "integrations/cursor/extension/build.ts"), "--vsix", outfile],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`packaging the Cursor extension failed (${code}):\n${out}${err}`);
}

export function repositoryVersion(root = ROOT): string {
  const manifest = JSON.parse(readFileSync(join(root, "packages/ts/model/package.json"), "utf8"));
  return manifest.version as string;
}

/** What a compiled binary needs before it ships: a darwin binary gets a fresh ad-hoc signature,
 * because Bun leaves its own, no longer valid, Developer ID signature on the x64 build
 * (`macho-sign.ts`). Both darwin targets are signed the same way, on any build machine. */
export function finishBinary(target: Target, outfile: string): void {
  if (target.os !== "darwin") return;
  writeFileSync(outfile, adhocSign(readFileSync(outfile), "seshi"));
}

export async function compileTarget(
  target: Target,
  outfile: string,
  root = ROOT,
  server = false,
): Promise<void> {
  if (server) {
    checkLanceNative(root, target.bun);
    stripLanceNative(root, target.bun);
  }
  const { argv } = buildCommand({ root, target: target.bun, outfile, server });
  mkdirSync(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`compiling ${target.id} failed (${code}):\n${out}${err}`);
  finishBinary(target, outfile);
}

export function archiveFor(target: Target, binary: Uint8Array, license: Uint8Array, mtime = 0) {
  const entries = [
    { name: target.binary, data: binary, mode: 0o755 },
    { name: "LICENSE", data: license, mode: 0o644 },
  ];
  return target.os === "windows" ? zip(entries, mtime) : tarGz(entries, mtime);
}

export async function buildRelease(options: BuildReleaseOptions): Promise<ReleaseAsset[]> {
  const root = options.root ?? ROOT;
  const log = options.log ?? (() => {});
  const version = repositoryVersion(root);
  if (options.version !== undefined && options.version !== version) {
    throw new Error(
      `--version ${options.version} but packages/ts/model/package.json says ${version}; run scripts/release-version.ts first`,
    );
  }
  const targets = options.targets ?? TARGETS;
  const mtime = options.mtime ?? Date.now();
  const compile =
    options.compile ??
    ((t: Target, outfile: string, server: boolean) => compileTarget(t, outfile, root, server));
  const license = readFileSync(join(root, "LICENSE"));
  mkdirSync(options.out, { recursive: true });

  const files = new Map<string, Uint8Array>();
  const assets: ReleaseAsset[] = [];
  const builds = targets.flatMap((target) => {
    const server = serverAsset(target);
    return [
      { target, asset: target.asset, dir: target.id, server: false },
      ...(server ? [{ target, asset: server, dir: `${target.id}-server`, server: true }] : []),
    ];
  });
  for (const { target, asset, dir, server } of builds) {
    const outfile = join(options.out, "bin", dir, target.binary);
    rmSync(outfile, { force: true });
    log(`compile ${dir} (${target.bun})`);
    await compile(target, outfile, server);
    const binary = readFileSync(outfile);
    const archive = archiveFor(target, binary, license, mtime);
    const back = readArchive(asset, archive).find((e) => e.name === target.binary);
    if (!back || sha256(back.data) !== sha256(binary)) {
      throw new Error(`${asset}: the archived binary differs from the compiled one`);
    }
    writeFileSync(join(options.out, asset), archive);
    files.set(asset, archive);
    assets.push({
      name: asset,
      sha256: sha256(archive),
      size: archive.byteLength,
      ...(server ? {} : { target: target.id }),
    });
    if (target.id === hostTargetId()) await checkRuns(outfile, version);
  }
  for (const script of INSTALL_SCRIPTS) {
    const data = readFileSync(join(root, "scripts/install", script));
    writeFileSync(join(options.out, script), data);
    files.set(script, data);
    assets.push({ name: script, sha256: sha256(data), size: data.byteLength });
  }
  const vsix = extensionAsset(version);
  const manifest = JSON.parse(
    readFileSync(join(root, "integrations/cursor/extension/package.json"), "utf8"),
  ) as { version: string };
  if (manifest.version !== version) {
    throw new Error(
      `integrations/cursor/extension/package.json says ${manifest.version}, not ${version}; run scripts/release-version.ts first`,
    );
  }
  log(`package ${vsix}`);
  await (options.packageExtension ?? ((outfile) => packageCursorExtension(outfile, root)))(
    join(options.out, vsix),
  );
  const extension = readFileSync(join(options.out, vsix));
  files.set(vsix, extension);
  assets.push({ name: vsix, sha256: sha256(extension), size: extension.byteLength });
  writeFileSync(join(options.out, CHECKSUMS), checksumFile(files));
  log(`${CHECKSUMS}: ${files.size} assets`);
  return assets;
}

function hostTargetId(): string | undefined {
  try {
    return hostTarget().id;
  } catch {
    return undefined;
  }
}

/** The caller's environment without its seshi settings: the binary must not read them, and
 * an empty environment breaks Windows programs (no SYSTEMROOT). */
export function binaryEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !name.toUpperCase().startsWith("SESHI_")) env[name] = value;
  }
  return env;
}

async function checkRuns(binary: string, version: string): Promise<void> {
  const proc = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: binaryEnv(process.env),
  });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0 || out.trim() !== `seshi ${version}`) {
    throw new Error(`${binary} --version printed ${JSON.stringify(out.trim())} (exit ${code})`);
  }
}

export function selectTargets(names: readonly string[]): Target[] {
  if (names.length === 0) return [...TARGETS];
  const picked = names.map((name) => (name === "host" ? hostTarget() : targetById(name)));
  return TARGETS.filter((t) => picked.includes(t));
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: "string" },
      target: { type: "string", multiple: true },
      out: { type: "string" },
    },
    strict: true,
  });
  try {
    const assets = await buildRelease({
      out: resolve(values.out ?? join(ROOT, "dist/release")),
      targets: selectTargets(values.target ?? []),
      ...(values.version ? { version: values.version } : {}),
      log: (line) => console.log(`release: ${line}`),
    });
    for (const asset of assets) {
      console.log(`${asset.sha256}  ${asset.name}  (${(asset.size / 1e6).toFixed(1)} MB)`);
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
