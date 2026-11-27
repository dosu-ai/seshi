import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

export interface BuildOptions {
  root: string;
  target?: string;
  outfile?: string;
  /** The server build: `main-server.ts`, which carries the LanceDB search backend (F10.6). */
  server?: boolean;
  /** The `-sql` server build: `main-server-sql.ts`, the server build with DuckDB for `sql` on a
   * LanceDB index (docs/seshi/session-tools.md, T9). Implies `server`. Its binary needs the
   * files `duckdbFiles` gives beside it. */
  sql?: boolean;
  /** With `sql`: every `@duckdb/node-bindings-*` package, of which the build keeps the
   * target's only (`duckdbBindings`). */
  duckdbBindings?: readonly string[];
}

function entryOf(options: BuildOptions): string {
  if (options.sql) return "main-server-sql.ts";
  return options.server ? "main-server.ts" : "main.ts";
}

export function buildCommand(options: BuildOptions): { argv: string[]; outfile: string } {
  const windows = options.target?.includes("windows") ?? process.platform === "win32";
  const outfile = resolve(
    options.root,
    options.outfile ?? join("dist", windows ? "seshi.exe" : "seshi"),
  );
  const argv = [
    process.execPath,
    "build",
    join(options.root, "apps/seshi/src", entryOf(options)),
    "--compile",
    "--minify",
    // Precompiled bytecode roughly halves start-up, which `seshi hook` pays on every agent
    // turn. It needs an entry without top-level await (main.ts has none).
    "--bytecode",
    "--conditions",
    "bun",
    // `seshi hook` runs in whatever folder the agent works in. A compiled Bun binary would
    // otherwise read that folder's .env (settings the user never meant for seshi) and
    // bunfig.toml (whose `preload` runs code from the repository). Settings come from
    // SESHI_* env and the TOML files only.
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...(options.target ? ["--target", options.target] : []),
    // The server build ships for glibc (the image is Debian, the release's Linux targets are
    // glibc). LanceDB picks its native library by libc at run time, which the bundler cannot
    // decide, so it would carry the musl one too (172 MB more): leave it out.
    ...(options.server || options.sql ? ["--external", "@lancedb/lancedb-*-musl"] : []),
    // DuckDB's loader requires every platform's binding by name, so each one the target does
    // not use is left out (the bundler would fail on the ones not installed, and carry the
    // others).
    ...(options.sql
      ? (options.duckdbBindings ?? [])
          .filter((name) => name !== duckdbNativePackage(options.target))
          .flatMap((name) => ["--external", name])
      : []),
    "--outfile",
    outfile,
  ];
  return { argv, outfile };
}

/** The LanceDB native package a server build for `target` (a Bun target; this machine's when
 * omitted) carries: `@lancedb/lancedb-linux-x64-gnu`, `@lancedb/lancedb-darwin-arm64`. */
export function lanceNativePackage(
  target: string | undefined,
  host: { platform: string; arch: string } = process,
): string {
  const match = target?.match(/^bun-(linux|darwin|windows)-(x64|arm64)/);
  const os = match ? match[1] : host.platform === "win32" ? "windows" : host.platform;
  const cpu = match ? match[2] : host.arch;
  if (os === "linux") return `@lancedb/lancedb-linux-${cpu}-gnu`;
  if (os === "darwin") return `@lancedb/lancedb-darwin-${cpu}`;
  throw new Error(`the server build is for Linux and macOS, not ${target ?? os}`);
}

/** A server build bundles the LanceDB native package that `bun install` put in node_modules;
 * one for another platform is not there unless the install asked for it, and the binary would
 * fail at its first search. Refuse to build instead. */
export function checkLanceNative(root: string, target: string | undefined): void {
  const file = lanceNativeLibrary(root, target);
  if (!existsSync(file)) {
    throw new Error(`${lanceNativePackage(target)} names ${file} as its library, which is missing`);
  }
}

/** The `.node` file of the target's LanceDB native package in node_modules. A package that
 * cannot be found is reported as not installed, with the install that brings it; anything
 * else (a package.json that does not parse, or names no library) is reported as it is. */
