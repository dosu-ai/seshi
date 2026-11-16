/** Writes the copies of the brand files that GitHub and npm can show (B1.5). Both draw an SVG
 * as an image, without the page's fonts, so the designer's lockups (`brand/lockup/`), whose
 * wordmark is live Manrope text, would fall back to whatever sans-serif the reader has. This
 * script reads each lockup, sets its `<text>` in Manrope at the lockup's own size, weight and
 * letter spacing (with the font's kerning), and writes a copy with the wordmark as a path.
 * It also writes the npm badge: the face-free glyph, mint on night ink (B1.2, B1.5).
 *
 * The designer's files are never written. The outputs are committed; each records the sha256
 * of the lockup and of the font it came from, and `outline-wordmark.test.ts` fails when a
 * lockup changed without the copies being made again.
 *
 * Manrope is the OFL-1.1 variable font from Google Fonts' repository, pinned to one commit and
 * checked against its sha256 (MANROPE). It is downloaded once into the temp folder; `--font`
 * names a copy instead (for a machine without network).
 *
 *   bun run brand:outline [--font <Manrope[wght].ttf>] */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

export const MANROPE = {
  name: "Manrope",
  license: "OFL-1.1",
  source: "google/fonts ofl/manrope/Manrope[wght].ttf at b31870aff700ab7a1d74fa0c6887d95beb9e0037",
  url: "https://raw.githubusercontent.com/google/fonts/b31870aff700ab7a1d74fa0c6887d95beb9e0037/ofl/manrope/Manrope%5Bwght%5D.ttf",
  sha256: "3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6",
} as const;

export const LOCKUPS = [
  {
    from: "brand/lockup/seshi-lockup-dark.svg",
    to: "brand/lockup/seshi-lockup-dark-outlined.svg",
  },
  {
    from: "brand/lockup/seshi-lockup-light.svg",
    to: "brand/lockup/seshi-lockup-light-outlined.svg",
  },
] as const;

export const BADGE = {
  from: "brand/glyph/seshi-glyph-dark.svg",
  to: "brand/glyph/seshi-glyph-badge.svg",
} as const;

export const TOKENS_PATH = "brand/tokens.json";

/** One glyph outline, in font units with y up, as fontkit gives it. */
export interface GlyphPath {
  commands: readonly { command: string; args: readonly number[] }[];
}

export interface GlyphRun {
  glyphs: readonly { path: GlyphPath }[];
  positions: readonly { xAdvance: number; xOffset: number; yOffset: number }[];
}

export interface OutlineFont {
  unitsPerEm: number;
  layout(text: string): GlyphRun;
}

export interface Wordmark {
  element: string;
  text: string;
  x: number;
  y: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
  fill: string;
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function attribute(element: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(element);
  if (!m) throw new Error(`the wordmark has no ${name}`);
  return m[1] as string;
}

function number(element: string, name: string, fallback?: number): number {
  let raw: string;
  try {
    raw = attribute(element, name);
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`the wordmark's ${name} is not a number: ${raw}`);
  return value;
}

export function readWordmark(svg: string): Wordmark {
  const matches = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)];
  if (matches.length !== 1) {
    throw new Error(`expected one <text> element in the lockup, found ${matches.length}`);
  }
  const [element, attrs, text] = matches[0] as unknown as [string, string, string];
  const fontFamily = attribute(attrs, "font-family");
  if (!/^\s*'?Manrope\b/.test(fontFamily)) {
    throw new Error(`the wordmark is set in ${fontFamily}, not Manrope`);
  }
  return {
    element,
    text: text.trim(),
    x: number(attrs, "x"),
    y: number(attrs, "y"),
    fontFamily,
    fontSize: number(attrs, "font-size"),
    fontWeight: number(attrs, "font-weight", 400),
    letterSpacing: number(attrs, "letter-spacing", 0),
    fill: attribute(attrs, "fill"),
  };
}

