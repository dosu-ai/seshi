/** The layer check (X3.2), run by `bun run check`. Declaring dependencies in each package.json is
 * not enough on its own, so every import in the repository is read and checked against the
 * layers:
 *
 *   0  ts/model
 *   1  ts/kit, ts/formats, ts/redact, ts/config, ts/store, ts/client
 *   2  ts/pipeline, ts/auth, integrations/*
 *   3  ts/sources, ts/search
 *   4  ts/instance
 *   5  ts/api, ts/capture
 *   6  apps/seshi
 *
 * A package imports only from lower layers. On top of that: an integration imports only
 * ts/model, ts/kit and ts/formats; ts/client only ts/model; ts/capture only ts/model, ts/kit,
 * ts/redact, ts/config and ts/client (never ts/instance); only an app imports an integration
 * (it builds the static registry and passes it down, X3.11); nothing imports tests/ or
 * scripts/; an import between packages goes through the package name, never a relative path;
 * and every workspace package imported is declared in the importer's package.json, so the
 * isolated install resolves it. tests/ and scripts/ may import any package.
 *
 * A new package under packages/ts must be given a layer here before it passes. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Layers of the packages under packages/ts, by folder name. */
export const PACKAGE_LAYERS: Readonly<Record<string, number>> = {
  model: 0,
  kit: 1,
  formats: 1,
  redact: 1,
  config: 1,
  store: 1,
  client: 1,
  pipeline: 2,
  auth: 2,
  sources: 3,
  search: 3,
  instance: 4,
  api: 5,
  capture: 5,
};

export const INTEGRATION_LAYER = 2;
export const APP_LAYER = 6;

/** Packages that may import only these, whatever their layer allows (by unit id). */
const ONLY: Readonly<Record<string, readonly string[]>> = {
  "packages/ts/client": ["packages/ts/model"],
  "packages/ts/capture": [
    "packages/ts/model",
    "packages/ts/kit",
    "packages/ts/redact",
    "packages/ts/config",
    "packages/ts/client",
  ],
};

const INTEGRATION_MAY_IMPORT = ["packages/ts/model", "packages/ts/kit", "packages/ts/formats"];

export type UnitKind = "package" | "integration" | "app" | "tests" | "scripts";

export interface Unit {
  /** The folder, relative to the root (`packages/ts/model`, `tests`). */
  id: string;
  kind: UnitKind;
  /** The package name, for units with a package.json. */
  name?: string;
  /** Undefined for tests and scripts, which sit outside the layers. */
  layer?: number;
  dir: string;
  /** Workspace packages this unit declares (dependencies and devDependencies). */
  declared: Set<string>;
}

export interface Violation {
  file: string;
  specifier: string;
  message: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function declaredOf(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = manifest[field];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** Every unit in the repository at `root`, and problems with the units themselves. */
export function discoverUnits(root: string): { units: Unit[]; problems: string[] } {
  const units: Unit[] = [];
  const problems: string[] = [];
  const add = (id: string, kind: UnitKind, layer: number | undefined) => {
    const dir = join(root, id);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      problems.push(`${id}: has no package.json`);
      return;
    }
    const manifest = readJson(manifestPath);
    units.push({
      id,
      kind,
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      layer,
      dir,
      declared: declaredOf(manifest),
    });
  };
  for (const name of subdirs(join(root, "packages", "ts"))) {
    const layer = PACKAGE_LAYERS[name];
    if (layer === undefined) {
      problems.push(`packages/ts/${name}: has no layer; add it to scripts/check-layers.ts`);
      continue;
    }
    add(`packages/ts/${name}`, "package", layer);
  }
  for (const name of subdirs(join(root, "integrations"))) {
    add(`integrations/${name}`, "integration", INTEGRATION_LAYER);
  }
  for (const name of subdirs(join(root, "apps"))) add(`apps/${name}`, "app", APP_LAYER);
  const rootManifest = existsSync(join(root, "package.json"))
    ? declaredOf(readJson(join(root, "package.json")))
    : new Set<string>();
  for (const id of ["tests", "scripts"] as const) {
    if (existsSync(join(root, id))) {
      units.push({ id, kind: id, dir: join(root, id), declared: rootManifest });
    }
  }
  return { units, problems };
}

/** The TypeScript files of a unit, test files included; never node_modules or testdata. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      if (name === "node_modules" || name === "testdata" || name.startsWith(".")) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(dir);
  return files;
}

/** Every module specifier a file imports: static imports and re-exports (types included),
 * `import()` and `require()`. */
export function importsOf(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName);
}

