/** Generated from brand/tokens.json (v1.1) by scripts/brand-tokens.ts. Do not edit:
 * change the tokens and run `bun run brand`; `bun run check` fails when this file is stale.
 *
 * Each colour token with its stand-ins (B1.4): `ansi256`, the nearest xterm 256-colour value;
 * `ansi16`, the SGR code of the basic sixteen nearest in hue (bright for a light token). */

export interface BrandColour {
  hex: string;
  rgb: readonly [number, number, number];
  ansi256: number;
  ansi16: number;
}

export const BRAND_VERSION = "1.1";

export const BRAND_COLOURS = {
  thread_mint: { hex: "#76D6C6", rgb: [118, 214, 198], ansi256: 116, ansi16: 96 },
  deep_teal: { hex: "#247C73", rgb: [36, 124, 115], ansi256: 29, ansi16: 36 },
  night_ink: { hex: "#171D2A", rgb: [23, 29, 42], ansi256: 234, ansi16: 30 },
  paper: { hex: "#F6F4EE", rgb: [246, 244, 238], ansi256: 255, ansi16: 97 },
  memory_lilac: { hex: "#9C8ADD", rgb: [156, 138, 221], ansi256: 140, ansi16: 94 },
  spark: { hex: "#FFCA86", rgb: [255, 202, 134], ansi256: 222, ansi16: 93 },
  light_ink: { hex: "#173A41", rgb: [23, 58, 65], ansi256: 236, ansi16: 36 },
  happy: { hex: "#389B8C", rgb: [56, 155, 140], ansi256: 66, ansi16: 36 },
  searching: { hex: "#9380D7", rgb: [147, 128, 215], ansi256: 104, ansi16: 94 },
  thinking: { hex: "#D79E52", rgb: [215, 158, 82], ansi256: 179, ansi16: 33 },
  protected: { hex: "#5A9FC6", rgb: [90, 159, 198], ansi256: 74, ansi16: 36 },
  syncing: { hex: "#C77C9D", rgb: [199, 124, 157], ansi256: 175, ansi16: 91 },
  resting: { hex: "#8B96AB", rgb: [139, 150, 171], ansi256: 103, ansi16: 94 },
} as const satisfies Record<string, BrandColour>;

export type BrandColourName = keyof typeof BRAND_COLOURS;
