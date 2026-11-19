import { describe, expect, it } from "vitest";
import * as z from "zod";
import { bytes, duration, formatBytes, formatDuration, parseBytes, parseDuration } from "./units";

describe("durations", () => {
  it("parses every unit", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
    expect(parseDuration(" 5m ")).toBe(300_000);
  });

  it("refuses what is not one", () => {
    for (const text of ["", "10", "m", "1.5h", "-1s", "10 years", "1y"]) {
      expect(parseDuration(text)).toBeUndefined();
    }
  });

  it("formats with the largest exact unit up to days", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(30 * 86_400_000)).toBe("30d");
    expect(formatDuration(7 * 86_400_000)).toBe("7d");
    expect(formatDuration(90 * 60_000)).toBe("90m");
    expect(formatDuration(1500)).toBe("1500ms");
  });

  it("is a schema field taking a string or milliseconds", () => {
    const schema = duration();
    expect(schema.parse("2m")).toBe(120_000);
    expect(schema.parse(500)).toBe(500);
    expect(schema.safeParse("2 minutes").success).toBe(false);
    expect(schema.safeParse(-1).success).toBe(false);
    expect(z.toJSONSchema(schema, { io: "input" })).toMatchObject({ "x-seshi-format": "duration" });
  });
});

describe("sizes", () => {
  it("parses decimal and binary units", () => {
    expect(parseBytes("512B")).toBe(512);
    expect(parseBytes("2KB")).toBe(2000);
    expect(parseBytes("32MiB")).toBe(32 * 1024 * 1024);
    expect(parseBytes("1 GiB")).toBe(1024 ** 3);
    expect(parseBytes("3MB")).toBe(3_000_000);
    expect(parseBytes("1.5MiB")).toBeUndefined();
    expect(parseBytes("32mib")).toBeUndefined();
  });

  it("formats with the largest exact binary unit", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64MiB");
    expect(formatBytes(1536)).toBe("1536B");
    expect(formatBytes(2048)).toBe("2KiB");
  });

  it("is a schema field taking a string or bytes", () => {
    const schema = bytes();
    expect(schema.parse("1KiB")).toBe(1024);
    expect(schema.parse(10)).toBe(10);
    expect(schema.safeParse("lots").success).toBe(false);
  });
});
