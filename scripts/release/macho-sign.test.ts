import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finishBinary } from "./build";
import { adhocSign } from "./macho-sign";
import { targetById } from "./targets";

/** A minimal thin x86_64 executable: a header, __TEXT and __LINKEDIT segments and an
 * LC_CODE_SIGNATURE whose space holds a stale signature, as Bun's darwin-x64 output does.
 * `trailing` bytes after the signature put it short of the file's end. */
function machO(options: { codeLimit?: number; sigSize?: number; trailing?: number } = {}): {
  data: Uint8Array;
  codeLimit: number;
  sigSize: number;
} {
  const codeLimit = options.codeLimit ?? 3 * 4096 + 100;
  const sigSize = options.sigSize ?? 4096;
  const data = new Uint8Array(codeLimit + sigSize + (options.trailing ?? 0));
  for (let i = 0; i < codeLimit; i++) data[i] = (i * 7 + 3) & 0xff;
  data.fill(0xee, codeLimit);
  const view = new DataView(data.buffer);
  const segment = 72;
  const sizeofcmds = segment * 2 + 16;
  data.fill(0, 0, 32 + sizeofcmds);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x01000007, true); // CPU_TYPE_X86_64
  view.setUint32(12, 0x2, true); // MH_EXECUTE
  view.setUint32(16, 3, true);
  view.setUint32(20, sizeofcmds, true);
  let at = 32;
  const seg = (name: string, vmaddr: number, fileoff: number, filesize: number) => {
    view.setUint32(at, 0x19, true);
    view.setUint32(at + 4, segment, true);
    data.set(new TextEncoder().encode(name), at + 8);
    view.setBigUint64(at + 24, BigInt(vmaddr), true);
    view.setBigUint64(at + 32, BigInt(Math.ceil(filesize / 0x4000) * 0x4000), true);
    view.setBigUint64(at + 40, BigInt(fileoff), true);
    view.setBigUint64(at + 48, BigInt(filesize), true);
    at += segment;
  };
  seg("__TEXT", 0x100000000, 0, 2 * 4096);
  seg("__LINKEDIT", 0x100004000, 2 * 4096, data.byteLength - 2 * 4096);
  view.setUint32(at, 0x1d, true);
  view.setUint32(at + 4, 16, true);
  view.setUint32(at + 8, codeLimit, true);
  view.setUint32(at + 12, sigSize, true);
  return { data, codeLimit, sigSize };
}

/** Checks every code-slot hash of a signed file against its page; returns the slot count. */
function checkHashes(signed: Uint8Array, codeLimit: number): number {
  const view = new DataView(signed.buffer, signed.byteOffset);
  const cd = codeLimit + 20;
  const hashOffset = view.getUint32(cd + 16);
  const slots = view.getUint32(cd + 28);
  for (let i = 0; i < slots; i++) {
    const page = signed.subarray(i * 4096, Math.min((i + 1) * 4096, codeLimit));
    const want = createHash("sha256").update(page).digest();
    const got = signed.subarray(cd + hashOffset + i * 32, cd + hashOffset + (i + 1) * 32);
    expect(Buffer.from(got).equals(want)).toBe(true);
  }
  return slots;
}

