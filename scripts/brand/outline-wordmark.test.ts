import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BADGE,
  badge,
  LOCKUPS,
  MANROPE,
  type OutlineFont,
  outlineLockup,
  outlinePath,
  readProvenance,
  readWordmark,
  sha256,
  TOKENS_PATH,
} from "./outline-wordmark";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const tokens = JSON.parse(read(TOKENS_PATH)) as {
  color_tokens: Record<string, string>;
  color_modes: Record<"dark" | "light", { glyph: string; wordmark: string }>;
};

/** A font of unit squares, 1000 units per em, each glyph 600 wide. */
const squares: OutlineFont = {
  unitsPerEm: 1000,
  layout: (text) => ({
    glyphs: [...text].map(() => ({
      path: {
        commands: [
          { command: "moveTo", args: [0, 0] },
          { command: "lineTo", args: [500, 0] },
          { command: "quadraticCurveTo", args: [500, 500, 0, 500] },
          { command: "closePath", args: [] },
        ],
      },
    })),
    positions: [...text].map(() => ({ xAdvance: 600, xOffset: 0, yOffset: 0 })),
  }),
};

const LOCKUP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 100">
  <path d="M1 1" stroke="#76D6C6"/>
  <text x="100" y="50" font-family="Manrope, sans-serif" font-size="10" font-weight="800" letter-spacing="-1" fill="#F6F4EE">ab</text>
</svg>
`;

describe("outlining the wordmark (B1.5)", () => {
  it("reads the lockup's text and how it is set", () => {
    expect(readWordmark(LOCKUP)).toMatchObject({
      text: "ab",
      x: 100,
      y: 50,
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: -1,
      fill: "#F6F4EE",
    });
  });

  it("refuses a lockup without exactly one Manrope <text>", () => {
    expect(() => readWordmark(LOCKUP.replace(/<text[\s\S]*<\/text>/, ""))).toThrow(/one <text>/);
    expect(() => readWordmark(LOCKUP.replace("Manrope", "Inter"))).toThrow(/not Manrope/);
  });

  it("places each glyph at the text's size, flipped, advanced by width plus letter spacing", () => {
    const d = outlinePath(squares, readWordmark(LOCKUP));
    // Scale 10/1000: a glyph is 5 wide and 5 tall, standing on the baseline y = 50. The second
    // starts 6 - 1 = 5 to the right of the first.
    expect(d).toBe("M100 50L105 50Q105 45 100 45ZM105 50L110 50Q110 45 105 45Z");
  });

  it("keeps everything but the text, and records what it was made from", () => {
    const out = outlineLockup("lockup.svg", LOCKUP, squares, MANROPE.sha256);
    expect(out).not.toContain("<text");
    expect(out).not.toContain("font-family");
    expect(out).toContain('<path d="M1 1" stroke="#76D6C6"/>');
    expect(out).toContain('fill="#F6F4EE"');
    expect(out).toContain("<title>ab</title>");
    expect(readProvenance(out)).toEqual({ source: sha256(LOCKUP), font: MANROPE.sha256 });
  });
});

describe("the committed outlined lockups", () => {
  for (const { from, to } of LOCKUPS) {
    const mode = from.includes("dark") ? "dark" : "light";

    it(`${to} is fresh for ${from}`, () => {
      const source = read(from);
      const out = read(to);
      expect(readProvenance(out)).toEqual({ source: sha256(source), font: MANROPE.sha256 });
      // The ribbon is the designer's, character for character.
      const ribbon = /<path[^>]*stroke-linecap="round"\s*\/>/.exec(source)?.[0];
      expect(ribbon).toBeDefined();
      expect(out).toContain(ribbon as string);
      expect(out).not.toContain("<text");
      expect(out).not.toContain("font-family");
    });

    it(`${to} uses the ${mode} mode's colours`, () => {
      const out = read(to);
      expect(out).toContain(`stroke="${tokens.color_modes[mode].glyph}"`);
      expect(out).toContain(`fill="${tokens.color_modes[mode].wordmark}"`);
    });
  }
});

describe("the npm badge (B1.5)", () => {
  it("is the face-free glyph in mint on night ink, fresh for the glyph file", () => {
    const glyph = read(BADGE.from);
    const out = read(BADGE.to);
    expect(out).toBe(badge(BADGE.from, glyph, tokens.color_tokens.night_ink as string));
    expect(out).toContain(`fill="${tokens.color_tokens.night_ink}"`);
    expect(out).toContain(`stroke="${tokens.color_tokens.thread_mint}"`);
    expect(out).not.toMatch(/<circle|<ellipse/);
  });
});
