import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { VERSION } from "@seshi/model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCommand,
  checkLanceNative,
  duckdbBindings,
  duckdbLibrary,
  duckdbNativePackage,
  duckdbPlatform,
  duckdbVersion,
  extensionPin,
  fetchExtension,
  lanceNativeLibrary,
  lanceNativePackage,
  readExtensionPins,
  stripElf,
} from "./build-binary";

const ROOT = resolve(import.meta.dirname, "..");

describe("buildCommand", () => {
  it("compiles main.ts to dist/seshi with bytecode and the bun condition", () => {
    const { argv, outfile } = buildCommand({ root: "/repo" });
    expect(outfile).toBe(
      process.platform === "win32" ? "/repo/dist/seshi.exe" : "/repo/dist/seshi",
    );
    expect(argv.slice(1)).toEqual([
      "build",
      "/repo/apps/seshi/src/main.ts",
      "--compile",
      "--minify",
      "--bytecode",
      "--conditions",
      "bun",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      outfile,
    ]);
  });

  it("takes a target and names a Windows binary .exe", () => {
    const { argv, outfile } = buildCommand({ root: "/repo", target: "bun-windows-x64" });
    expect(outfile).toBe("/repo/dist/seshi.exe");
    expect(argv).toContain("bun-windows-x64");
    expect(buildCommand({ root: "/repo", outfile: "out/x" }).outfile).toBe("/repo/out/x");
  });
});

describe("the server build (F10.6)", () => {
  it("starts from main-server.ts and leaves LanceDB's musl library out", () => {
    const { argv } = buildCommand({
      root: "/repo",
      target: "bun-linux-x64-baseline",
      server: true,
    });
    expect(argv[2]).toBe("/repo/apps/seshi/src/main-server.ts");
    expect(argv.join(" ")).toContain("--external @lancedb/lancedb-*-musl");
    expect(buildCommand({ root: "/repo" }).argv.join(" ")).not.toContain("lancedb");
  });

  it("names the target's LanceDB native package, and refuses one not installed", () => {
    expect(lanceNativePackage("bun-linux-x64-baseline")).toBe("@lancedb/lancedb-linux-x64-gnu");
    expect(lanceNativePackage("bun-linux-arm64")).toBe("@lancedb/lancedb-linux-arm64-gnu");
    expect(lanceNativePackage("bun-darwin-arm64")).toBe("@lancedb/lancedb-darwin-arm64");
    expect(lanceNativePackage(undefined, { platform: "linux", arch: "arm64" })).toBe(
      "@lancedb/lancedb-linux-arm64-gnu",
    );
    expect(() => lanceNativePackage("bun-windows-x64")).toThrow(/Linux and macOS/);
    // This machine's own package is what bun install put there.
    if (process.platform !== "win32") expect(() => checkLanceNative(ROOT, undefined)).not.toThrow();
    const other = process.arch === "arm64" ? "bun-darwin-x64" : "bun-darwin-arm64";
    if (process.platform === "linux") {
      expect(() => checkLanceNative(ROOT, other)).toThrow(/--os=darwin/);
    }
  });
});

