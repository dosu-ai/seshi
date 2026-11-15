/** Writes `apps/seshi/src/cli/brand-tokens.ts` from `brand/tokens.json` (B1.1): the brand's
 * colour tokens with what each becomes on a terminal that cannot show it exactly (B1.4): the
 * nearest xterm 256-colour value, and the nearest of the terminal's own sixteen. The CLI reads
 * colours only from the generated module, so a palette change is one edit to the tokens and
 * `bun run brand`. `--check` writes nothing and fails when the module is stale; `bun run check`
 * runs it.
 *
 *   bun run scripts/brand-tokens.ts [--check] */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOKENS_PATH = "brand/tokens.json";
export const MODULE_PATH = "apps/seshi/src/cli/brand-tokens.ts";

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [
    Number.parseInt(m[1] as string, 16),
    Number.parseInt(m[2] as string, 16),
    Number.parseInt(m[3] as string, 16),
  ];
}

/** The "redmean" distance: plain RGB distance weighted the way the eye weighs red and blue,
 * cheap and close enough to pick a terminal colour. */
export function distance(a: Rgb, b: Rgb): number {
  const rMean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

/** The xterm 256-colour palette from 16 up: the 6×6×6 cube and the grey ramp. 0–15 are left
 * out: they are the terminal theme's own colours, whose values nobody can know. */
export function xterm256(index: number): Rgb {
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return [v, v, v];
  }
  const levels = [0, 95, 135, 175, 215, 255];
  const n = index - 16;
  return [
    levels[Math.floor(n / 36)] as number,
    levels[Math.floor(n / 6) % 6] as number,
    levels[n % 6] as number,
  ];
}

export function nearest256(rgb: Rgb): number {
  let best = 16;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 16; i < 256; i++) {
    const d = distance(rgb, xterm256(i));
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best;
}

/** Hue (degrees), saturation and lightness (0–1). */
export function hsl(rgb: Rgb): { h: number; s: number; l: number; chroma: number } {
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l, chroma: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l, chroma: d };
}

/** The SGR foreground code of the basic sixteen that stands in for `rgb`. Their real values are
 * the terminal theme's, so this goes by hue, not by distance: the nearest of red, yellow, green,
 * cyan, blue and magenta, the bright variant for a light token; near-greys (little chroma, such
 * as paper and night ink) by lightness. */
export function nearest16(rgb: Rgb): number {
  const { h, l, chroma } = hsl(rgb);
  if (chroma < 0.1) {
    if (l > 0.75) return 97;
    if (l > 0.5) return 37;
    return l > 0.25 ? 90 : 30;
  }
  const hues: Array<[number, number]> = [
    [0, 31],
    [60, 33],
    [120, 32],
    [180, 36],
    [240, 34],
    [300, 35],
  ];
  let code = 31;
  let best = Number.POSITIVE_INFINITY;
  for (const [hue, sgr] of hues) {
    const d = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
    if (d < best) {
      best = d;
      code = sgr;
    }
  }
  return l >= 0.6 ? code + 60 : code;
}

interface Tokens {
  version: string;
  color_tokens: Record<string, string>;
}

/** The generated module's text for the tokens file's content. */
export function brandModule(tokensJson: string): string {
  const tokens = JSON.parse(tokensJson) as Tokens;
  if (typeof tokens.version !== "string" || typeof tokens.color_tokens !== "object") {
    throw new Error(`${TOKENS_PATH}: needs version and color_tokens`);
  }
  const entries = Object.entries(tokens.color_tokens).map(([name, hex]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`${TOKENS_PATH}: bad token name ${name}`);
    const rgb = hexToRgb(hex);
    return `  ${name}: { hex: "${hex.toUpperCase()}", rgb: [${rgb.join(", ")}], ansi256: ${nearest256(rgb)}, ansi16: ${nearest16(rgb)} },`;
  });
  return `/** Generated from brand/tokens.json (v${tokens.version}) by scripts/brand-tokens.ts. Do not edit:
 * change the tokens and run \`bun run brand\`; \`bun run check\` fails when this file is stale.
 *
 * Each colour token with its stand-ins (B1.4): \`ansi256\`, the nearest xterm 256-colour value;
 * \`ansi16\`, the SGR code of the basic sixteen nearest in hue (bright for a light token). */

export interface BrandColour {
  hex: string;
  rgb: readonly [number, number, number];
  ansi256: number;
  ansi16: number;
}

export const BRAND_VERSION = "${tokens.version}";

export const BRAND_COLOURS = {
${entries.join("\n")}
} as const satisfies Record<string, BrandColour>;

export type BrandColourName = keyof typeof BRAND_COLOURS;
`;
}

/** Whether the module under `root` is what the tokens generate. */
export function isStale(root: string): boolean {
  const expected = brandModule(readFileSync(join(root, TOKENS_PATH), "utf8"));
  try {
    return readFileSync(join(root, MODULE_PATH), "utf8") !== expected;
  } catch {
    return true;
  }
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  if (process.argv.includes("--check")) {
    if (isStale(root)) {
      console.error(`stale: ${MODULE_PATH}; run \`bun run brand\``);
      process.exit(1);
    }
  } else {
    writeFileSync(
      join(root, MODULE_PATH),
      brandModule(readFileSync(join(root, TOKENS_PATH), "utf8")),
    );
  }
}
