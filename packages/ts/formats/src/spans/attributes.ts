/** Reading OTLP attributes (`KeyValue` lists in their JSON mapping) as plain values, and OTLP
 * times as ISO 8601. */

import type { SpanAttribute, SpanValue } from "@seshi/model";

export type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

/** An `AnyValue` as a plain value: strings, numbers, booleans, arrays and objects. An int64
 * that does not fit a double exactly stays a string; bytes stay base64. */
export function plainValue(value: SpanValue | undefined): Plain {
  if (value === undefined || value === null || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) {
    const n = typeof value.intValue === "number" ? value.intValue : Number(value.intValue);
    return Number.isSafeInteger(n) ? n : String(value.intValue);
  }
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(plainValue);
  if ("kvlistValue" in value) {
    const out: { [key: string]: Plain } = {};
    for (const kv of value.kvlistValue?.values ?? []) out[kv.key] = plainValue(kv.value);
    return out;
  }
  return null;
}

/** A span's (or resource's, or event's) attributes by key. A key repeated in the list keeps its
 * last value, as OTLP's SDKs do. */
export class Attributes {
  private readonly values = new Map<string, Plain>();

  constructor(...lists: (readonly SpanAttribute[] | undefined)[]) {
    for (const list of lists) {
      for (const kv of list ?? []) {
        if (typeof kv?.key === "string") this.values.set(kv.key, plainValue(kv.value));
      }
    }
  }

  has(key: string): boolean {
    const value = this.values.get(key);
    return value !== undefined && value !== null && value !== "";
  }

  get(key: string): Plain | undefined {
    return this.values.get(key);
  }

  /** A non-empty string, or undefined. Numbers and booleans are written as strings. */
  string(key: string): string | undefined {
    const value = this.values.get(key);
    if (typeof value === "string") return value === "" ? undefined : value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
  }

  /** The first of `keys` that has a non-empty string. */
  first(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.string(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** A whole number ≥ 0, or undefined. */
  count(...keys: string[]): number | undefined {
    for (const key of keys) {
      const value = this.values.get(key);
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
    }
    return undefined;
  }

  number(key: string): number | undefined {
    const value = this.values.get(key);
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  }

  boolean(key: string): boolean | undefined {
    const value = this.values.get(key);
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }

  /** A list of strings (an array attribute, or one string). */
  strings(key: string): string[] {
    const value = this.values.get(key);
    if (typeof value === "string") return value === "" ? [] : [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return [];
  }

  /** Keys with a prefix, in insertion order. */
  keysWith(prefix: string): string[] {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

const NANOS_PER_MS = 1_000_000n;

/** Unix nanoseconds (a decimal string or number) as ISO 8601 with millisecond precision, or
 * undefined for a missing, zero or unreadable time. */
export function isoFromNanos(nanos: string | number | undefined): string | undefined {
  if (nanos === undefined || nanos === null) return undefined;
  let ms: number;
  try {
    const big = typeof nanos === "number" ? BigInt(Math.trunc(nanos)) : BigInt(nanos);
    if (big <= 0n) return undefined;
    ms = Number(big / NANOS_PER_MS);
  } catch {
    return undefined;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Milliseconds between two Unix-nanosecond times, or undefined. */
export function durationMs(
  start: string | number | undefined,
  end: string | number | undefined,
): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  try {
    const diff = BigInt(end) - BigInt(start);
    if (diff < 0n) return undefined;
    return Number(diff) / 1_000_000;
  } catch {
    return undefined;
  }
}

/** Compare two Unix-nanosecond times (decimal strings), for sorting. */
export function compareNanos(a: string | undefined, b: string | undefined): number {
  const x = a ?? "0";
  const y = b ?? "0";
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}