describe("the -sql server build (docs/seshi/session-tools.md, T9)", () => {
  const bindings = [
    "@duckdb/node-bindings-darwin-arm64",
    "@duckdb/node-bindings-linux-x64",
    "@duckdb/node-bindings-linux-x64-musl",
    "@duckdb/node-bindings-win32-x64",
  ];

  it("starts from main-server-sql.ts and keeps only the target's DuckDB binding", () => {
    const { argv } = buildCommand({
      root: "/repo",
      target: "bun-linux-x64-baseline",
      sql: true,
      duckdbBindings: bindings,
    });
    expect(argv[2]).toBe("/repo/apps/seshi/src/main-server-sql.ts");
    const line = argv.join(" ");
    expect(line).toContain("--external @lancedb/lancedb-*-musl");
    expect(line).toContain("--external @duckdb/node-bindings-darwin-arm64");
    expect(line).toContain("--external @duckdb/node-bindings-linux-x64-musl");
    expect(line).toContain("--external @duckdb/node-bindings-win32-x64");
    expect(line).not.toContain("--external @duckdb/node-bindings-linux-x64 ");
    // The plain server build names no DuckDB at all.
    expect(buildCommand({ root: "/repo", server: true }).argv.join(" ")).not.toContain("duckdb");
  });

  it("names the target's binding package and DuckDB's platform", () => {
    expect(duckdbNativePackage("bun-linux-x64-baseline")).toBe("@duckdb/node-bindings-linux-x64");
    expect(duckdbNativePackage("bun-linux-arm64")).toBe("@duckdb/node-bindings-linux-arm64");
    expect(duckdbNativePackage(undefined, { platform: "darwin", arch: "arm64" })).toBe(
      "@duckdb/node-bindings-darwin-arm64",
    );
    expect(() => duckdbNativePackage("bun-windows-x64")).toThrow(/Linux and macOS/);
    expect(duckdbPlatform("bun-linux-x64-baseline")).toBe("linux_amd64");
    expect(duckdbPlatform("bun-linux-arm64")).toBe("linux_arm64");
    expect(duckdbPlatform(undefined, { platform: "darwin", arch: "arm64" })).toBe("osx_arm64");
  });

  it("reads the DuckDB version and bindings this workspace installs, and pins lance for it on Linux", () => {
    expect(duckdbVersion(ROOT)).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(duckdbBindings(ROOT)).toContain("@duckdb/node-bindings-linux-x64");
    const pins = readExtensionPins(ROOT);
    for (const platform of ["linux_amd64", "linux_arm64"]) {
      const pin = extensionPin(pins, duckdbVersion(ROOT), platform, "lance");
      expect(pin.url).toBe(
        `https://extensions.duckdb.org/${duckdbVersion(ROOT)}/${platform}/lance.duckdb_extension.gz`,
      );
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    if (process.platform !== "win32") {
      expect(duckdbLibrary(ROOT, undefined)).toMatch(/libduckdb\.(so|dylib)$/);
    }
  });

  it("refuses a DuckDB version or platform the pins do not name", () => {
    const pins = readExtensionPins(ROOT);
    expect(() => extensionPin(pins, "v0.0.1", "linux_amd64", "lance")).toThrow(
      /DuckDB v0.0.1, which scripts\/duckdb-extensions.json pins no extensions for/,
    );
    expect(() => extensionPin(pins, duckdbVersion(ROOT), "linux_riscv", "lance")).toThrow(
      /no lance for DuckDB .* on linux_riscv/,
    );
  });

  describe("fetchExtension", () => {
    let cache: string;
    beforeAll(() => {
      cache = mkdtempSync(join(tmpdir(), "seshi-duckdb-ext-"));
    });
    afterAll(() => rmSync(cache, { recursive: true, force: true }));
    const body = gzipSync(Buffer.from("a signed extension"));
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const url = "https://extensions.duckdb.org/v9.9.9/linux_amd64/lance.duckdb_extension.gz";

    it("checks the download against its pin, unpacks it, and keeps it in the cache", async () => {
      let fetched = 0;
      const fetch = async () => {
        fetched++;
        return body;
      };
      const pin = { url, sha256 };
      expect(new TextDecoder().decode(await fetchExtension(pin, { cache, fetch }))).toBe(
        "a signed extension",
      );
      expect(new TextDecoder().decode(await fetchExtension(pin, { cache, fetch }))).toBe(
        "a signed extension",
      );
      expect(fetched).toBe(1);
      expect(readdirSync(join(cache, "v9.9.9/linux_amd64"))).toEqual(["lance.duckdb_extension.gz"]);
    });

    it("refuses a download that does not match its pin, and a cached copy that does not either", async () => {
      const other = gzipSync(Buffer.from("another build"));
      await expect(
        fetchExtension({ url, sha256: "0".repeat(64) }, { fetch: async () => other }),
      ).rejects.toThrow(/has SHA-256 [0-9a-f]{64}, not the 0{64}/);
      // A cached copy that no longer matches is fetched again.
      writeFileSync(join(cache, "v9.9.9/linux_amd64/lance.duckdb_extension.gz"), other);
      let fetched = 0;
      await fetchExtension(
        { url, sha256 },
        {
          cache,
          fetch: async () => {
            fetched++;
            return body;
          },
        },
      );
      expect(fetched).toBe(1);
    });
  });
});

describe("checkLanceNative, on a node_modules laid out by hand", () => {
  const target = "bun-linux-x64-baseline";
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  /** A fresh root each time: Bun's resolver caches the folders it has listed. Returns it and
   * where the native package goes. */
  const layout = (manifest: string | undefined, library = false) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "seshi-lance-native-")));
    roots.push(root);
    const modules = join(root, "packages/ts/search/lance/node_modules/@lancedb");
    mkdirSync(join(modules, "lancedb"), { recursive: true });
    writeFileSync(join(modules, "lancedb/package.json"), '{"name":"@lancedb/lancedb"}');
    const native = join(modules, "lancedb-linux-x64-gnu");
    if (manifest !== undefined) {
      mkdirSync(native);
      writeFileSync(join(native, "package.json"), manifest);
      if (library) writeFileSync(join(native, "lancedb.node"), "");
    }
    return { root, native };
  };

  it("finds the library the package names", () => {
    const { root, native } = layout('{"main":"lancedb.node"}', true);
    expect(lanceNativeLibrary(root, target)).toBe(join(native, "lancedb.node"));
    expect(() => checkLanceNative(root, target)).not.toThrow();
  });

  it("says a package that is not there is not installed, and how to install it", () => {
    const { root } = layout(undefined);
    expect(() => checkLanceNative(root, target)).toThrow(
      /lancedb-linux-x64-gnu is not installed.*--os=linux --cpu=x64/,
    );
  });

  it("reports a broken package as it is, not as missing", () => {
    const broken = layout("{ not json").root;
    expect(() => checkLanceNative(broken, target)).toThrow(/package\.json does not parse: /);
    expect(() => checkLanceNative(broken, target)).not.toThrow(/not installed/);
    const noMain = layout('{"name":"@lancedb/lancedb-linux-x64-gnu"}').root;
    expect(() => checkLanceNative(noMain, target)).toThrow(/names no library \(no "main"\)/);
    const noFile = layout('{"main":"lancedb.node"}').root;
    expect(() => checkLanceNative(noFile, target)).toThrow(
      /lancedb\.node as its library, which is missing/,
    );
  });
});

