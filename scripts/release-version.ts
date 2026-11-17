/** Sets the release's version where the repository keeps it: packages/ts/model/package.json (the
 * one version; `VERSION` reads it) and that workspace's entry in bun.lock, which `bun install`
 * leaves alone on a version-only change (release.config.js). Exported for its test. */

import { join } from "node:path";

export const VERSIONED = ["packages/ts/model", "integrations/cursor/extension"] as const;

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function syncLock(lock: string, names: readonly string[], version: string): string {
  let synced = lock;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    synced = synced.replace(
      new RegExp(`("name": "${escaped}",\\n\\s*"version": ")[^"]+(")`, "g"),
      `$1${version}$2`,
    );
  }
  return synced;
}

export async function setVersion(root: string, version: string): Promise<void> {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
  const names: string[] = [];
  for (const pkg of VERSIONED) {
    const path = join(root, pkg, "package.json");
    const manifest = await Bun.file(path).json();
    names.push(manifest.name);
    if (manifest.version !== version) {
      manifest.version = version;
      await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    console.log(`${pkg}/package.json: ${version}`);
  }
  const lockPath = join(root, "bun.lock");
  const lock = await Bun.file(lockPath).text();
  const synced = syncLock(lock, names, version);
  if (synced !== lock) await Bun.write(lockPath, synced);
  console.log(`bun.lock: ${version}`);
}

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  if (!SEMVER.test(version)) {
    console.error(
      `usage: bun run scripts/release-version.ts <X.Y.Z>; got ${JSON.stringify(process.argv[2])}`,
    );
    process.exit(2);
  }
  await setVersion(join(import.meta.dir, ".."), version);
}