export function lanceNativeLibrary(root: string, target: string | undefined): string {
  const name = lanceNativePackage(target);
  let pkg: string;
  try {
    const lancedb = dirname(
      Bun.resolveSync("@lancedb/lancedb/package.json", join(root, "packages/ts/search/lance")),
    );
    pkg = dirname(Bun.resolveSync(`${name}/package.json`, lancedb));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND") throw error;
    const [, os, cpu] = name.match(/lancedb-(linux|darwin)-(x64|arm64)/) ?? [];
    throw new Error(
      `${name} is not installed, so a server build for ${target ?? "this machine"} would have no LanceDB: run bun install --frozen-lockfile --os=${os} --cpu=${cpu} first`,
    );
  }
  const manifest = join(pkg, "package.json");
  let main: unknown;
  try {
    ({ main } = JSON.parse(readFileSync(manifest, "utf8")) as { main?: unknown });
  } catch (error) {
    throw new Error(`${manifest} does not parse: ${(error as Error).message}`);
  }
  if (typeof main !== "string" || main === "") {
    throw new Error(`${manifest} names no library (no "main")`);
  }
  return join(pkg, main);
}

/** The DuckDB binding package a `-sql` build for `target` carries:
 * `@duckdb/node-bindings-linux-x64`, `@duckdb/node-bindings-darwin-arm64`. */
export function duckdbNativePackage(
  target: string | undefined,
  host: { platform: string; arch: string } = process,
): string {
  const { os, cpu } = targetOf(target, host);
  if (os === "linux" || os === "darwin") return `@duckdb/node-bindings-${os}-${cpu}`;
  throw new Error(`the -sql build is for Linux and macOS, not ${target ?? os}`);
}

function targetOf(target: string | undefined, host: { platform: string; arch: string }) {
  const match = target?.match(/^bun-(linux|darwin|windows)-(x64|arm64)/);
  return {
    os: match ? (match[1] as string) : host.platform === "win32" ? "windows" : host.platform,
    cpu: match ? (match[2] as string) : host.arch,
  };
}

/** DuckDB's name for `target`'s platform, the folder its extensions live in: `linux_amd64`,
 * `linux_arm64`, `osx_arm64`. */
export function duckdbPlatform(
  target: string | undefined,
  host: { platform: string; arch: string } = process,
): string {
  const { os, cpu } = targetOf(target, host);
  const arch = cpu === "x64" ? "amd64" : cpu;
  if (os === "linux") return `linux_${arch}`;
  if (os === "darwin") return `osx_${arch}`;
  throw new Error(`the -sql build is for Linux and macOS, not ${target ?? os}`);
}