/** A little-endian ELF64 shared object: one loaded segment holding `.text`, then the
 * unallocated `.comment`, `.symtab`, `.shstrtab` and `.strtab` and a `.debug_info`, as a
 * linker leaves them. */
function elf(): Uint8Array {
  const names = ["", ".text", ".comment", ".symtab", ".shstrtab", ".strtab", ".debug_info"];
  const shstr = new TextEncoder().encode(`${names.join("\0")}\0`);
  const nameAt = (i: number) => names.slice(0, i).reduce((n, s) => n + s.length + 1, 0);
  const body: [string, number, bigint, Uint8Array, number, number][] = [
    // name, type, flags, bytes, link, info
    [".text", 1, 6n, new Uint8Array(64).fill(0xaa), 0, 0],
    [".comment", 1, 0x30n, new TextEncoder().encode("rustc\0"), 0, 0],
    [".symtab", 2, 0n, new Uint8Array(48).fill(0x11), 5, 1],
    [".shstrtab", 3, 0n, shstr, 0, 0],
    [".strtab", 3, 0n, new TextEncoder().encode("\0main\0"), 0, 0],
    [".debug_info", 1, 0n, new Uint8Array(40).fill(0x22), 0, 0],
  ];
  const offsets: number[] = [];
  let at = 0x40 + 56;
  for (const [, , , bytes] of body) {
    at = Math.ceil(at / 8) * 8;
    offsets.push(at);
    at += bytes.length;
  }
  const shoff = Math.ceil(at / 8) * 8;
  const out = new Uint8Array(shoff + (body.length + 1) * 64);
  const v = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  v.setUint16(0x10, 3, true); // ET_DYN
  v.setBigUint64(0x20, 0x40n, true);
  v.setBigUint64(0x28, BigInt(shoff), true);
  v.setUint16(0x34, 0x40, true);
  v.setUint16(0x36, 56, true);
  v.setUint16(0x38, 1, true);
  v.setUint16(0x3a, 64, true);
  v.setUint16(0x3c, body.length + 1, true);
  v.setUint16(0x3e, 4, true);
  // PT_LOAD over the headers and .text.
  v.setUint32(0x40, 1, true);
  v.setBigUint64(0x40 + 32, BigInt((offsets[0] as number) + 64), true);
  body.forEach(([, type, flags, bytes, link, info], i) => {
    out.set(bytes, offsets[i]);
    const h = shoff + (i + 1) * 64;
    v.setUint32(h, nameAt(i + 1), true);
    v.setUint32(h + 4, type, true);
    v.setBigUint64(h + 8, flags, true);
    v.setBigUint64(h + 24, BigInt(offsets[i] as number), true);
    v.setBigUint64(h + 32, BigInt(bytes.length), true);
    v.setUint32(h + 40, link, true);
    v.setUint32(h + 44, info, true);
    v.setBigUint64(h + 48, 1n, true);
  });
  return out;
}

/** Each section's name and bytes, read back the way a loader or readelf would. */
function sectionsOf(file: Uint8Array) {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const shoff = Number(v.getBigUint64(0x28, true));
  const count = v.getUint16(0x3c, true);
  const header = (i: number) => {
    const h = shoff + i * 64;
    const offset = Number(v.getBigUint64(h + 24, true));
    return {
      name: v.getUint32(h, true),
      bytes: file.subarray(offset, offset + Number(v.getBigUint64(h + 32, true))),
    };
  };
  const names = header(v.getUint16(0x3e, true)).bytes;
  return Array.from({ length: count }, (_, i) => {
    const { name, bytes } = header(i);
    return { name: new TextDecoder().decode(names.subarray(name, names.indexOf(0, name))), bytes };
  });
}

