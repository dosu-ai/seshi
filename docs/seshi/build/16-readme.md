# 16 · README, brand surfaces and docs (B1.5)

Branch `seshi-16-readme`, on `seshi-15-distribution`. The README is rewritten for seshi, the
wordmark is outlined for GitHub and npm, npm pages get the face-free glyph, and `docs/` is
brought up to date with what branches 01–15 built.

## What was built

- **Outlined lockups** (B1.5). `scripts/brand/outline-wordmark.ts` (`bun run brand:outline`):
  - Reads each designer lockup, takes its one `<text>` (font, size, weight, letter spacing,
    fill), lays the text out in Manrope with fontkit (the font's kerning included, the
    variable font set to the lockup's `font-weight`, 800), and writes a copy whose wordmark is
    one `<path>`, in the lockup's own coordinates. Everything else in the file is copied as it
    is; a `<title>` and a provenance comment are added.
  - Output: `brand/lockup/seshi-lockup-dark-outlined.svg` and
    `brand/lockup/seshi-lockup-light-outlined.svg`. The designer's lockups are not written.
  - The font is Manrope from Google Fonts' repository (`google/fonts`,
    `ofl/manrope/Manrope[wght].ttf`), OFL-1.1, pinned to commit `b31870a` and checked against
    its sha256 (`MANROPE` in the script). It is downloaded once into the temp folder and never
    committed; `--font <file>` takes a local copy instead. Google Fonts publishes only the
    variable font, so the script instances it with fontkit rather than using opentype.js,
    which does not apply variations.
  - Checked by eye: each outlined copy laid over its original rendered with Manrope 800 from
    Google Fonts, at twice the size, on night ink and on paper. The outlines sit exactly on
    the live text.
- **The npm badge**: `brand/glyph/seshi-glyph-badge.svg`, written by the same script from
  `glyph/seshi-glyph-dark.svg` and the `night_ink` token. The face-free ribbon in mint on a
  night-ink rounded square, centred by its drawn bounds. B1.5 says npm pages use the glyph
  "mint on night ink"; the plain dark glyph is transparent and npm's page is white, which would
  put mint on a light background (against "deep teal on light"), so the tile carries its own
  background.
- **Freshness.** Each generated file starts with a comment naming the sha256 of its source and
  of the font. `scripts/brand/outline-wordmark.test.ts` checks that the recorded source hash is
  the current file's, that the ribbon is the designer's character for character, that no
  `<text>` or `font-family` is left, that the colours are the mode's tokens, and that the badge
  is exactly what the glyph and tokens generate. The outliner itself is tested with a stand-in
  font of squares (placement, flip, letter spacing). The tests never download the font.
- **npm READMEs** (`scripts/release/npm.ts`): `readme(title, body, version)` now starts every
  package's README with the badge, `<img … width="64" height="64" alt="">`, then the title and
  the tagline. The image URL is the badge at the release's own tag
  (`raw.githubusercontent.com/<repo>/v<version>/brand/glyph/seshi-glyph-badge.svg`, `badgeUrl`),
  so a published page never changes and the file exists once the release is tagged. It applies
  to every package, the platform packages included.
