/** Builds the npm packages of a release (F8.4, X3.8) from its GitHub assets, so npm ships the
 * very binaries the release does:
 *
 * - `@seshi/cli-<id>`: one per target, holding `bin/seshi` (`bin/seshi.exe`), with `os`, `cpu`
 *   and (Linux) `libc` set so npm installs only the one for the machine.
 * - `seshi`: the launcher (`bin/seshi.js`, scripts/release/launcher.ts) with every platform
 *   package as an optional dependency at the same version. `npm i -g seshi`, `npx seshi`.
 * - `@seshi/model` and `@seshi/client`: the libraries, bundled to ESM for Node and Bun with
 *   their declarations. The workspaces themselves stay private and source-only (X3.4); these
 *   are built copies.
 *
 *   bun run release:npm --version <X.Y.Z> [--from dist/release] [--out dist/npm]
 *
 * Every archive is checked against `SHA256SUMS` before its binary is taken. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseChecksums, readArchive, sha256 } from "./archive";
import { CHECKSUMS, REPOSITORY, TARGETS, type Target } from "./targets";

export const ROOT = resolve(import.meta.dirname, "../..");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The libraries published from the workspace, in publish order (a dependency first). */
export const LIBRARIES = [
  {
    name: "@seshi/model",
    dir: "packages/ts/model",
    out: "model",
    description:
      "seshi's shared types: the canonical trace, stored objects and the session API; canonical text and hashing.",
  },
  {
    name: "@seshi/client",
    dir: "packages/ts/client",
    out: "client",
    description: "The typed HTTP client for a seshi server. Runs on Node 20+ and Bun.",
  },
] as const;

export interface NpmPackage {
  name: string;
  /** The folder holding its package.json. */
  dir: string;
}