describe("stripElf (the server build's LanceDB library)", () => {
  it("drops the symbol table, its strings and debug sections, and keeps the loaded bytes", () => {
    const input = elf();
    const output = stripElf(input) as Uint8Array;
    expect(output.length).toBeLessThan(input.length);
    expect(sectionsOf(output).map((s) => s.name)).toEqual(["", ".text", ".comment", ".shstrtab"]);
    const kept = Object.fromEntries(sectionsOf(input).map((s) => [s.name, s.bytes]));
    for (const s of sectionsOf(output)) expect(s.bytes).toEqual(kept[s.name]);
    // Everything up to the end of the loaded segment is the same, byte for byte.
    const loaded = 0x40 + 56 + 64;
    expect(output.subarray(0x40, loaded)).toEqual(input.subarray(0x40, loaded));
  });

  it("leaves a stripped library and anything that is not ELF64 alone", () => {
    expect(stripElf(stripElf(elf()) as Uint8Array)).toBeUndefined();
    expect(stripElf(new TextEncoder().encode("#!/bin/sh\n"))).toBeUndefined();
    const elf32 = elf();
    elf32[4] = 1;
    expect(stripElf(elf32)).toBeUndefined();
  });
});

describe("the compiled binary (X2.2)", () => {
  let dir: string;
  let binary: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-binary-"));
    const built = buildCommand({ root: ROOT, outfile: join(dir, "seshi") });
    binary = built.outfile;
    const proc = Bun.spawn(built.argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function run(args: string[], stdin?: string, env: Record<string, string> = {}) {
    const proc = Bun.spawn([binary, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return {
      code,
      out: await new Response(proc.stdout).text(),
      err: await new Response(proc.stderr).text(),
    };
  }

  it("runs without Bun's sources: version, a hook, a lazy command reading stdin", async () => {
    expect((await run(["--version"])).out.trim()).toBe(`seshi ${VERSION}`);
    // A hook loads its agent's capture module lazily and spools the session.
    const payload = JSON.stringify({
      session_id: "s",
      transcript_path: join(dir, "s.jsonl"),
      cwd: dir,
    });
    const hook = await run(["hook", "claude-code", "Stop"], payload, { SESHI_NO_UPLOADER: "1" });
    expect(hook).toMatchObject({ code: 0, out: "", err: "" });
    expect(readdirSync(join(dir, ".local", "state", "seshi", "spool"))).toHaveLength(1);
    const lines = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-09-01T00:00:00.000Z",
        sessionId: "s",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-09-01T00:00:01.000Z",
        sessionId: "s",
        message: { role: "assistant", model: "m", content: [{ type: "text", text: "hi" }] },
      },
    ].map((l) => JSON.stringify(l));
    const normalized = await run(
      ["normalize", "--agent", "claude-code", "-"],
      `${lines.join("\n")}\n`,
    );
    expect(normalized.code).toBe(0);
    expect(JSON.parse(normalized.out.split("\n")[0] as string)).toMatchObject({ role: "meta" });
  });

  it("runs operator patterns under RE2 and the built-in pack inside the binary (F2.2)", async () => {
    await Bun.write(
      join(dir, "acme.toml"),
      'id = "acme"\n[[rules]]\nid = "acme-key"\npattern = \'ACME-(?P<secret>[0-9]{4})\'\ntests.match = ["ACME-1234"]\n',
    );
    const tested = await run(
      ["redact", "test", "-", "--pack", "acme.toml", "--text", "--print", "--json"],
      "key ACME-1234 and ghp_abcdefghijklmnopqrstuvwx0123456789\n",
    );
    expect(tested.code).toBe(0);
    const doc = JSON.parse(tested.out);
    expect(doc.output).toEqual(["key ACME-[redacted:acme-key] and [redacted:github-token]"]);
    expect(doc.tests.failed).toEqual([]);
    await Bun.write(
      join(dir, "bad.toml"),
      'id = "bad"\n[[rules]]\nid = "x"\npattern = "(a)\\\\1"\n',
    );
    const refused = await run(["redact", "test", "--pack", "bad.toml"]);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("RE2 has no backreferences");
  });

  it("reads neither the working folder's .env nor its bunfig.toml", async () => {
    // A repository an agent works in: its .env names a store, its bunfig preloads a script.
    await Bun.write(join(dir, ".env"), "SESHI_STORE__URL=file:///from-dotenv\n");
    await Bun.write(join(dir, "preload.ts"), 'console.log("PRELOADED");\n');
    await Bun.write(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    const shown = await run(["config", "show", "--json"]);
    expect(shown.out + shown.err).not.toContain("from-dotenv");
    expect(shown.out + shown.err).not.toContain("PRELOADED");
    const version = await run(["--version"]);
    expect(version.out.trim()).toBe(`seshi ${VERSION}`);
  });
});