- **README.md**, rewritten: the lockup for the reader's colour scheme through `<picture>` and
  `prefers-color-scheme` (outlined copies; light: deep teal and light ink, dark: mint and paper),
  the tagline, one sentence on what seshi does, then: why; install (15's commands unchanged);
  a quick start for one person (local mode) and one for a team (server, `admin init`, `login`,
  `capture install`); a feature tour (capture, redaction rules, model review, search, access
  and visibility, OTLP, Datadog, S3 sync, formats), each linking its page; how it works; docs;
  development. The lockup is shown at 272×80 px, the glyph about 64 px tall, with no eyes. No
  status is shown by colour: the status line is quoted with its ◉ and ⏸ symbols.
- **docs/** made one set, with an index (`docs/README.md`):
  - `docs/sdk.md` (the pre-seshi `@dosu/sessiondb` SDK, flagged in 01) is replaced by
    `docs/client.md`: `@seshi/client` and `@seshi/model` as 15 publishes them, every client call
    and the route it uses, options, errors, and the contract for other languages. It says
    plainly that no library writes a bucket (X3.5).
  - `docs/server.md` is retitled and its opening rewritten for seshi: what `seshi serve` is, the
    sources beside uploads, a binary-first "Running it" (`seshi.toml`, `config check`,
    `admin init`, `serve`), and a new Sources table. It no longer points at the SDK's
    `detectSource`, which is gone; detection is `seshi normalize --json`.
  - Sections that had grown inside `server.md` and `cli.md` became their own pages, moved word
    for word with links fixed: `redaction.md` (rule packs, `redact test`, `redact backfill`),
    `model-review.md`, `s3-sync.md`, `search.md` (searching, then the index), and `formats.md`
    (a table of every transcript format seshi reads, Datadog Trajectory, ATIF, trajectory-v1,
    detection, and the trace and its renderings, which the old README carried).
  - `cli.md`'s command table loses its Status column (every command is built); exit code 9 is
    described as reserved.
  - `capture.md` says local mode needs no sign-in.
  - A search example from 12 did not run: `seshi search deploy -staging …` fails, because
    the argument parser reads `-staging` as options. The example now uses `NOT staging`, and
    the syntax paragraph says to write `NOT word` or put `-word` after `--`.
  - The field guide (`docs/understanding/`) stays, labelled as history of sessiondb v0.9.0 in a
    banner and its title.
  - Links into the moved sections were updated everywhere: the docs, the build notes (07, 08,
    11), `seshi.example.toml` and `.env.example`.
- **CONTRIBUTING.md**: the layout with every package and its layer, every integration, a table
  of the generated files and the command that writes each, the test rule, where docs go, and
  what a release publishes now (binaries, npm, image).
- **SECURITY.md**: adds the laptop (the spool holds no transcript text, the capture folder and
  credentials, pre-redaction, the retraction secret), local mode (the bucket key on the laptop),
  source credentials (Datadog, S3, OTLP service tokens) and the search index.
- **brand/README.md**: the generated files, how they are made, and Manrope's source and licence.
- **This folder's README**: the branch table with a status column and the 17 row, the final
  linear order, how 07–15 were built in parallel and rebased, and the
  `refs/backup/pre-linearise/*` refs.

Every command and flag in the README and the new pages was checked against `seshi --help` and
each command's usage. The local-mode quick start was run as written in a throwaway home
(`whoami`, `upload`, `sessions ls`, `search`, `search --status`, `capture status`), and the
team quick start's `config check` and `admin init` against a folder store.

### Review fixes

A review checked every command, flag, config key, env name and link in the README and
`docs/` against this tip (each command's usage text, both config schemas, a link and anchor
check), re-ran the local-mode quick start and the search examples, and rendered the outlined
lockups and the badge. It changed:

- `docs/client.md` read its token from `SESHI_TOKEN`, and `docs/otlp.md`'s curl example used
  `$SESHI_ADMIN_TOKEN`. Every `SESHI_*` name is read as a setting, so either variable in the
  environment stops `seshi serve` and the CLI (`SESHI_TOKEN: not a setting`), the problem 02
  removed from the old `docs/sdk.md`. They are now `ACME_SESHI_TOKEN` and `$ADMIN_TOKEN`, and
  `client.md` says why.
- README, "Why": "laptops never hold a bucket credential" was said of every laptop, and the
  team credential was described as one that can only write its person's sessions. Local mode
  puts the bucket key on the laptop, and the org key (no IdP) writes as any username. It now
  says "in a team", and names the device token and the org key.
- README: `r2://` needs `store.account_id`, now said beside the URL; the session filter is
  described as its defaults (a prompt, a reply, 2,000 characters of text and tool traffic)
  rather than "2,000 characters of conversation".

## Extension points

- **A new lockup or glyph variant for GitHub or npm**: add it to `LOCKUPS` (or a new constant)
  in `scripts/brand/outline-wordmark.ts` and to its test. `bun run brand:outline`.
- **Another surface for the badge** (a favicon, the GitHub org avatar): the badge SVG is 100×100
  and has no face, so it scales down to 32 px. B1.1's "generated sizes" can be rendered from it.
- **A new docs page**: add it to `docs/README.md`.

## Deviations and why

1. **fontkit, not opentype.js.** Google Fonts' repository publishes Manrope only as a variable
   font, and opentype.js does not apply variation tables, so the wordmark would come out at the
   default weight. fontkit 2.0.4 (exact, a dev dependency) instances the font at weight 800
   and applies its kerning. The static ExtraBold from the Manrope project's own repository
   would also do, but that repository's GitHub location did not answer; Google Fonts' copy is
   the maintained one.
2. **The outlined copies keep the designer's 340×100 viewBox**, with the space to the right of
   the wordmark. They are copies of the lockups, not new artwork. The README sizes the image
   so the glyph stays near 64 px.
3. **The npm badge is a new generated file** rather than the plain dark glyph (see above).
4. **`docs/sdk.md` is removed, not kept as history.** It described an API that no longer exists;
   `client.md` replaces it. The field guide is kept, labelled, because it records the old
   design as a whole.
5. **Feature sections moved out of `server.md`.** The README's feature tour links one page per
   feature; `otlp.md` and `datadog.md` were already pages, so redaction, model review, S3 sync
   and search became pages too. Their text is unchanged apart from headings and links.

## Still to check

- **GitHub's rendering**: `<picture>` with `prefers-color-scheme` was checked in a browser, not
  on github.com. The outlined SVGs contain only paths, so GitHub's image proxy should draw them
  as they are.
- **npm's rendering**: the badge URL resolves only once a release tag holds the file, so the
  first release after this branch merges is the first time an npm page shows it.
- **Found while checking the docs, left for 17-review** (code, not docs):
  - `@seshi/client`'s default `User-Agent` is still `@dosu/sessiondb/<version>`
    (`packages/ts/client/src/http.ts`), and the normalizer name every trace records is
    `@dosu/sessiondb` (`packages/ts/formats/src/registry.ts`). The second is pinned in
    goldens and fixtures, so changing it is a decision, not a cleanup.
  - `seshi --help` lists `sessions (ls|show|export|rm)` without `visibility`, which the
    command has.
  - The Docker Compose service and volume are still named `sessiondb` (kept on purpose, so an
    existing volume survives), and the image is `ghcr.io/dosu-ai/sessiondb` until the
    repository is renamed (X3.8).
