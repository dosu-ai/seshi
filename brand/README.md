# seshi brand

Threadling: one uninterrupted ribbon, two small eyes. *Every session has a thread.*

The full rules are in [seshi-brand-guidelines-v1.1.pdf](seshi-brand-guidelines-v1.1.pdf). Colours and type for code are in [tokens.json](tokens.json). The CLI, the README, the docs and the desktop mod read their colours from this file.

## Files

| Path | Use |
|---|---|
| `glyph/seshi-glyph-dark.svg` | Glyph without a face, mint, for dark backgrounds. Use it for favicons, avatars and badges. |
| `glyph/seshi-glyph-light.svg` | The same glyph in deep teal, for light backgrounds. |
| `lockup/seshi-lockup-{dark,light}.svg` | Glyph plus the `seshi` wordmark. |
| `expressions/seshi-{happy,searching,thinking,protected,syncing,resting}.svg` | Expression poses for docs, empty states and stickers. |

## Rules that are easy to miss

- **No eyes below 48 px.** Below that size, use the glyph.
- **Use deep teal on light backgrounds.** Don't use mint on paper or on light terminals.
- **Don't show status by colour alone.** Respect `NO_COLOR`.
- **Outline the wordmark for README or npm.** The lockups keep the wordmark as live Manrope text, and GitHub and npm draw SVGs without that font.
- **Keep expression poses off dark backgrounds.** The eyes (`#26363D`) almost vanish on night ink. Put the poses on paper or on a light tint.

`seshi-glyph-light.svg` was made from the dark glyph by swapping the stroke to `#247C73`. All other files are as the designer delivered them.