function format(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** The wordmark's glyphs as one SVG path, in the lockup's coordinates: each glyph scaled from
 * font units to `fontSize`, flipped to y down, and advanced by its width plus the letter
 * spacing, as an SVG renderer places `<text>`. */
export function outlinePath(font: OutlineFont, mark: Wordmark): string {
  const run = font.layout(mark.text);
  const scale = mark.fontSize / font.unitsPerEm;
  const parts: string[] = [];
  let pen = mark.x;
  run.glyphs.forEach((glyph, i) => {
    const position = run.positions[i] ?? { xAdvance: 0, xOffset: 0, yOffset: 0 };
    const ox = pen + position.xOffset * scale;
    const oy = mark.y - position.yOffset * scale;
    const point = (x: number, y: number) => `${format(ox + x * scale)} ${format(oy - y * scale)}`;
    for (const { command, args } of glyph.path.commands) {
      const a = args as number[];
      switch (command) {
        case "moveTo":
          parts.push(`M${point(a[0] as number, a[1] as number)}`);
          break;
        case "lineTo":
          parts.push(`L${point(a[0] as number, a[1] as number)}`);
          break;
        case "quadraticCurveTo":
          parts.push(
            `Q${point(a[0] as number, a[1] as number)} ${point(a[2] as number, a[3] as number)}`,
          );
          break;
        case "bezierCurveTo":
          parts.push(
            `C${point(a[0] as number, a[1] as number)} ${point(a[2] as number, a[3] as number)} ${point(a[4] as number, a[5] as number)}`,
          );
          break;
        case "closePath":
          parts.push("Z");
          break;
        default:
          throw new Error(`unknown path command ${command}`);
      }
    }
    pen += position.xAdvance * scale + mark.letterSpacing;
  });
  return parts.join("");
}

export function provenance(sourcePath: string, source: string, fontSha?: string): string {
  const font = fontSha ? ` with ${MANROPE.name} (${MANROPE.license}, sha256 ${fontSha})` : "";
  return `<!-- Generated by scripts/brand/outline-wordmark.ts from ${basename(sourcePath)} (sha256 ${sha256(source)})${font}. Do not edit; run bun run brand:outline. -->`;
}

export function readProvenance(svg: string): { source: string; font?: string } | null {
  const m =
    /<!-- Generated by scripts\/brand\/outline-wordmark\.ts from \S+ \(sha256 ([0-9a-f]{64})\)(?: with \S+ \(\S+, sha256 ([0-9a-f]{64})\))?/.exec(
      svg,
    );
  if (!m) return null;
  return m[2] ? { source: m[1] as string, font: m[2] } : { source: m[1] as string };
}

function opening(svg: string): { tag: string; index: number } {
  const m = /<svg\b[^>]*>/.exec(svg);
  if (!m) throw new Error("not an SVG");
  return { tag: m[0], index: m.index };
}

export function outlineLockup(
  sourcePath: string,
  svg: string,
  font: OutlineFont,
  fontSha: string,
): string {
  const mark = readWordmark(svg);
  const d = outlinePath(font, mark);
  const { tag, index } = opening(svg);
  const head = `${tag}\n  ${provenance(sourcePath, svg, fontSha)}\n  <title>${mark.text}</title>`;
  const body = svg
    .slice(index + tag.length)
    .replace(mark.element, `<path\n    d="${d}"\n    fill="${mark.fill}"\n  />`);
  return `${svg.slice(0, index)}${head}${body}`.replace(/\s*$/, "\n");
}

export function badge(sourcePath: string, glyphSvg: string, nightInk: string): string {
  const path = /<path\b[^>]*\/>/.exec(glyphSvg);
  if (!path) throw new Error(`${sourcePath}: no <path> in the glyph`);
  const viewBox = /viewBox="0 0 100 100"/.test(glyphSvg);
  if (!viewBox) throw new Error(`${sourcePath}: expected a 0 0 100 100 viewBox`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">`,
    `  ${provenance(sourcePath, glyphSvg)}`,
    "  <title>seshi</title>",
    `  <rect width="100" height="100" rx="22" fill="${nightInk}"/>`,
    `  <g transform="translate(5.2 8.9) scale(0.82)">${path[0]}</g>`,
    "</svg>",
    "",
  ].join("\n");
}

async function fontBytes(path: string | undefined): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (path) {
    bytes = readFileSync(path);
  } else {
    const cache = join(tmpdir(), "seshi-brand", `${MANROPE.sha256}.ttf`);
    if (existsSync(cache)) {
      bytes = readFileSync(cache);
    } else {
      process.stderr.write(`downloading ${MANROPE.source}\n`);
      const response = await fetch(MANROPE.url);
      if (!response.ok) throw new Error(`${MANROPE.url}: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      mkdirSync(join(tmpdir(), "seshi-brand"), { recursive: true });
      writeFileSync(cache, bytes);
    }
  }
  const actual = sha256(bytes);
  if (actual !== MANROPE.sha256) {
    throw new Error(
      `the font's sha256 is ${actual}, not ${MANROPE.sha256} (${MANROPE.source}); pass the pinned file with --font`,
    );
  }
  return bytes;
}

export async function writeAll(root: string, fontPath?: string): Promise<string[]> {
  const fontkit = await import("fontkit");
  const bytes = await fontBytes(fontPath);
  const base = fontkit.create(Buffer.from(bytes)) as import("fontkit").Font;
  const written: string[] = [];
  for (const { from, to } of LOCKUPS) {
    const svg = readFileSync(join(root, from), "utf8");
    const weight = readWordmark(svg).fontWeight;
    const font = base.getVariation({ wght: weight }) as unknown as OutlineFont;
    writeFileSync(join(root, to), outlineLockup(from, svg, font, MANROPE.sha256));
    written.push(to);
  }
  const tokens = JSON.parse(readFileSync(join(root, TOKENS_PATH), "utf8")) as {
    color_tokens: Record<string, string>;
  };
  const nightInk = tokens.color_tokens.night_ink;
  if (!nightInk) throw new Error(`${TOKENS_PATH} has no night_ink`);
  const glyph = readFileSync(join(root, BADGE.from), "utf8");
  writeFileSync(join(root, BADGE.to), badge(BADGE.from, glyph, nightInk));
  written.push(BADGE.to);
  return written;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { font: { type: "string" } } });
  const root = join(import.meta.dirname, "..", "..");
  for (const path of await writeAll(root, values.font)) process.stdout.write(`wrote ${path}\n`);
}