function common(version: string) {
  return {
    version,
    license: "MIT",
    homepage: `https://github.com/${REPOSITORY}#readme`,
    repository: { type: "git", url: `git+https://github.com/${REPOSITORY}.git` },
    bugs: { url: `https://github.com/${REPOSITORY}/issues` },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const OS_NAMES = { darwin: "macOS", linux: "Linux", windows: "Windows" } as const;

/** The manifest of `target`'s platform package. */
export function platformManifest(target: Target, version: string): Record<string, unknown> {
  return {
    name: target.npm,
    ...common(version),
    description: `The seshi binary for ${OS_NAMES[target.os]} ${target.cpu}. Install seshi, not this package.`,
    os: [target.nodePlatform],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ["bin/"],
    preferUnplugged: true,
  };
}

/** The `seshi` launcher's manifest. */
export function launcherManifest(
  version: string,
  targets: readonly Target[] = TARGETS,
): Record<string, unknown> {
  return {
    name: "seshi",
    ...common(version),
    description:
      "seshi: capture, ingest, redact, store and search coding-agent sessions. The one seshi binary for this platform.",
    keywords: ["coding-agents", "sessions", "claude-code", "codex", "cursor", "cli"],
    bin: { seshi: "bin/seshi.js" },
    files: ["bin/"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(targets.map((t) => [t.npm, version])),
  };
}

/** The face-free glyph, mint on night ink, as npm pages show it (B1.5). It is read from the
 * release's own tag, so a page never changes after it is published. No face below 48 px
 * (B1.2): the glyph has none at any size. */
export function badgeUrl(version: string): string {
  return `https://raw.githubusercontent.com/${REPOSITORY}/v${version}/brand/glyph/seshi-glyph-badge.svg`;
}

/** A package's README: the glyph, the title, what it is, and where the docs are. */
export function readme(title: string, body: string, version: string): string {
  return [
    `<img src="${badgeUrl(version)}" alt="" width="64" height="64">`,
    "",
    `# ${title}`,
    "",
    "*Every session has a thread.*",
    "",
    body,
    "",
    `Docs: https://github.com/${REPOSITORY}#readme`,
    "",
  ].join("\n");
}

/** Writes `target`'s platform package with `binary`. */
export function writePlatformPackage(
  out: string,
  target: Target,
  version: string,
  binary: Uint8Array,
  license: Uint8Array,
): NpmPackage {
  const dir = join(out, `cli-${target.id}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  const bin = join(dir, "bin", target.binary);
  writeFileSync(bin, binary);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "LICENSE"), license);
  writeJson(join(dir, "package.json"), platformManifest(target, version));
  writeFileSync(
    join(dir, "README.md"),
    readme(
      target.npm,
      `The \`seshi\` binary for ${OS_NAMES[target.os]} ${target.cpu}. It is installed by the \`seshi\` package (\`npm i -g seshi\`); you do not need to install it yourself.`,
      version,
    ),
  );
  return { name: target.npm, dir };
}

/** Writes the `seshi` launcher package. */
export async function writeLauncherPackage(
  out: string,
  version: string,
  license: Uint8Array,
  targets: readonly Target[] = TARGETS,
): Promise<NpmPackage> {
  const dir = join(out, "seshi");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  const built = await Bun.build({
    entrypoints: [join(import.meta.dirname, "launcher-entry.ts")],
    target: "node",
    format: "cjs",
  });
  if (!built.success) {
    throw new Error(`bundling the launcher failed:\n${built.logs.map(String).join("\n")}`);
  }
  const code = await (built.outputs[0] as Blob).text();
  const bin = join(dir, "bin", "seshi.js");
  writeFileSync(bin, `#!/usr/bin/env node\n${code.replace(/^#!.*\n/, "")}`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "LICENSE"), license);
  writeJson(join(dir, "package.json"), launcherManifest(version, targets));
  writeFileSync(
    join(dir, "README.md"),
    readme(
      "seshi",
      [
        "Capture, ingest, redact, store and search coding-agent sessions: one binary for the CLI, the agent hooks and the server.",
        "",
        "```sh",
        "npm i -g seshi",
        "seshi --help",
        "```",
        "",
        "npm installs the binary for your platform through one of the optional `@seshi/cli-*` packages; Node only starts it. Other ways in: the install scripts and the binaries on GitHub releases.",
      ].join("\n"),
      version,
    ),
  );
  return { name: "seshi", dir };
}

async function run(argv: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}):\n${out}${err}`);
}

/** A library's dependencies for npm: workspace packages at the release's exact version (each
 * must itself be published), the rest as the workspace declares them. */
export function libraryDependencies(
  declared: Record<string, string> | undefined,
  version: string,
): Record<string, string> {
  const published = new Set<string>(LIBRARIES.map((l) => l.name));
  const deps: Record<string, string> = {};
  for (const [name, range] of Object.entries(declared ?? {})) {
    if (range.startsWith("workspace:")) {
      if (!published.has(name)) {
        throw new Error(`${name} is a workspace package that is not published to npm`);
      }
      deps[name] = version;
    } else {
      deps[name] = range;
    }
  }
  return deps;
}

/** Builds one library: an ESM bundle of its sources (dependencies left as imports) and its
 * declarations, which tsc writes from the sources. `@seshi/model`'s declarations come from the
 * built model package, so the client's refer to the published name. */
export async function writeLibraryPackage(
  out: string,
  library: (typeof LIBRARIES)[number],
  version: string,
  license: Uint8Array,
  root = ROOT,
): Promise<NpmPackage> {
  const src = join(root, library.dir);
  const workspace = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  const dir = join(out, library.out);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(src, "src/index.ts")],
    target: "node",
    format: "esm",
    packages: "external",
    conditions: ["bun"],
    outdir: join(dir, "dist"),
    naming: "index.js",
  });
  if (!built.success) {
    throw new Error(`bundling ${library.name} failed:\n${built.logs.map(String).join("\n")}`);
  }

  const temp = mkdtempSync(join(tmpdir(), "seshi-dts-"));
  try {
    const paths: Record<string, string[]> = {};
    if (library.name !== "@seshi/model") {
      paths["@seshi/model"] = [join(out, "model/types/index.d.ts")];
    }
    const tsconfig = join(temp, "tsconfig.json");
    writeJson(tsconfig, {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        // Node's built-in modules' types, through bun-types (the repository's only @types).
        types: ["bun"],
        typeRoots: [join(root, "node_modules/@types")],
        customConditions: ["bun"],
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: join(src, "src"),
        outDir: join(dir, "types"),
        paths,
      },
      files: [join(src, "src/index.ts")],
    });
    const tsc = join(root, "node_modules/typescript/bin/tsc");
    await run([process.execPath, tsc, "-p", tsconfig], root);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  addDeclarationExtensions(join(dir, "types"));

  writeJson(join(dir, "package.json"), {
    name: library.name,
    ...common(version),
    description: library.description,
    type: "module",
    main: "./dist/index.js",
    types: "./types/index.d.ts",
    exports: {
      ".": { types: "./types/index.d.ts", default: "./dist/index.js" },
      "./package.json": "./package.json",
    },
    files: ["dist/", "types/"],
    sideEffects: false,
    engines: { node: ">=20" },
    dependencies: libraryDependencies(workspace.dependencies, version),
  });
  writeFileSync(join(dir, "LICENSE"), license);
  writeFileSync(join(dir, "README.md"), readme(library.name, library.description, version));
  return { name: library.name, dir };
}

const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']*)\2/g;

/** Gives the declarations' relative imports the `.js` extension Node's ESM resolution needs.
 * tsc copies the sources' extensionless specifiers (`from "./api"`) into the `.d.ts` files, and
 * a TypeScript project resolving the package as Node does (`module: "NodeNext"`, the usual
 * setting for a Node ESM project) cannot follow them: the re-exported types silently become
 * `any`. Each specifier becomes `./api.js` or `./schemas/index.js`, whichever `.d.ts` exists. */
export function addDeclarationExtensions(types: string): void {
  for (const entry of readdirSync(types, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".d.ts")) continue;
    const file = join(types, entry);
    const text = readFileSync(file, "utf8");
    const fixed = text.replace(
      RELATIVE_SPECIFIER,
      (_all, lead: string, quote: string, spec: string) => {
        if (/\.(?:[cm]?js|json)$/.test(spec)) return `${lead}${quote}${spec}${quote}`;
        const from = dirname(file);
        let next: string;
        if (existsSync(join(from, `${spec}.d.ts`))) next = `${spec}.js`;
        else if (existsSync(join(from, spec, "index.d.ts"))) next = `${spec}/index.js`;
        else throw new Error(`${file}: ${spec} matches no declaration file`);
        return `${lead}${quote}${next}${quote}`;
      },
    );
    if (fixed !== text) writeFileSync(file, fixed);
  }
}

export interface BuildNpmOptions {
  version: string;
  /** The release assets: archives and `SHA256SUMS`. */
  from: string;
  out: string;
  root?: string;
  targets?: readonly Target[];
  /** Build `@seshi/model` and `@seshi/client` too (the default). */
  libraries?: boolean;
}

/** Every npm package of the release, in publish order: platform packages, libraries, then
 * the launcher (so it never names a platform package that is not yet on the registry). */
export async function buildNpm(options: BuildNpmOptions): Promise<NpmPackage[]> {
  if (!SEMVER.test(options.version)) {
    throw new Error(`not a version: ${JSON.stringify(options.version)}`);
  }
  const root = options.root ?? ROOT;
  const targets = options.targets ?? TARGETS;
  if (options.libraries !== false) {
    // The libraries are built from the sources, and @seshi/model's VERSION is read from its
    // package.json: building them at another version would publish a mismatch.
    const manifest = JSON.parse(readFileSync(join(root, "packages/ts/model/package.json"), "utf8"));
    if (manifest.version !== options.version) {
      throw new Error(
        `--version ${options.version} but packages/ts/model/package.json says ${manifest.version}; build from the release's tag`,
      );
    }
  }
  const license = readFileSync(join(root, "LICENSE"));
  const sums = parseChecksums(readFileSync(join(options.from, CHECKSUMS), "utf8"));
  mkdirSync(options.out, { recursive: true });

  const packages: NpmPackage[] = [];
  for (const target of targets) {
    const expected = sums.get(target.asset);
    if (!expected) throw new Error(`${CHECKSUMS} has no line for ${target.asset}`);
    const archive = readFileSync(join(options.from, target.asset));
    if (sha256(archive) !== expected) {
      throw new Error(`${target.asset} does not match its checksum in ${CHECKSUMS}`);
    }
    const binary = readArchive(target.asset, archive).find((e) => e.name === target.binary);
    if (!binary) throw new Error(`${target.asset} holds no ${target.binary}`);
    packages.push(writePlatformPackage(options.out, target, options.version, binary.data, license));
  }
  if (options.libraries !== false) {
    for (const library of LIBRARIES) {
      packages.push(
        await writeLibraryPackage(options.out, library, options.version, license, root),
      );
    }
  }
  packages.push(await writeLauncherPackage(options.out, options.version, license, targets));
  writeJson(
    join(options.out, "packages.json"),
    packages.map((p) => ({ name: p.name, dir: relative(options.out, p.dir) })),
  );
  return packages;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: "string" },
      from: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  try {
    const packages = await buildNpm({
      version: values.version ?? "",
      from: resolve(values.from ?? join(ROOT, "dist/release")),
      out: resolve(values.out ?? join(ROOT, "dist/npm")),
    });
    for (const p of packages) console.log(`npm: ${p.name}@${values.version}  ${p.dir}`);
  } catch (err) {
    console.error(`npm: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
