import { createHash } from "node:crypto";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

export interface ArchiveEntry {
  name: string;
  data: Uint8Array;
  mode?: number;
}

const BLOCK = 512;
const MAX_SIZE = 0xffffffff;

function checkEntry(entry: ArchiveEntry): void {
  const bytes = Buffer.byteLength(entry.name);
  if (
    bytes === 0 ||
    bytes >= 100 ||
    entry.name.startsWith("/") ||
    entry.name.split("/").includes("..") ||
    entry.name.includes("\\")
  ) {
    throw new Error(`archive entry name not supported: ${JSON.stringify(entry.name)}`);
  }
  if (entry.data.byteLength > MAX_SIZE) {
    throw new Error(`archive entry too large: ${entry.name}`);
  }
}

function octal(value: number, width: number): string {
  // width - 1 digits and a NUL, as ustar writes numbers.
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(entry: ArchiveEntry, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(entry.name, 0, 100, "utf8");
  header.write(octal(entry.mode ?? 0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii"); // uid
  header.write(octal(0, 8), 116, 8, "ascii"); // gid
  header.write(octal(entry.data.byteLength, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii"); // checksum placeholder: spaces
  header.write("0", 156, 1, "ascii"); // regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function tarGz(entries: readonly ArchiveEntry[], mtime = 0): Uint8Array {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    checkEntry(entry);
    parts.push(tarHeader(entry, mtime), Buffer.from(entry.data));
    const pad = (BLOCK - (entry.data.byteLength % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function readOctal(block: Buffer, offset: number, width: number): number {
  const text = block
    .subarray(offset, offset + width)
    .toString("ascii")
    .replace(/[\0 ]+$/g, "")
    .trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

export function readTarGz(archive: Uint8Array): ArchiveEntry[] {
  const tar = gunzipSync(archive);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const stored = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] as number);
    if (sum !== stored) throw new Error(`tar header checksum mismatch at ${offset}`);
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd).toString();
    const prefixEnd = header.indexOf(0, 345);
    const prefix = header.subarray(345, prefixEnd === -1 || prefixEnd > 500 ? 500 : prefixEnd);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] as number);
    const start = offset + BLOCK;
    if (type === "0" || type === "\0") {
      entries.push({
        name: prefix.byteLength ? `${prefix.toString()}/${name}` : name,
        data: new Uint8Array(tar.subarray(start, start + size)),
        mode: readOctal(header, 100, 8),
      });
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

function dosTime(mtime: number): { time: number; date: number } {
  const d = new Date(Math.max(mtime, Date.UTC(1980, 0, 1)));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const crc32 = (data: Uint8Array) => Bun.hash.crc32(data) >>> 0;

export function zip(entries: readonly ArchiveEntry[], mtime = 0): Uint8Array {
  const { time, date } = dosTime(mtime);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    checkEntry(entry);
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE((((0o100000 | (entry.mode ?? 0o644)) << 16) >>> 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function readZip(archive: Uint8Array): ArchiveEntry[] {
  const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("not a zip archive (no end of central directory)");
  const count = buf.readUInt16LE(end + 10);
  let cursor = buf.readUInt32LE(end + 16);
  const entries: ArchiveEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const external = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`zip entry ${name}: compression method ${method} not supported`);
    if (crc32(data) !== crc) throw new Error(`zip entry ${name}: CRC mismatch`);
    const mode = (external >>> 16) & 0o7777;
    entries.push({ name, data, ...(mode ? { mode } : {}) });
  }
  return entries;
}

export function readArchive(name: string, archive: Uint8Array): ArchiveEntry[] {
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return readTarGz(archive);
  if (name.endsWith(".zip")) return readZip(archive);
  throw new Error(`not a release archive: ${name}`);
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function checksumFile(files: ReadonlyMap<string, Uint8Array>): string {
  return [...files.keys()]
    .sort()
    .map((name) => `${sha256(files.get(name) as Uint8Array)}  ${name}\n`)
    .join("");
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`not a checksum line: ${JSON.stringify(line)}`);
    sums.set(match[2] as string, match[1] as string);
  }
  return sums;
}
