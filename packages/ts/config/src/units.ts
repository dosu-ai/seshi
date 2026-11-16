import * as z from "zod";

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
type DurationUnit = keyof typeof DURATION_UNITS;

const BYTE_UNITS = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};
type ByteUnit = keyof typeof BYTE_UNITS;

export const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d|w)$/;
export const BYTES_PATTERN = /^(\d+)\s*(B|KB|MB|GB|KiB|MiB|GiB)$/;

export function parseDuration(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match) return undefined;
  return Number(match[1]) * DURATION_UNITS[match[2] as DurationUnit];
}

export function formatDuration(ms: number): string {
  if (ms === 0) return "0s";
  for (const unit of ["d", "h", "m", "s"] as const) {
    if (ms % DURATION_UNITS[unit] === 0) return `${ms / DURATION_UNITS[unit]}${unit}`;
  }
  return `${ms}ms`;
}

export function parseBytes(text: string): number | undefined {
  const match = BYTES_PATTERN.exec(text.trim());
  if (!match) return undefined;
  return Number(match[1]) * BYTE_UNITS[match[2] as ByteUnit];
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B";
  for (const unit of ["GiB", "MiB", "KiB"] as const) {
    if (bytes % BYTE_UNITS[unit] === 0) return `${bytes / BYTE_UNITS[unit]}${unit}`;
  }
  return `${bytes}B`;
}

export const FORMAT_KEY = "x-seshi-format";

export function duration() {
  return z
    .union([
      z.string().regex(DURATION_PATTERN, 'a duration such as "90s", "10m", "1h", "30d"'),
      z.int().nonnegative(),
    ])
    .transform((value) => (typeof value === "number" ? value : (parseDuration(value) as number)))
    .meta({ [FORMAT_KEY]: "duration" });
}

export function bytes() {
  return z
    .union([
      z.string().regex(BYTES_PATTERN, 'a size such as "512KiB", "32MiB", "1GiB"'),
      z.int().nonnegative(),
    ])
    .transform((value) => (typeof value === "number" ? value : (parseBytes(value) as number)))
    .meta({ [FORMAT_KEY]: "bytes" });
}
