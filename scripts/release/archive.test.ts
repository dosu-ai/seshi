import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checksumFile,
  parseChecksums,
  readArchive,
  readTarGz,
  readZip,
  sha256,
  tarGz,
  zip,
} from "./archive";

const enc = (s: string) => new TextEncoder().encode(s);

// Bytes that compress badly, larger than one tar block, with an odd length.
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 2463534242;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const ENTRIES = [
  { name: "seshi", data: noise(70_001), mode: 0o755 },
  { name: "LICENSE", data: enc("MIT License\n") },
  { name: "dir/empty.txt", data: new Uint8Array() },
];

async function sh(argv: string[], cwd: string) {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return { code, out: await new Response(proc.stdout).text() };
}

const has = (tool: string) => Bun.which(tool) !== null;

describe("tar.gz", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-archive-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads back what it wrote, with modes", () => {
    const back = readTarGz(tarGz(ENTRIES, Date.UTC(2026, 10, 1)));
    expect(back.map((e) => [e.name, sha256(e.data), e.mode])).toEqual(
      ENTRIES.map((e) => [e.name, sha256(e.data), e.mode ?? 0o644]),
    );
  });

  it("is deterministic for the same entries and time", () => {
    expect(sha256(tarGz(ENTRIES, 1000))).toBe(sha256(tarGz(ENTRIES, 1000)));
    expect(sha256(tarGz(ENTRIES, 1000))).not.toBe(sha256(tarGz(ENTRIES, 2000)));
  });

  it.skipIf(!has("tar"))("unpacks with the system tar, keeping the executable bit", async () => {
    writeFileSync(join(dir, "a.tar.gz"), tarGz(ENTRIES, Date.UTC(2026, 0, 1)));
    expect((await sh(["tar", "-xzf", "a.tar.gz"], dir)).code).toBe(0);
    expect(sha256(readFileSync(join(dir, "seshi")))).toBe(sha256(ENTRIES[0]?.data as Uint8Array));
    expect(statSync(join(dir, "seshi")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toBe("MIT License\n");
    expect(statSync(join(dir, "dir/empty.txt")).size).toBe(0);
  });

  it.skipIf(!has("tar"))("reads what the system tar wrote", async () => {
    writeFileSync(join(dir, "x.txt"), "hello\n");
    expect((await sh(["tar", "-czf", "x.tar.gz", "x.txt"], dir)).code).toBe(0);
    const back = readTarGz(readFileSync(join(dir, "x.tar.gz")));
    expect(back.find((e) => e.name === "x.txt")?.data).toEqual(enc("hello\n"));
  });

  it("refuses names it cannot store safely", () => {
    for (const name of ["", "/abs", "../up", "a/../b", "back\\slash", "x".repeat(100)]) {
      expect(() => tarGz([{ name, data: new Uint8Array() }])).toThrow(/not supported/);
    }
  });

  it("notices a damaged header", () => {
    const tar = gunzipSync(tarGz(ENTRIES));
    tar[0] = 0x41;
    expect(() => readTarGz(gzipSync(tar))).toThrow(/checksum/);
  });
});

describe("zip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-archive-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads back what it wrote, with modes", () => {
    const back = readZip(zip(ENTRIES, Date.UTC(2026, 10, 1)));
    expect(back.map((e) => [e.name, sha256(e.data), e.mode])).toEqual(
      ENTRIES.map((e) => [e.name, sha256(e.data), e.mode ?? 0o644]),
    );
  });

  it("is deterministic", () => {
    expect(sha256(zip(ENTRIES, 5000))).toBe(sha256(zip(ENTRIES, 5000)));
  });

  it.skipIf(!has("unzip"))("unpacks with unzip, which checks every CRC", async () => {
    writeFileSync(join(dir, "a.zip"), zip(ENTRIES, Date.UTC(2026, 0, 1)));
    const tested = await sh(["unzip", "-t", "a.zip"], dir);
    expect(tested.code).toBe(0);
    expect(tested.out).toContain("No errors detected");
    expect((await sh(["unzip", "-q", "a.zip"], dir)).code).toBe(0);
    expect(sha256(readFileSync(join(dir, "seshi")))).toBe(sha256(ENTRIES[0]?.data as Uint8Array));
  });

  it.skipIf(!has("zip"))("reads what the zip tool wrote", async () => {
    writeFileSync(join(dir, "x.txt"), "hello hello hello hello\n");
    expect((await sh(["zip", "-q", "x.zip", "x.txt"], dir)).code).toBe(0);
    const back = readZip(readFileSync(join(dir, "x.zip")));
    expect(back.find((e) => e.name === "x.txt")?.data).toEqual(enc("hello hello hello hello\n"));
  });

  it("notices corrupted data", () => {
    const archive = zip([{ name: "a", data: enc("a".repeat(1000)) }]);
    const broken = new Uint8Array(archive);
    // Flip a bit inside the deflated data (after the 30-byte header and the 1-byte name).
    broken[32] = (broken[32] as number) ^ 0x01;
    expect(() => readZip(broken)).toThrow();
    expect(() => readZip(enc("not a zip"))).toThrow(/not a zip/);
  });
});

describe("readArchive", () => {
  it("picks the reader by name", () => {
    expect(readArchive("x.tar.gz", tarGz(ENTRIES))).toHaveLength(3);
    expect(readArchive("x.zip", zip(ENTRIES))).toHaveLength(3);
    expect(() => readArchive("x.rar", new Uint8Array())).toThrow(/not a release archive/);
  });
});

describe("checksums", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-sums-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes sha256sum's format, sorted, and parses it back", () => {
    const files = new Map([
      ["b.zip", enc("b")],
      ["a.tar.gz", enc("a")],
    ]);
    const text = checksumFile(files);
    expect(text).toBe(`${sha256(enc("a"))}  a.tar.gz\n${sha256(enc("b"))}  b.zip\n`);
    expect(parseChecksums(text)).toEqual(
      new Map([
        ["a.tar.gz", sha256(enc("a"))],
        ["b.zip", sha256(enc("b"))],
      ]),
    );
    expect(parseChecksums(`${sha256(enc("a"))} *a.tar.gz\r\n`).get("a.tar.gz")).toBe(
      sha256(enc("a")),
    );
    expect(() => parseChecksums("nonsense\n")).toThrow(/not a checksum line/);
  });

  it.skipIf(!has("shasum") && !has("sha256sum"))("is checked by the system tool", async () => {
    writeFileSync(join(dir, "a.bin"), "abc");
    writeFileSync(join(dir, "SHA256SUMS"), checksumFile(new Map([["a.bin", enc("abc")]])));
    const argv = has("sha256sum")
      ? ["sha256sum", "-c", "SHA256SUMS"]
      : ["shasum", "-a", "256", "-c", "SHA256SUMS"];
    expect((await sh(argv, dir)).code).toBe(0);
  });
});