function unitOfPath(units: readonly Unit[], path: string): Unit | undefined {
  return units.find((unit) => path === unit.dir || path.startsWith(unit.dir + sep));
}

/** The workspace unit a bare specifier names (`@seshi/model`, `seshi/integrations`), if any. */
function unitOfName(units: readonly Unit[], specifier: string): Unit | undefined {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return units.find((unit) => unit.name !== undefined && unit.name === name);
}

/** Why `from` may not import `to`, or undefined when it may. */
export function refusal(from: Unit, to: Unit): string | undefined {
  if (from.kind === "tests" || from.kind === "scripts") return undefined;
  if (to.kind === "tests" || to.kind === "scripts") return `nothing may import ${to.id}/`;
  if (to.kind === "integration" && from.kind !== "app") {
    return "only apps import integrations; pass what they provide down instead (X3.11)";
  }
  if (from.kind === "integration" && !INTEGRATION_MAY_IMPORT.includes(to.id)) {
    return "an integration imports only ts/model, ts/kit and ts/formats (X3.2)";
  }
  const only = ONLY[from.id];
  if (only && !only.includes(to.id)) {
    return `${from.id} imports only ${only.join(", ")} (X3.2)`;
  }
  if ((to.layer ?? 0) >= (from.layer ?? 0)) {
    return `layer ${from.layer} may import only from lower layers; ${to.id} is layer ${to.layer} (X3.2)`;
  }
  return undefined;
}

export interface CheckResult {
  violations: Violation[];
  problems: string[];
  files: number;
  imports: number;
}

export function checkLayers(root: string): CheckResult {
  const absolute = resolve(root);
  const { units, problems } = discoverUnits(absolute);
  const violations: Violation[] = [];
  let files = 0;
  let imports = 0;
  for (const unit of units) {
    for (const file of sourceFiles(unit.dir)) {
      files += 1;
      const shown = relative(absolute, file);
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        imports += 1;
        let target: Unit | undefined;
        if (specifier.startsWith(".")) {
          target = unitOfPath(units, resolve(dirname(file), specifier));
          if (target === undefined || target === unit) continue;
          if (unit.kind !== "tests" && unit.kind !== "scripts") {
            violations.push({
              file: shown,
              specifier,
              message: `a relative import reaches into ${target.id}; import it by its package name`,
            });
            continue;
          }
          if (target.kind !== "tests" && target.kind !== "scripts") {
            violations.push({
              file: shown,
              specifier,
              message: `import ${target.id} by its package name (${target.name}), not a path`,
            });
          }
          continue;
        }
        target = unitOfName(units, specifier);
        if (target === undefined || target === unit) continue;
        const why = refusal(unit, target);
        if (why) {
          violations.push({ file: shown, specifier, message: why });
          continue;
        }
        if (target.name && !unit.declared.has(target.name)) {
          const where =
            unit.kind === "tests" || unit.kind === "scripts"
              ? "the root package.json"
              : `${unit.id}/package.json`;
          violations.push({
            file: shown,
            specifier,
            message: `${target.name} is not declared in ${where}`,
          });
        }
      }
    }
  }
  return { violations, problems, files, imports };
}

if (import.meta.main) {
  const root = process.argv[2] ?? resolve(import.meta.dir, "..");
  const { violations, problems, files, imports } = checkLayers(root);
  for (const problem of problems) console.error(`layers: ${problem}`);
  for (const v of violations) console.error(`layers: ${v.file}: '${v.specifier}': ${v.message}`);
  if (problems.length > 0 || violations.length > 0) {
    console.error(`layers: ${problems.length + violations.length} problem(s)`);
    process.exit(1);
  }
  console.log(`layers: ok (${files} files, ${imports} imports)`);
}
