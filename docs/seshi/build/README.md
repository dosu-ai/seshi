# Building seshi

This folder tracks how the decisions in [../design-decisions.html](../design-decisions.html) are being built. Decision IDs (X4.3, F9.7) refer to that page.

## Branches

`seshi` is the base branch. It starts as `main` plus the design docs and brand files. Each piece of work is its own branch, stacked in this order, and each one is pushed. There are no PRs yet.

| # | Branch | Scope | Decisions |
|---|---|---|---|
| 01 | `seshi/01-restructure` | Move today's code into the new layout with no change in behaviour. Add the layer check. | X3 |
| 02 | `seshi/02-config` | TOML and env config loader, schema, provenance, secret references | F1 |
| 03 | `seshi/03-store` | Conditional writes, layout additions, one canonical trace format with renderers | X6.1, X6.2, X6.4, X6.5 |
| 04 | `seshi/04-pipeline` | Envelope, decide in memory and write last, no raw, session filter, replace rule, idempotency, drop and failure records | X4, X6.3 |
| 05 | `seshi/05-auth` | Tokens, org key, OIDC exchange, scopes, roles, owner IDs, visibility | X5 |
| 06 | `seshi/06-instance` | Instance, worker roles, connector scheduler, HTTP API, the `seshi` binary and command router, Docker image | X1.2, X1.4, X7, X3.3 |
| 07 | `seshi/07-redaction-rules` | TOML rule packs, RE2 for operator rules, rule counts, backfill | F2 |
| 08 | `seshi/08-model-review` | Decision model and redactor LLM | F3 |
| 09 | `seshi/09-otlp` | `POST /otlp/v1/traces`, span store, assembler | F4 |
| 10 | `seshi/10-datadog` | Datadog LLM Observability poller | F5 |
| 11 | `seshi/11-s3-sync` | S3 poller | F6 |
| 12 | `seshi/12-search` | SQLite FTS5 search | F10 |
| 13 | `seshi/13-cli` | Session CLI and CLI colours | F8.1–F8.3, B1.4 |
| 14 | `seshi/14-capture` | Hooks, spool, uploader, sweep, capture rules, status line, retraction | F9, B1.6 |
| 15 | `seshi/15-distribution` | Release binaries, npm packages, install scripts | F8.4, X3.8 |
| 16 | `seshi/16-readme` | README, brand surfaces, docs | B1.5 |

F7 (Cursor Cloud sync) is deferred and is not built.

Branches 01–06 are built one after another. Branches 07–15 are built in parallel from 06 (10 from 09, 14 and 15 from 13) and then rebased into one linear stack in the order above. 16 goes on top.

## Rules for every branch

- `bun run check`, `bun run typecheck` and `bun run test` pass at every branch tip.
- Tests never call external services. Use recorded fixtures or local fakes.
- Commits follow Conventional Commits and end with the `Co-Authored-By` trailer.
- Each branch adds `docs/seshi/build/NN-<name>.md`. It records what the branch built, the extension points later branches use, any deviations from the decisions and why, and what still needs checking.
- Shared files (the config schema index, the command registry, the integration registry, `spec/openapi.yaml`) get small, additive edits, so that rebasing parallel branches stays easy. If `bun.lock` conflicts, run `bun install` again; don't merge it by hand.