function packageDir(name: string, from: string): string {
  return dirname(Bun.resolveSync(`${name}/package.json`, from));
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** `@duckdb/node-bindings`, where `@seshi/sql` finds it. */
function bindingsDir(root: string): string {
  const api = packageDir("@duckdb/node-api", join(root, "packages/ts/search/sql"));
  return packageDir("@duckdb/node-bindings", api);
}

/** Every platform's binding package `@duckdb/node-bindings` names, installed or not. */
export function duckdbBindings(root: string): string[] {
  const manifest = readJson<{ optionalDependencies?: Record<string, string> }>(
    join(bindingsDir(root), "package.json"),
  );
  return Object.keys(manifest.optionalDependencies ?? {});
}

/** The DuckDB version `@duckdb/node-api` wraps, as its extensions' folders name it: npm's
 * `2.0.1-r.1` is DuckDB `v2.0.1`. */
export function duckdbVersion(root: string): string {
  const { version } = readJson<{ version: string }>(
    join(packageDir("@duckdb/node-api", join(root, "packages/ts/search/sql")), "package.json"),
  );
  const match = version.match(/^(\d+\.\d+\.\d+)(?:-r\.\d+)?$/);
  if (!match) throw new Error(`@duckdb/node-api ${version} names no DuckDB version`);
  return `v${match[1]}`;
}

/** DuckDB's own library in `target`'s binding package, which `duckdb.node` links from its own
 * folder: a compiled binary carries `duckdb.node` but not the library, so the `-sql` archive
 * and image put it in `duckdb/lib/` beside the binary, where `@seshi/sql` loads it first. */
export function duckdbLibrary(root: string, target: string | undefined): string {
  const name = duckdbNativePackage(target);
  let dir: string;
  try {
    dir = packageDir(name, bindingsDir(root));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND") throw error;
    const [, os, cpu] = name.match(/bindings-(linux|darwin)-(x64|arm64)/) ?? [];
    throw new Error(
      `${name} is not installed, so a -sql build for ${target ?? "this machine"} would have no DuckDB: run bun install --frozen-lockfile --os=${os} --cpu=${cpu} first`,
    );
  }
  const file = join(dir, name.includes("darwin") ? "libduckdb.dylib" : "libduckdb.so");
  if (!existsSync(join(dir, "duckdb.node")) || !existsSync(file)) {
    throw new Error(`${name} has no duckdb.node and ${basename(file)} in ${dir}`);
  }
  return file;
}

/** `scripts/duckdb-extensions.json`: per DuckDB version, extension and platform, the URL of a
 * gzipped extension on extensions.duckdb.org and its SHA-256. */
export type ExtensionPins = Record<
  string,
  Record<string, Record<string, { url: string; sha256: string }>> | string
>;

export const DUCKDB_EXTENSIONS = ["lance"] as const;

export function readExtensionPins(root: string): ExtensionPins {
  return readJson<ExtensionPins>(join(root, "scripts/duckdb-extensions.json"));
}

/** Where `name`'s pin for this DuckDB version and platform is, or why there is none. */
export function extensionPin(
  pins: ExtensionPins,
  version: string,
  platform: string,
  name: string,
): { url: string; sha256: string } {
  const forVersion = pins[version];
  if (forVersion === undefined || typeof forVersion === "string") {
    throw new Error(
      `@duckdb/node-api is DuckDB ${version}, which scripts/duckdb-extensions.json pins no extensions for: an extension loads in the DuckDB version it was built for only, so add ${version}'s`,
    );
  }
  const pin = forVersion[name]?.[platform];
  if (pin === undefined) {
    throw new Error(
      `scripts/duckdb-extensions.json pins no ${name} for DuckDB ${version} on ${platform}`,
    );
  }
  return pin;
}

const sha256Of = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface FetchExtensionOptions {
  /** A folder that keeps downloads between builds, by version and platform. */
  cache?: string;
  fetch?: (url: string) => Promise<Uint8Array>;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** An extension as its pin names it, checked against the pinned SHA-256 and unpacked: from
 * `cache` when a copy there still matches, else downloaded (and kept there). A mismatch is
 * refused: DuckDB republishes an extension under the same URL, and a new one has to be pinned
 * on purpose. */
export async function fetchExtension(
  pin: { url: string; sha256: string },
  options: FetchExtensionOptions = {},
): Promise<Uint8Array> {
  const cached =
    options.cache === undefined
      ? undefined
      : join(options.cache, new URL(pin.url).pathname.replace(/^\/+/, ""));
  if (cached !== undefined && existsSync(cached)) {
    const data = readFileSync(cached);
    if (sha256Of(data) === pin.sha256) return gunzipSync(data);
  }
  const data = await (options.fetch ?? download)(pin.url);
  const got = sha256Of(data);
  if (got !== pin.sha256) {
    throw new Error(
      `${pin.url} has SHA-256 ${got}, not the ${pin.sha256} scripts/duckdb-extensions.json pins: DuckDB published another build; check it and pin it`,
    );
  }
  if (cached !== undefined) {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, data);
  }
  return gunzipSync(data);
}

export interface DuckdbFile {
  /** The path beside the binary: `duckdb/lib/libduckdb.so`,
   * `duckdb/v2.0.1/linux_amd64/lance.duckdb_extension`. */
  name: string;
  data: Uint8Array;
}

/** What a `-sql` binary for `target` needs beside it: DuckDB's library (stripped, like
 * LanceDB's), and each extension `DUCKDB_EXTENSIONS` names for this DuckDB version, checked
 * against its pin. Extensions are signed, so they ship as published. */
export async function duckdbFiles(
  root: string,
  target: string | undefined,
  options: FetchExtensionOptions = {},
): Promise<DuckdbFile[]> {
  const library = duckdbLibrary(root, target);
  const raw = readFileSync(library);
  const files: DuckdbFile[] = [
    { name: `duckdb/lib/${basename(library)}`, data: stripElf(raw) ?? raw },
  ];
  const version = duckdbVersion(root);
  const platform = duckdbPlatform(target);
  const pins = readExtensionPins(root);
  for (const name of DUCKDB_EXTENSIONS) {
    const data = await fetchExtension(extensionPin(pins, version, platform, name), options);
    files.push({ name: `duckdb/${version}/${platform}/${name}.duckdb_extension`, data });
  }
  return files;
}

/** Where the build keeps downloaded extensions between runs. */
export function extensionCache(root: string): string {
  return join(root, "node_modules/.cache/seshi-duckdb-extensions");
}

const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;
const SHF_ALLOC = 2n;

/** An ELF shared object without its symbol table (`.symtab` and its string table) and debug
 * sections: what `strip --strip-all` takes out of a library loaded by `dlopen`, which needs
 * only `.dynsym`. The loaded segments are copied byte for byte; only the sections after them,
 * which no segment maps, are rewritten. LanceDB ships its Linux libraries unstripped, and on
 * arm64 the symbol table is 145 of 426 MB. Returns undefined when there is nothing to drop
 * (already stripped) or the file is not a little-endian ELF64. */
export function stripElf(input: Uint8Array): Uint8Array | undefined {
  const isElf64Le =
    input[0] === 0x7f && input[1] === 0x45 && input[2] === 0x4c && input[3] === 0x46;
  if (!isElf64Le || input[4] !== 2 || input[5] !== 1) return undefined;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const phoff = Number(view.getBigUint64(0x20, true));
  const shoff = Number(view.getBigUint64(0x28, true));
  const phentsize = view.getUint16(0x36, true);
  const phnum = view.getUint16(0x38, true);
  const shentsize = view.getUint16(0x3a, true);
  const shnum = view.getUint16(0x3c, true);
  const shstrndx = view.getUint16(0x3e, true);
  if (shnum === 0 || shstrndx >= shnum) return undefined;

  const sections = Array.from({ length: shnum }, (_, i) => {
    const at = shoff + i * shentsize;
    return {
      header: input.subarray(at, at + shentsize),
      name: view.getUint32(at, true),
      type: view.getUint32(at + 4, true),
      alloc: (view.getBigUint64(at + 8, true) & SHF_ALLOC) !== 0n,
      offset: Number(view.getBigUint64(at + 24, true)),
      size: Number(view.getBigUint64(at + 32, true)),
      link: view.getUint32(at + 40, true),
      align: Math.max(1, Number(view.getBigUint64(at + 48, true))),
    };
  });
  const names = sections[shstrndx] as (typeof sections)[number];
  const nameOf = (s: (typeof sections)[number]) => {
    const start = names.offset + s.name;
    return new TextDecoder().decode(input.subarray(start, input.indexOf(0, start)));
  };
  const drop = new Set<number>();
  sections.forEach((s, i) => {
    if (s.type === SHT_SYMTAB) drop.add(i).add(s.link);
    if (!s.alloc && nameOf(s).startsWith(".debug")) drop.add(i);
  });
  drop.delete(0);
  drop.delete(shstrndx);
  if ([...drop].some((i) => sections[i]?.alloc)) return undefined;
  if (drop.size === 0) return undefined;

  // Everything a segment maps or an allocated section holds stays where it is; the
  // unallocated sections that remain (.comment, .shstrtab) follow it, then the section headers.
  let end = 0;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    end = Math.max(end, Number(view.getBigUint64(at + 8, true) + view.getBigUint64(at + 32, true)));
  }
  for (const s of sections)
    if (s.alloc && s.type !== SHT_NOBITS) end = Math.max(end, s.offset + s.size);
  end = Math.max(end, phoff + phnum * phentsize);
  const keep = sections.map((_, i) => i).filter((i) => !drop.has(i));
  const index = new Map(keep.map((old, i) => [old, i]));
  const tail = keep
    .map((i) => sections[i] as (typeof sections)[number])
    .filter((s) => !s.alloc && s.type !== SHT_NOBITS && s.size > 0);
  let size = end;
  const placed = new Map<(typeof sections)[number], number>();
  for (const s of tail) {
    size = Math.ceil(size / s.align) * s.align;
    placed.set(s, size);
    size += s.size;
  }
  const newShoff = Math.ceil(size / 8) * 8;
  const output = new Uint8Array(newShoff + keep.length * shentsize);
  const out = new DataView(output.buffer);
  output.set(input.subarray(0, end));
  for (const [s, at] of placed) output.set(input.subarray(s.offset, s.offset + s.size), at);
  keep.forEach((old, i) => {
    const s = sections[old] as (typeof sections)[number];
    const at = newShoff + i * shentsize;
    output.set(s.header, at);
    const offset = placed.get(s);
    if (offset !== undefined) out.setBigUint64(at + 24, BigInt(offset), true);
    out.setUint32(at + 40, index.get(s.link) ?? 0, true);
    // sh_info names a section for relocation sections (SHF_INFO_LINK) only.
    if ((out.getBigUint64(at + 8, true) & 0x40n) !== 0n) {
      out.setUint32(at + 44, index.get(out.getUint32(at + 44, true)) ?? 0, true);
    }
  });
  out.setBigUint64(0x28, BigInt(newShoff), true);
  out.setUint16(0x3c, keep.length, true);
  out.setUint16(0x3e, index.get(shstrndx) as number, true);
  return output;
}

