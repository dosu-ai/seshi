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
bun run build --server         # the server build, with LanceDB (what the image ships)
```

The Python client (`packages/py/client`) needs [uv](https://docs.astral.sh/uv/); its tests
start a seshi server from this checkout, so they need `bun install` first:

```sh
cd packages/py/client
uv sync
uv run pytest                  # unit, spec drift and live-server tests
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

`bun install` also points git at `.githooks/`, whose pre-commit hook runs Biome on the staged
files. `bun run format` fixes most of what it reports; `git commit --no-verify` skips it. The rest
of `bun run check`, the type check and the tests run in CI.

## The repository

A Bun workspace, laid out as in the design decisions (X3,
[`docs/seshi/design-decisions.html`](docs/seshi/design-decisions.html)):

| Path | What |
|---|---|
| `apps/seshi/` | The one binary: `src/main.ts` (the command router; each command's module loads only when it runs), the commands (`src/commands/`), the CLI's output and colours (`src/cli/`), the integration registry (`src/integrations.ts`). The `Dockerfile` is here, built from the repository root |
| `packages/ts/` | One package per domain, `@seshi/<name>`, private and source-only, in layers: `model` (0); `kit`, `formats`, `redact`, `config`, `store`, `client` (1); `pipeline`, `auth` (2); `sources`, `review`, `search` (3); `instance` (4); `api`, `capture` (5) |
| `packages/py/client/` | The Python client, `seshi` on PyPI: the Python counterpart of `@seshi/client`, with its own `pyproject.toml` (uv, hatchling, ruff, mypy, pytest). Python 3.10+ |
| `integrations/` | Everything specific to one agent or vendor (`claude-code`, `claude-platform`, `codex`, `cursor`, `datadog-trajectory`, `gemini-cli`, `opencode`, `pi`), each exporting one `Integration` from `@seshi/kit`, with its fixtures in `testdata/`. Two carry an editor add-on beside it: `claude-code/plugin` (the Claude desktop app's chip) and `cursor/extension` (Cursor's status bar; `bun run ext:build`) |
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
`SESHI_TEST_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY` and `_SECRET_KEY` at any S3-compatible
service. Without them it skips.

## Scenarios

Where capture paths meet (a pause and a rebuild, a review stub and a replace, a resend after a
lost answer, a retraction during an outage), write a scenario rather than another hand-built
unit test: a YAML file in [tests/scenarios](tests/scenarios/README.md) listing agent turns,
uploader passes, capture commands, clock moves and injected faults (HTTP answers, store
failures), with what must hold. The runner drives a real served Instance and real `seshi`
commands in-process, checks its invariants after every step (offsets, nothing stored past a
pause, no planted secret in the bucket, `checkStore` errors) and the doctor and `checkStore` once
the system is quiet. Each file is a test in `bun run test`; the whole set takes a few seconds and
no tokens. Name the bug or decision a scenario guards in its header comment.

Generated scenarios find the combinations nobody wrote down: `bun run scenarios:explore` runs
random step lists from the same vocabulary, shrinks each one that fails to a minimal step list
and writes it to `tests/scenarios/found/` (`bun run test` runs 40 fixed seeds of it). For CI, a
nightly job is suggested (not set up yet): `bun run scenarios:explore --runs 3000` with a fresh
seed each night (it prints the seed), uploading `tests/scenarios/found/` as an artifact and
failing the job when anything is found. About 3,000 runs take five minutes on a laptop. A found
file is triaged as the scenarios README says, and kept under `found/` only once it passes.

Process deaths and races (an uploader or server killed mid-request, two uploaders at once, a
hook or `capture off` during a pass) need real processes: `bun run scenarios:process [files…]`
runs [tests/scenarios-proc](tests/scenarios/README.md#process-mode) with a real `seshi serve`,
uploaders and hooks behind a TCP fault proxy, in about a minute. It is not part of `bun run
test`; CI runs it nightly.

`sql`'s statement check and views have a fuzzer too: `bun run test:sql-fuzz` mutates the hostile
corpus and generates scope probes on SQLite and on DuckDB over a Lance index, and fails on any
answer that shows something the caller may not see (docs/seshi/session-tools.md, "The fuzzer").
It is not part of `bun run test`; CI runs it nightly with a fresh seed, which it prints. A finding
is fixed in the check or the views, or written down as a corpus case with a `why` and listed in
`FUZZ_KNOWN`.

## Verifying a change end to end

Unit and integration tests run seshi in-process. To show a change working the way a user meets
it (hooks, the uploader, the CLI, a served instance, the explore page), use the agent skill in
[.claude/skills/verify-seshi](.claude/skills/verify-seshi/SKILL.md). Its `control-seshi` helper
starts a throwaway, isolated seshi (`up`, or `up --server`), drives it, and keeps the evidence in
`.verify/seshi/<run-id>/` (gitignored). The feature map in its `features/` folder has the recipe
for each user-facing feature; keep it up to date when a feature's behaviour changes.

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
- A route change is a client change too, in both languages: `@seshi/client` and the Python
  client (`packages/py/client`). The Python client's `tests/test_spec_drift.py` fails when the
  document gains, moves or drops a route or a parameter, or a body it sends or reads gains,
  renames or drops a property, until the client (`src/seshi/_routes.py`, `src/seshi/models.py`)
  follows.

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
next one that is. Each release writes the version into `packages/ts/model/package.json`, the
Python client's `src/seshi/_version.py` and `CHANGELOG.md`, tags `vX.Y.Z`, attaches the
binaries, install scripts and `SHA256SUMS` to the GitHub release, publishes the npm packages,
and pushes `ghcr.io/dosu-ai/seshi`. Nobody edits
a version field by hand.
