import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandModule,
  hexToRgb,
  isStale,
  MODULE_PATH,
  nearest16,
  nearest256,
  TOKENS_PATH,
  xterm256,
} from "./brand-tokens";

const ROOT = join(import.meta.dirname, "..");

describe("the brand colour module (B1.1, B1.4)", () => {
  it("is what brand/tokens.json generates", () => {
    expect(isStale(ROOT)).toBe(false);
  });

  it("is stale once a token changes, and when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "seshi-brand-"));
    try {
      mkdirSync(join(dir, "brand"));
      mkdirSync(join(dir, "apps/seshi/src/cli"), { recursive: true });
      const tokens = readFileSync(join(ROOT, TOKENS_PATH), "utf8");
      writeFileSync(join(dir, TOKENS_PATH), tokens);
      expect(isStale(dir)).toBe(true);
      writeFileSync(join(dir, MODULE_PATH), brandModule(tokens));
      expect(isStale(dir)).toBe(false);
      writeFileSync(join(dir, TOKENS_PATH), tokens.replace("#76D6C6", "#76D6C7"));
      expect(isStale(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses tokens it cannot read", () => {
    expect(() => brandModule("{}")).toThrow(/version and color_tokens/);
    expect(() => hexToRgb("teal")).toThrow(/#rrggbb/);
    expect(() =>
      brandModule(JSON.stringify({ version: "1", color_tokens: { "Bad-Name": "#000000" } })),
    ).toThrow(/bad token name/);
  });

  it("maps to the xterm cube and grey ramp, never the theme's own sixteen", () => {
    expect(xterm256(16)).toEqual([0, 0, 0]);
    expect(xterm256(231)).toEqual([255, 255, 255]);
    expect(xterm256(232)).toEqual([8, 8, 8]);
    expect(nearest256([255, 0, 0])).toBe(196);
    expect(nearest256([118, 214, 198])).toBeGreaterThanOrEqual(16);
  });

  it("picks the basic colour by hue, bright for a light token", () => {
    expect(nearest16(hexToRgb("#76D6C6"))).toBe(96); // mint: bright cyan
    expect(nearest16(hexToRgb("#247C73"))).toBe(36); // deep teal: cyan
    expect(nearest16(hexToRgb("#9C8ADD"))).toBe(94); // lilac: bright blue
    expect(nearest16(hexToRgb("#FFCA86"))).toBe(93); // spark: bright yellow
    expect(nearest16(hexToRgb("#F6F4EE"))).toBe(97); // paper: a near-grey
    expect(nearest16(hexToRgb("#171D2A"))).toBe(30); // night ink: a near-grey
    expect(nearest16([200, 30, 30])).toBe(31);
  });
});
