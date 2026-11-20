/** Sets the release's version where the repository keeps it: packages/ts/model/package.json (the
 * one version; `VERSION` reads it) and that workspace's entry in bun.lock, which `bun install`
 * leaves alone on a version-only change (release.config.js), the Python client's
 * `__version__` (packages/py/client, whose pyproject.toml reads it), and the Helm chart's
 * `version` and `appVersion` (charts/seshi). Exported for its test. */

import { join } from "node:path";

export const VERSIONED = ["packages/ts/model", "integrations/cursor/extension"] as const;

/** The Python client's version file: one `__version__ = "X.Y.Z"` line. */
export const PYTHON_VERSION_FILE = "packages/py/client/src/seshi/_version.py";

const PYTHON_VERSION = /^__version__ = "[^"]*"$/m;

export function syncPythonVersion(source: string, version: string): string {
  if (!PYTHON_VERSION.test(source)) throw new Error(`${PYTHON_VERSION_FILE}: no __version__ line`);
  return source.replace(PYTHON_VERSION, `__version__ = "${version}"`);
}

/** The Helm chart: its `version` and `appVersion` are both the release. */
export const CHART_FILE = "charts/seshi/Chart.yaml";

const CHART_VERSION = /^version: .*$/m;
const CHART_APP_VERSION = /^appVersion: .*$/m;

export function syncChartVersion(source: string, version: string): string {
  for (const [line, name] of [
    [CHART_VERSION, "version"],
    [CHART_APP_VERSION, "appVersion"],
  ] as const) {
    const found = source.match(new RegExp(line.source, "gm")) ?? [];
    if (found.length !== 1) throw new Error(`${CHART_FILE}: expected one ${name} line`);
  }
  return source
    .replace(CHART_VERSION, `version: ${version}`)
    .replace(CHART_APP_VERSION, `appVersion: "${version}"`);
}

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
  const pythonPath = join(root, PYTHON_VERSION_FILE);
  const python = await Bun.file(pythonPath).text();
  const pythonSynced = syncPythonVersion(python, version);
  if (pythonSynced !== python) await Bun.write(pythonPath, pythonSynced);
  console.log(`${PYTHON_VERSION_FILE}: ${version}`);
  const chartPath = join(root, CHART_FILE);
  const chart = await Bun.file(chartPath).text();
  const chartSynced = syncChartVersion(chart, version);
  if (chartSynced !== chart) await Bun.write(chartPath, chartSynced);
  console.log(`${CHART_FILE}: ${version}`);
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
