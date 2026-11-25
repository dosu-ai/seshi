import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface BuildOptions {
  root: string;
  target?: string;
  outfile?: string;
  /** The server build: `main-server.ts`, which carries the LanceDB search backend (F10.6). */
  server?: boolean;
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
    join(options.root, "apps/seshi/src", options.server ? "main-server.ts" : "main.ts"),
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
    ...(options.server ? ["--external", "@lancedb/lancedb-*-musl"] : []),
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
    },
    strict: true,
  });
  const root = resolve(import.meta.dir, "..");
  if (values.server) {
    checkLanceNative(root, values.target);
    stripLanceNative(root, values.target);
  }
  const { argv, outfile } = buildCommand({
    root,
    ...(values.target ? { target: values.target } : {}),
    ...(values.outfile ? { outfile: values.outfile } : {}),
    ...(values.server ? { server: true } : {}),
  });
  mkdirSync(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
  console.log(`build: ${outfile}`);
}
