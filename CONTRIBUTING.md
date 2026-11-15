# Contributing

## Setup

[Bun](https://bun.sh) 1.3 or later (`.bun-version` pins what CI uses). No build step: Bun runs
the TypeScript directly.

```sh
bun install
bun run test
bun run typecheck
bun run check
```

The repository is a Bun workspace, laid out as in the design decisions (X3,
`docs/seshi/design-decisions.html`):

| Path | What |
|---|---|
| `apps/seshi/` | The one binary: `src/main.ts` (the command router; each command's module loads only when it runs), the command registry (`src/commands/`), the integration registry (`src/integrations.ts`). The `Dockerfile` is here, built from the repository root |
| `packages/ts/` | One package per domain, `@seshi/<name>`, private and source-only: `model`, `kit`, `formats`, `redact`, `config`, `store`, `pipeline`, `auth`, `sources`, `search`, `instance`, `api`, `capture`, `client` |
| `integrations/` | Everything specific to one agent or vendor (`claude-code`, `codex`, `cursor`, `datadog-trajectory`, `opencode`, `pi`, `gemini-cli`), each exporting one `Integration` from `@seshi/kit`, with its fixtures in `testdata/` |
| `spec/` | The cross-language contract: `layout.md` (the object layout), `openapi.yaml` (the HTTP API), and `testdata/` (the record sets and goldens every language must pass) |
| `tests/` | TypeScript tests that cross packages, and the fixture and golden tooling (`tests/tooling/`) |
| `scripts/` | Repository scripts: the layer check, the release version, the release build, npm packages and smoke test (`scripts/release/`, [docs/releasing.md](docs/releasing.md)), the install scripts (`scripts/install/`) |
| `docs/` | `server.md`, the API and configuration reference |

Packages are layered, and `bun run check` runs the layer check (`scripts/check-layers.ts`)
after Biome: a package imports only from lower layers, integrations import only `@seshi/model`,
`@seshi/kit` and `@seshi/formats`, and only `apps/seshi` imports integrations. Every root
script (`test`, `typecheck`, `check`, `start`, `goldens`, `fixtures`) runs across the
workspace; `bun run seshi -- <command>` runs the binary from source.

CI runs those three plus the S3 store test against a live S3-compatible endpoint
([RustFS](https://github.com/rustfs/rustfs)). To run it locally, point
`SESSIONDB_TEST_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY` and `_SECRET_KEY` at any S3-compatible
service; without them the test skips.

## What a change needs

- Tests beside the code (`*.test.ts`). Behaviour that readers of the bucket depend on
  (`spec/layout.md`) needs a test that would fail if it changed.
- `bun run check` clean. Biome formats and lints; `bun run format` fixes what it can.
- Documentation in the same change. `docs/server.md` is the API and configuration reference;
  `spec/layout.md` is the object layout; `.env.example` lists every variable. A change to any
  of those is incomplete without the matching doc edit.
- A route change is a `spec/openapi.yaml` change. `tests/api/openapi.test.ts` validates every
  response the server gives against the document and fails on a documented status it never
  observed, so a new status, field or route needs the document and a request in that test.

## The goldens

The goldens pin what every fixture transcript normalizes to and what each record set parses
to: `content_hash`, events, and the trace fields. Each integration keeps its transcripts and
their goldens in its `testdata/`; ATIF's are in `packages/ts/formats/testdata/`; the hand-written
record sets every language must pass are in `spec/testdata/`. `content_hash` is part of the
layout contract, so the goldens test (`tests/goldens.test.ts`) fails on any change to the hash
or event derivation.

If a change is meant to alter them, run `bun run goldens` and commit the regenerated files; the
diff is the review. If it is not, the failure is a bug in the change.

Fixture transcripts are produced by `bun run fixtures` (`tests/tooling/fixtures.ts`) and
contain nothing real. Do not add a transcript from an actual session to any `testdata/`,
redacted or not.

## Redaction rules

A new pattern in `packages/ts/redact/src/secrets.ts` needs a test for what it catches and a test for the
ordinary text it must leave alone. Over-redaction is the preferred failure, but a rule that
eats common prose (`password is wrong`, a UUID, a git SHA) makes the archive useless, and the
existing tests encode those cases for a reason.

## Commits and pull requests

One change per pull request, described in terms of what a user or reader of the bucket sees.
A commit message says what changed and why; the diff already says how.

Releases are cut by [semantic-release](https://github.com/semantic-release/semantic-release)
from the commits that land on `main` (`release.config.js`), so the subject line follows
[Conventional Commits](https://www.conventionalcommits.org/): `fix(redact): …` releases a patch,
`feat(sdk): …` a minor, a `BREAKING CHANGE:` footer a major. A commit with another shape is not
seen by the release pipeline at all; it ships with the next one that is. Each release publishes
`ghcr.io/dosu-ai/sessiondb` to GHCR, writes the version into `packages/ts/model/package.json`
and `CHANGELOG.md`, and tags `vX.Y.Z`; nobody edits a version field by hand.
