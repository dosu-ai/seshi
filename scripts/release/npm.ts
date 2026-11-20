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

/** The launcher's npm name: what `npm i -g` installs. Every published package is under the
 * `@dosu` scope; the workspace keeps its own `@seshi/*` names, which are never published. */
export const LAUNCHER = "@dosu/seshi";

/** The same launcher under the bare name, so `npm i -g seshi` works too. It runs the same
 * `@dosu/seshi-<os>-<cpu>` binaries. It is published last and may fail without failing the
 * release: CI's token may not reach a name outside `@dosu` (docs/releasing.md#names). */
export const BARE_LAUNCHER = "seshi";

export const LIBRARIES = [
  {
    workspace: "@seshi/model",
    name: "@dosu/seshi-model",
    dir: "packages/ts/model",
    out: "model",
    description:
      "seshi's shared types: the canonical trace, stored objects and the session API; canonical text and hashing.",
  },
  {
    workspace: "@seshi/client",
    name: "@dosu/seshi-client",
    dir: "packages/ts/client",
    out: "client",
    description: "The typed HTTP client for a seshi server. Runs on Node 20+ and Bun.",
  },
] as const;

/** Workspace name to published name, for each published library. */
export const PUBLISHED_NAMES: ReadonlyMap<string, string> = new Map(
  LIBRARIES.map((l) => [l.workspace, l.name]),
);

export interface NpmPackage {
  name: string;
  dir: string;
  /** A failed publish of it is reported, not fatal. */
  optional?: boolean;
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

export function platformManifest(target: Target, version: string): Record<string, unknown> {
  return {
    name: target.npm,
    ...common(version),
    description: `The seshi binary for ${OS_NAMES[target.os]} ${target.cpu}. Install ${LAUNCHER}, not this package.`,
    os: [target.nodePlatform],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ["bin/"],
    preferUnplugged: true,
  };
}

export function launcherManifest(
  version: string,
  targets: readonly Target[] = TARGETS,
  name: string = LAUNCHER,
): Record<string, unknown> {
  return {
    name,
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

export function badgeUrl(version: string): string {
  return `https://raw.githubusercontent.com/${REPOSITORY}/v${version}/brand/glyph/seshi-glyph-badge.svg`;
}

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
      `The \`seshi\` binary for ${OS_NAMES[target.os]} ${target.cpu}. It is installed by the \`${LAUNCHER}\` package (\`npm i -g ${LAUNCHER}\`); you do not need to install it yourself.`,
      version,
    ),
  );
  return { name: target.npm, dir };
}

export async function writeLauncherPackage(
  out: string,
  version: string,
  license: Uint8Array,
  targets: readonly Target[] = TARGETS,
  name: string = LAUNCHER,
): Promise<NpmPackage> {
  const dir = join(out, name === LAUNCHER ? "seshi" : `launcher-${name}`);
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
  writeJson(join(dir, "package.json"), launcherManifest(version, targets, name));
  writeFileSync(
    join(dir, "README.md"),
    readme(
      name,
      [
        "Capture, ingest, redact, store and search coding-agent sessions: one binary for the CLI, the agent hooks and the server.",
        "",
        "```sh",
        `npm i -g ${name}`,
        "seshi --help",
        "```",
        "",
        `npm installs the binary for your platform through one of the optional \`${LAUNCHER}-<os>-<cpu>\` packages; Node only starts it. Other ways in: the install scripts and the binaries on GitHub releases.`,
        ...(name === LAUNCHER
          ? []
          : ["", `\`${name}\` and \`${LAUNCHER}\` are the same launcher; install one of them.`]),
      ].join("\n"),
      version,
    ),
  );
  return { name, dir, ...(name === LAUNCHER ? {} : { optional: true }) };
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

export function libraryDependencies(
  declared: Record<string, string> | undefined,
  version: string,
): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const [name, range] of Object.entries(declared ?? {})) {
    if (range.startsWith("workspace:")) {
      const published = PUBLISHED_NAMES.get(name);
      if (!published) {
        throw new Error(`${name} is a workspace package that is not published to npm`);
      }
      deps[published] = version;
    } else {
      deps[name] = range;
    }
  }
  return deps;
}

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
    if (library.workspace !== "@seshi/model") {
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
  renameWorkspaceImports(dir);

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

const WORKSPACE_SPECIFIER = /(["'])(@seshi\/[a-z-]+)(\/[^"']*)?\1/g;

/** Points the built code's and declarations' imports of a workspace library (`@seshi/model`,
 * kept external by the bundle) at its published name (`@dosu/seshi-model`), which is what a
 * consumer's node_modules holds. An import of a workspace package that is not published is an
 * error, as it is in `libraryDependencies`. */
export function renameWorkspaceImports(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!/\.(?:js|d\.ts)$/.test(entry)) continue;
    const file = join(dir, entry);
    const text = readFileSync(file, "utf8");
    const fixed = text.replace(
      WORKSPACE_SPECIFIER,
      (_all, quote: string, name: string, rest: string | undefined) => {
        const published = PUBLISHED_NAMES.get(name);
        if (!published) throw new Error(`${file}: imports ${name}, which is not published to npm`);
        return `${quote}${published}${rest ?? ""}${quote}`;
      },
    );
    if (fixed !== text) writeFileSync(file, fixed);
  }
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
  from: string;
  out: string;
  root?: string;
  targets?: readonly Target[];
  libraries?: boolean;
}

export async function buildNpm(options: BuildNpmOptions): Promise<NpmPackage[]> {
  if (!SEMVER.test(options.version)) {
    throw new Error(`not a version: ${JSON.stringify(options.version)}`);
  }
  const root = options.root ?? ROOT;
  const targets = options.targets ?? TARGETS;
  if (options.libraries !== false) {
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
  packages.push(
    await writeLauncherPackage(options.out, options.version, license, targets, BARE_LAUNCHER),
  );
  writeJson(
    join(options.out, "packages.json"),
    packages.map((p) => ({
      name: p.name,
      dir: relative(options.out, p.dir),
      ...(p.optional ? { optional: true } : {}),
    })),
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
