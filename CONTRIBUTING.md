# Contributing

## Setup

[Bun](https://bun.sh) 1.3 or later (`.bun-version` pins what CI uses). No build step: Bun runs
the TypeScript directly.

```sh
bun install
bun run test
bun run typecheck
bun run check
bun run seshi -- <command>     # the binary, from source
bun run build                  # the compiled binary, dist/seshi
```

## The repository

A Bun workspace, laid out as in the design decisions (X3,
[`docs/seshi/design-decisions.html`](docs/seshi/design-decisions.html)):

| Path | What |
|---|---|
| `apps/seshi/` | The one binary: `src/main.ts` (the command router; each command's module loads only when it runs), the commands (`src/commands/`), the CLI's output and colours (`src/cli/`), the integration registry (`src/integrations.ts`). The `Dockerfile` is here, built from the repository root |
| `packages/ts/` | One package per domain, `@seshi/<name>`, private and source-only, in layers: `model` (0); `kit`, `formats`, `redact`, `config`, `store`, `client` (1); `pipeline`, `auth` (2); `sources`, `review`, `search` (3); `instance` (4); `api`, `capture` (5) |
| `integrations/` | Everything specific to one agent or vendor (`claude-code`, `claude-platform`, `codex`, `cursor`, `datadog-trajectory`, `gemini-cli`, `opencode`, `pi`), each exporting one `Integration` from `@seshi/kit`, with its fixtures in `testdata/` |
| `spec/` | The cross-language contract: `layout.md` (the object layout), `openapi.yaml` (the HTTP API), `schemas/` (the trace, the envelope, the stored objects), the config schemas, and `testdata/` (the record sets and goldens every language must pass) |
| `tests/` | Tests that cross packages, and the fixture and golden tooling (`tests/tooling/`) |
| `scripts/` | Repository scripts: the layer check, the generators below, the hook timing check, the release build, npm packages and smoke test (`scripts/release/`), the install scripts (`scripts/install/`), the brand outliner (`scripts/brand/`) |
| `docs/` | The user docs; [`docs/README.md`](docs/README.md) is the index. `docs/seshi/` holds the design decisions and the build notes |
| `brand/` | The brand files and colour tokens ([`brand/README.md`](brand/README.md)) |

Packages are layered, and `bun run check` runs the layer check (`scripts/check-layers.ts`)
after Biome: a package imports only from lower layers, integrations import only `@seshi/model`,
`@seshi/kit` and `@seshi/formats`, and only `apps/seshi` imports integrations. A new package
needs a layer there before it passes. `seshi hook` runs on every agent turn, so
`bun run check:hook` checks it loads nothing it does not need (and, with `--binary`, times it).

## Generated files

Some files are generated from a source of truth and committed. `bun run check` (or a test)
fails when one is stale, so run the generator in the same change as its source:

| Run | After changing | Writes |
|---|---|---|
| `bun run schema` | the config schema (`packages/ts/config`) | `spec/config.schema.json`, `spec/cli-config.schema.json` |
| `bun run types` | `spec/schemas/` | `packages/ts/model/src/generated/` |
| `bun run packs` | `packages/ts/redact/packs/builtin.toml` | `packages/ts/redact/src/generated/builtin-pack.ts` |
| `bun run brand` | `brand/tokens.json` | `apps/seshi/src/cli/brand-tokens.ts` |
| `bun run brand:outline` | a lockup or the glyph in `brand/` | the `-outlined` lockups and `glyph/seshi-glyph-badge.svg` (downloads Manrope once) |
| `bun run goldens` | hashing, events or a normalizer, on purpose | the goldens (below) |
| `bun run fixtures` | `tests/tooling/fixtures.ts` | the fixture transcripts |

## Tests

Tests sit beside the code (`*.test.ts`). They never call external services: use recorded
fixtures or local fakes. The S3 store test is the exception CI runs against a live
S3-compatible endpoint ([RustFS](https://github.com/rustfs/rustfs)); to run it locally, point
`SESSIONDB_TEST_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY` and `_SECRET_KEY` at any S3-compatible
service. Without them it skips.

## What a change needs

- Tests. Behaviour that readers of the bucket depend on (`spec/layout.md`) needs a test that
  would fail if it changed.
- `bun run check`, `bun run typecheck` and `bun run test` clean. Biome formats and lints;
  `bun run format` fixes what it can.
- Documentation in the same change. A setting is documented in `docs/config.md` (and
  `seshi.example.toml` or `.env.example` where it is one most people set); a command or flag in
  `docs/cli.md` and the command's usage text; a route in `docs/server.md` and
  `spec/openapi.yaml`; the object layout in `spec/layout.md`. A change to any of those is
  incomplete without the matching doc edit. New pages go in the index, `docs/README.md`.
- A route change is a `spec/openapi.yaml` change. `tests/api/openapi.test.ts` validates every
  response the server gives against the document and fails on a documented status it never
  observed, so a new status, field or route needs the document and a request in that test.

## The goldens

The goldens pin what every fixture transcript normalizes to and what each record set parses
to: `content_hash`, events, and the trace fields. Each integration keeps its transcripts and
their goldens in its `testdata/`; ATIF's are in `packages/ts/formats/testdata/`; the
hand-written record sets every language must pass are in `spec/testdata/`. `content_hash` is
part of the layout contract, so the goldens test (`tests/goldens.test.ts`) fails on any change
to the hash or event derivation.

If a change is meant to alter them, run `bun run goldens` and commit the regenerated files; the
diff is the review. If it is not, the failure is a bug in the change.

Fixture transcripts are produced by `bun run fixtures` and contain nothing real. Do not add a
transcript from an actual session to any `testdata/`, redacted or not.

## Redaction rules

The built-in rules are `packages/ts/redact/packs/builtin.toml` (text rules, sensitive files and
secret commands, each with its own test strings) and the secret patterns in
`packages/ts/redact/src/secrets.ts`. A new rule needs a test for what it catches and a test for
the ordinary text it must leave alone. Over-redaction is the preferred failure, but a rule that
eats common prose (`password is wrong`, a UUID, a git SHA) makes the archive useless, and the
existing tests encode those cases for a reason. After editing the pack, `bun run packs`.

## Commits and pull requests

One change per pull request, described in terms of what a user or a reader of the bucket sees.
A commit message says what changed and why; the diff already says how.

Releases are cut by [semantic-release](https://github.com/semantic-release/semantic-release)
from the commits that land on `main` (`release.config.js`, [docs/releasing.md](docs/releasing.md)),
so the subject line follows [Conventional Commits](https://www.conventionalcommits.org/):
`fix(redact): …` releases a patch, `feat(capture): …` a minor, a `BREAKING CHANGE:` footer a
major. A commit with another shape is not seen by the release pipeline at all; it ships with the
next one that is. Each release writes the version into `packages/ts/model/package.json` and
`CHANGELOG.md`, tags `vX.Y.Z`, attaches the binaries, install scripts and `SHA256SUMS` to the
GitHub release, publishes the npm packages, and pushes `ghcr.io/dosu-ai/sessiondb`. Nobody edits
a version field by hand.
