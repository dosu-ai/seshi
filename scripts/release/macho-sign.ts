/** Ad-hoc signing of a compiled macOS binary, on any build machine (F8.4).
 *
 * `bun build --compile --target bun-darwin-x64` puts the bundle into Bun's own x86_64 runtime
 * but leaves Bun's Developer ID signature in place, so `codesign --verify` reports "invalid
 * signature (code or signature have been modified)" (Bun 1.3.11 and 1.4.2, whether built on
 * Linux or macOS). The arm64 build carries a fresh ad-hoc signature. The release job compiles
 * the darwin targets on Linux, where `codesign` does not exist, so this writes the same kind of
 * signature the linker writes for arm64: a superblob holding one SHA-256 CodeDirectory over
 * 4 KiB pages, flags `adhoc | linker-signed`, no requirements, no CMS blob.
 *
 * The signature is the last thing in the file and in `__LINKEDIT`, the last segment (as ld64
 * and Bun lay it out). When the new one needs more room than LC_CODE_SIGNATURE reserves (the
 * stale signature only covered Bun's runtime, not the bundle), the file, `__LINKEDIT` and
 * LC_CODE_SIGNATURE grow at the end; nothing else moves. Spare room is zeroed.
 *
 * Only thin 64-bit little-endian Mach-O files are handled, which is what Bun writes. */

import { createHash } from "node:crypto";

const MH_MAGIC_64 = 0xfeedfacf;
const MH_EXECUTE = 0x2;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
/** The CodeDirectory version with the exec-segment fields, as ld64 writes for arm64. */
const CD_VERSION = 0x20400;
const CS_ADHOC = 0x2;
const CS_LINKER_SIGNED = 0x20000;
const CS_EXECSEG_MAIN_BINARY = 0x1;
const CS_HASHTYPE_SHA256 = 2;
const HASH_SIZE = 32;
const PAGE_SHIFT = 12;
const PAGE_SIZE = 1 << PAGE_SHIFT;
/** Fixed CodeDirectory header size for version 0x20400. */
const CD_HEADER = 88;
const SUPERBLOB_HEADER = 12 + 8;
/** Segment sizes in memory are rounded to the larger (arm64) page size, valid on both. */
const VM_PAGE = 0x4000;

interface Segment {
  cmd: number;
  name: string;
  vmaddr: bigint;
  vmsize: bigint;
  fileoff: number;
  filesize: number;
}

interface Layout {
  filetype: number;
  sigCmd: number;
  sigOffset: number;
  sigSize: number;
  segments: Segment[];
}

function layout(data: Uint8Array): Layout {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 32 || view.getUint32(0, true) !== MH_MAGIC_64) {
    throw new Error("not a thin 64-bit little-endian Mach-O file");
  }
  const filetype = view.getUint32(12, true);
  const ncmds = view.getUint32(16, true);
  const segments: Segment[] = [];
  let sig: { cmd: number; offset: number; size: number } | undefined;
  let at = 32;
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > data.byteLength) throw new Error("malformed Mach-O load commands");
    const cmd = view.getUint32(at, true);
    const size = view.getUint32(at + 4, true);
    if (size < 8) throw new Error("malformed Mach-O load command");
    if (cmd === LC_SEGMENT_64) {
      segments.push({
        cmd: at,
        name: new TextDecoder().decode(data.subarray(at + 8, at + 24)).replace(/\0+$/, ""),
        vmaddr: view.getBigUint64(at + 24, true),
        vmsize: view.getBigUint64(at + 32, true),
        fileoff: Number(view.getBigUint64(at + 40, true)),
        filesize: Number(view.getBigUint64(at + 48, true)),
      });
    } else if (cmd === LC_CODE_SIGNATURE) {
      sig = { cmd: at, offset: view.getUint32(at + 8, true), size: view.getUint32(at + 12, true) };
    }
    at += size;
  }
  if (!sig) throw new Error("the binary has no LC_CODE_SIGNATURE to fill");
  if (sig.offset + sig.size > data.byteLength) {
    throw new Error("LC_CODE_SIGNATURE points past the end of the file");
  }
  return { filetype, sigCmd: sig.cmd, sigOffset: sig.offset, sigSize: sig.size, segments };
}