describe("adhocSign", () => {
  it("writes a linker-style ad-hoc CodeDirectory over the code, in the reserved space", () => {
    const { data, codeLimit, sigSize } = machO();
    const signed = adhocSign(data, "seshi");
    expect(signed.byteLength).toBe(data.byteLength);
    // Everything before the signature is untouched.
    expect(signed.subarray(0, codeLimit)).toEqual(data.subarray(0, codeLimit));
    const sig = new DataView(signed.buffer, signed.byteOffset + codeLimit, sigSize);
    expect(sig.getUint32(0)).toBe(0xfade0cc0);
    const length = sig.getUint32(4);
    expect(sig.getUint32(8)).toBe(1);
    expect([sig.getUint32(12), sig.getUint32(16)]).toEqual([0, 20]);
    // The rest of the old signature's space is zeroed, not left as stale bytes.
    expect(signed.subarray(codeLimit + length).every((b) => b === 0)).toBe(true);

    const cd = 20;
    expect(sig.getUint32(cd)).toBe(0xfade0c02);
    expect(sig.getUint32(cd + 8)).toBe(0x20400);
    expect(sig.getUint32(cd + 12)).toBe(0x20002); // adhoc | linker-signed
    const hashOffset = sig.getUint32(cd + 16);
    const identOffset = sig.getUint32(cd + 20);
    expect(sig.getUint32(cd + 24)).toBe(0);
    const slots = sig.getUint32(cd + 28);
    expect(slots).toBe(4);
    expect(sig.getUint32(cd + 32)).toBe(codeLimit);
    expect([sig.getUint8(cd + 36), sig.getUint8(cd + 37), sig.getUint8(cd + 39)]).toEqual([
      32, 2, 12,
    ]);
    expect(sig.getBigUint64(cd + 64)).toBe(0n);
    expect(sig.getBigUint64(cd + 72)).toBe(BigInt(2 * 4096));
    expect(sig.getBigUint64(cd + 80)).toBe(1n);
    const at = codeLimit + cd;
    expect(new TextDecoder().decode(signed.subarray(at + identOffset, at + identOffset + 6))).toBe(
      "seshi\0",
    );
    expect(sig.getUint32(cd + 4)).toBe(hashOffset + slots * 32);
    expect(checkHashes(signed, codeLimit)).toBe(slots);
  });

  it("grows the file, __LINKEDIT and LC_CODE_SIGNATURE when the stale signature is too small", () => {
    // Bun's x64 runtime reserves room for a signature over the runtime alone; the bundle
    // makes the code longer than that.
    const { data, codeLimit } = machO({ codeLimit: 40 * 4096 + 5, sigSize: 64 });
    const signed = adhocSign(data, "seshi");
    const view = new DataView(signed.buffer, signed.byteOffset);
    const length = view.getUint32(codeLimit + 4);
    const size = Math.ceil(length / 16) * 16;
    expect(signed.byteLength).toBe(codeLimit + size);
    // LC_CODE_SIGNATURE's datasize, then __LINKEDIT's filesize and vmsize.
    const linkedit = 32 + 72;
    const sigCmd = 32 + 72 * 2;
    expect(view.getUint32(sigCmd + 8, true)).toBe(codeLimit);
    expect(view.getUint32(sigCmd + 12, true)).toBe(size);
    expect(Number(view.getBigUint64(linkedit + 48, true))).toBe(signed.byteLength - 2 * 4096);
    const vmsize = Number(view.getBigUint64(linkedit + 32, true));
    expect(vmsize % 0x4000).toBe(0);
    expect(vmsize).toBeGreaterThanOrEqual(signed.byteLength - 2 * 4096);
    // Past the header, the code is unchanged; the hashes cover the updated header.
    expect(signed.subarray(4096, codeLimit)).toEqual(data.subarray(4096, codeLimit));
    expect(checkHashes(signed, codeLimit)).toBe(41);
  });

  it("refuses what it cannot sign", () => {
    expect(() => adhocSign(new Uint8Array(64), "seshi")).toThrow(/Mach-O/);
    // Too small, and something follows the signature: growing would move it.
    expect(() => adhocSign(machO({ sigSize: 64, trailing: 16 }).data, "seshi")).toThrow(
      /reserves 64/,
    );
  });
});

describe("finishBinary", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-sign-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("re-signs darwin binaries and leaves the others alone", () => {
    const { data } = machO();
    const darwin = join(dir, "darwin");
    const linux = join(dir, "linux");
    writeFileSync(darwin, data, { mode: 0o755 });
    writeFileSync(linux, data);
    finishBinary(targetById("darwin-x64"), darwin);
    finishBinary(targetById("linux-x64"), linux);
    expect(readFileSync(darwin)).toEqual(Buffer.from(adhocSign(data, "seshi")));
    expect(readFileSync(linux)).toEqual(Buffer.from(data));
    // The compiled file keeps its mode.
    if (process.platform !== "win32") expect(statSync(darwin).mode & 0o777).toBe(0o755);
  });

  // On a Mac, the real thing: a Bun-compiled binary, re-signed, passes codesign and runs.
  it.runIf(process.platform === "darwin")(
    "gives a compiled binary a signature codesign accepts",
    async () => {
      const entry = join(dir, "hello.ts");
      writeFileSync(entry, 'console.log("hello")\n');
      const outfile = join(dir, "hello");
      const build = Bun.spawn(
        [process.execPath, "build", entry, "--compile", "--outfile", outfile],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await build.exited).toBe(0);
      finishBinary(targetById(process.arch === "arm64" ? "darwin-arm64" : "darwin-x64"), outfile);
      const verify = Bun.spawn(["codesign", "--verify", "--strict", "--verbose", outfile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect([await verify.exited, await new Response(verify.stderr).text()]).toEqual([
        0,
        expect.stringContaining("valid on disk"),
      ]);
      const run = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" });
      expect([await run.exited, (await new Response(run.stdout).text()).trim()]).toEqual([
        0,
        "hello",
      ]);
    },
    60_000,
  );
});