/** Strips the target's LanceDB library where `bun install` put it, so the server build embeds
 * the stripped one (the bundler reads the package's `main`, and has no hook for swapping a
 * file in). The file is replaced by a rename, which leaves Bun's install cache, which
 * node_modules may hard-link, untouched; a stripped library runs the same, so later runs and
 * tests do not notice, and a second build finds nothing to strip. The cost: LanceDB's frames
 * in a backtrace have no names; npm's unstripped file at the pinned version symbolizes them
 * (docs/seshi/lancedb-search.md). ELF only: macOS server builds are for development and keep
 * their library as it is. */
export function stripLanceNative(root: string, target: string | undefined): void {
  const file = lanceNativeLibrary(root, target);
  const before = readFileSync(file);
  const stripped = stripElf(before);
  if (!stripped) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, stripped, { mode: statSync(file).mode });
  renameSync(tmp, file);
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  console.log(`build: stripped ${basename(file)}: ${mb(before.length)} -> ${mb(stripped.length)}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      target: { type: "string" },
      outfile: { type: "string" },
      server: { type: "boolean" },
      sql: { type: "boolean" },
    },
    strict: true,
  });
  const root = resolve(import.meta.dir, "..");
  const server = values.server === true || values.sql === true;
  if (server) {
    checkLanceNative(root, values.target);
    stripLanceNative(root, values.target);
  }
  // Fetched and checked before compiling, so a missing pin fails fast.
  const beside = values.sql
    ? await duckdbFiles(root, values.target, { cache: extensionCache(root) })
    : [];
  const { argv, outfile } = buildCommand({
    root,
    ...(values.target ? { target: values.target } : {}),
    ...(values.outfile ? { outfile: values.outfile } : {}),
    ...(server ? { server: true } : {}),
    ...(values.sql ? { sql: true, duckdbBindings: duckdbBindings(root) } : {}),
  });
  mkdirSync(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
  for (const file of beside) {
    const to = join(dirname(outfile), file.name);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, file.data);
    console.log(`build: ${to}`);
  }
  console.log(`build: ${outfile}`);
}