export function adhocSignature(
  data: Uint8Array,
  codeLimit: number,
  identifier: string,
  exec: { offset: number; size: number; main: boolean },
): Uint8Array {
  const ident = new TextEncoder().encode(`${identifier}\0`);
  const nCodeSlots = Math.ceil(codeLimit / PAGE_SIZE);
  const hashOffset = CD_HEADER + ident.byteLength;
  const cdLength = hashOffset + nCodeSlots * HASH_SIZE;
  const out = new Uint8Array(SUPERBLOB_HEADER + cdLength);
  const view = new DataView(out.buffer);
  // Superblob: magic, length, count, then one index entry (type, offset). Big-endian.
  view.setUint32(0, CSMAGIC_EMBEDDED_SIGNATURE);
  view.setUint32(4, out.byteLength);
  view.setUint32(8, 1);
  view.setUint32(12, CSSLOT_CODEDIRECTORY);
  view.setUint32(16, SUPERBLOB_HEADER);
  const cd = SUPERBLOB_HEADER;
  view.setUint32(cd + 0, CSMAGIC_CODEDIRECTORY);
  view.setUint32(cd + 4, cdLength);
  view.setUint32(cd + 8, CD_VERSION);
  view.setUint32(cd + 12, CS_ADHOC | CS_LINKER_SIGNED);
  view.setUint32(cd + 16, hashOffset);
  view.setUint32(cd + 20, CD_HEADER);
  view.setUint32(cd + 24, 0); // nSpecialSlots
  view.setUint32(cd + 28, nCodeSlots);
  view.setUint32(cd + 32, codeLimit);
  view.setUint8(cd + 36, HASH_SIZE);
  view.setUint8(cd + 37, CS_HASHTYPE_SHA256);
  view.setUint8(cd + 38, 0); // platform
  view.setUint8(cd + 39, PAGE_SHIFT);
  // spare2, scatterOffset, teamOffset, spare3, codeLimit64 stay zero.
  view.setBigUint64(cd + 64, BigInt(exec.offset));
  view.setBigUint64(cd + 72, BigInt(exec.size));
  view.setBigUint64(cd + 80, exec.main ? BigInt(CS_EXECSEG_MAIN_BINARY) : 0n);
  out.set(ident, cd + CD_HEADER);
  for (let i = 0; i < nCodeSlots; i++) {
    const page = data.subarray(i * PAGE_SIZE, Math.min((i + 1) * PAGE_SIZE, codeLimit));
    out.set(createHash("sha256").update(page).digest(), cd + hashOffset + i * HASH_SIZE);
  }
  return out;
}

export function adhocSign(data: Uint8Array, identifier: string): Uint8Array {
  const { filetype, sigCmd, sigOffset, sigSize, segments } = layout(data);
  const text = segments.find((s) => s.name === "__TEXT");
  if (!text) throw new Error("the binary has no __TEXT segment");

  const needed =
    SUPERBLOB_HEADER +
    CD_HEADER +
    new TextEncoder().encode(`${identifier}\0`).byteLength +
    Math.ceil(sigOffset / PAGE_SIZE) * HASH_SIZE;
  let out: Uint8Array;
  let size = sigSize;
  if (needed <= sigSize) {
    out = new Uint8Array(data);
  } else {
    // Grow at the end: the signature must close both the file and __LINKEDIT, the segment
    // that ends highest in memory.
    const linkedit = segments.find((s) => s.name === "__LINKEDIT");
    const top = segments.reduce((a, s) => (s.vmaddr + s.vmsize > a.vmaddr + a.vmsize ? s : a));
    if (
      !linkedit ||
      linkedit !== top ||
      sigOffset + sigSize !== data.byteLength ||
      linkedit.fileoff + linkedit.filesize !== data.byteLength
    ) {
      throw new Error(
        `the ad-hoc signature needs ${needed} bytes, the binary reserves ${sigSize}, and the signature is not at the end of the file and __LINKEDIT`,
      );
    }
    size = Math.ceil(needed / 16) * 16;
    const grow = size - sigSize;
    out = new Uint8Array(data.byteLength + grow);
    out.set(data);
    const view = new DataView(out.buffer);
    const filesize = linkedit.filesize + grow;
    const vmNeeded = BigInt(Math.ceil(filesize / VM_PAGE) * VM_PAGE);
    view.setBigUint64(linkedit.cmd + 48, BigInt(filesize), true);
    if (vmNeeded > linkedit.vmsize) view.setBigUint64(linkedit.cmd + 32, vmNeeded, true);
    view.setUint32(sigCmd + 12, size, true);
  }
  const signature = adhocSignature(out, sigOffset, identifier, {
    offset: text.fileoff,
    size: text.filesize,
    main: filetype === MH_EXECUTE,
  });
  out.fill(0, sigOffset, sigOffset + size);
  out.set(signature, sigOffset);
  return out;
}
