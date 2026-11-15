# seshi brand

Threadling: one uninterrupted ribbon, two small eyes. *Every session has a thread.*

The full rules are in [seshi-brand-guidelines-v1.1.pdf](seshi-brand-guidelines-v1.1.pdf). Colours and type for code are in [tokens.json](tokens.json). The CLI, the README, the docs and the desktop mod read their colours from this file.

## Files

| Path | Use |
|---|---|
| `glyph/seshi-glyph-dark.svg` | Glyph without a face, mint, for dark backgrounds. Use it for favicons, avatars and badges. |
| `glyph/seshi-glyph-light.svg` | The same glyph in deep teal, for light backgrounds. |
| `lockup/seshi-lockup-{dark,light}.svg` | Glyph plus the `seshi` wordmark, as live Manrope text. Use them where the page loads Manrope. |
| `lockup/seshi-lockup-{dark,light}-outlined.svg` | Generated. The same lockups with the wordmark as paths, for GitHub, npm and anywhere else that shows an SVG without its fonts. The repository README uses them. |
| `glyph/seshi-glyph-badge.svg` | Generated. The glyph without a face, mint on a night-ink tile, for npm pages and avatars. |
| `expressions/seshi-{happy,searching,thinking,protected,syncing,resting}.svg` | Expression poses for docs, empty states and stickers. |

## Rules that are easy to miss

- **No eyes below 48 px.** Below that size, use the glyph.
- **Use deep teal on light backgrounds.** Don't use mint on paper or on light terminals.
- **Don't show status by colour alone.** Respect `NO_COLOR`.
- **Outline the wordmark for README or npm.** The lockups keep the wordmark as live Manrope text, and GitHub and npm draw SVGs without that font. Use the `-outlined` copies there.
- **Keep expression poses off dark backgrounds.** The eyes (`#26363D`) almost vanish on night ink. Put the poses on paper or on a light tint.

`seshi-glyph-light.svg` was made from the dark glyph by swapping the stroke to `#247C73`. The files marked generated come from `bun run brand:outline` (`scripts/brand/outline-wordmark.ts`); don't edit them by hand. All other files are as the designer delivered them.

## Generated files

`bun run brand:outline` reads each lockup, sets its `<text>` in Manrope at the lockup's own size, weight (800) and letter spacing, with the font's kerning, and writes a copy whose wordmark is one path. The glyph and the colours are copied unchanged. It also writes the npm badge from `glyph/seshi-glyph-dark.svg` and the `night_ink` token.

Manrope is [the variable font in Google Fonts' repository](https://github.com/google/fonts/tree/main/ofl/manrope), licensed under the SIL Open Font License 1.1. The script pins one commit and checks the file's sha256, downloads it once into the temp folder, and never commits the font; `--font <file>` uses a copy you already have. Each generated file starts with a comment naming the sha256 of its source and of the font, and `scripts/brand/outline-wordmark.test.ts` fails when a source changed without the copies being made again.
