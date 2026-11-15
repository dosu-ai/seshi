# Building seshi

This folder tracks how the decisions in [../design-decisions.html](../design-decisions.html) are being built. Decision IDs (X4.3, F9.7) refer to that page.

## Branches

`seshi` is the base branch. It starts as `main` plus the design docs and brand files. Each piece of work is its own branch, stacked in this order.

Branch names use a hyphen (`seshi-01-restructure`), not a slash: git cannot hold a branch `seshi/01-restructure` beside a branch named `seshi`, because `refs/heads/seshi` would have to be both a file and a folder.

| # | Branch | Scope | Decisions | Status |
|---|---|---|---|---|
| 01 | `seshi-01-restructure` | Move today's code into the new layout with no change in behaviour. Add the layer check. | X3 | Built |
| 02 | `seshi-02-config` | TOML and env config loader, schema, provenance, secret references | F1 | Built |
| 03 | `seshi-03-store` | Conditional writes, layout additions, one canonical trace format with renderers | X6.1, X6.2, X6.4, X6.5 | Built |
| 04 | `seshi-04-pipeline` | Envelope, decide in memory and write last, no raw, session filter, replace rule, idempotency, drop and failure records | X4, X6.3 | Built |
| 05 | `seshi-05-auth` | Tokens, org key, OIDC exchange, scopes, roles, owner IDs, visibility | X5 | Built |
| 06 | `seshi-06-instance` | Instance, worker roles, connector scheduler, HTTP API, the `seshi` binary and command router, Docker image | X1.2, X1.4, X7, X3.3 | Built |
| 07 | `seshi-07-redaction-rules` | TOML rule packs, RE2 for operator rules, rule counts, backfill | F2 | Built (already on 06) |
| 08 | `seshi-08-model-review` | Decision model and redactor LLM | F3 | Built, rebased |
| 09 | `seshi-09-otlp` | `POST /otlp/v1/traces`, span store, assembler | F4 | Built, rebased |
| 10 | `seshi-10-datadog` | Datadog LLM Observability poller | F5 | Built, rebased |
| 11 | `seshi-11-s3-sync` | S3 poller | F6 | Built, rebased |
| 12 | `seshi-12-search` | SQLite FTS5 search | F10 | Built, rebased |
| 13 | `seshi-13-cli` | Session CLI and CLI colours | F8.1–F8.3, B1.4 | Built, rebased |
| 14 | `seshi-14-capture` | Hooks, spool, uploader, sweep, capture rules, status line, retraction | F9, B1.6 | Built, rebased |
| 15 | `seshi-15-distribution` | Release binaries, npm packages, install scripts | F8.4, X3.8 | Built, rebased |
| 16 | `seshi-16-readme` | README, outlined lockups and the npm badge, the user docs brought up to date | B1.5 | Built |
| 17 | `seshi-17-review` | A review of the whole stack against the decisions, with fixes | All | Built on 16 |

F7 (Cursor Cloud sync) is deferred and is not built.

Each branch has its notes here: [01](01-restructure.md), [02](02-config.md), [03](03-store.md),
[04](04-pipeline.md), [05](05-auth.md), [06](06-instance.md), [07](07-redaction-rules.md),
[08](08-model-review.md), [09](09-otlp.md), [10](10-datadog.md), [11](11-s3-sync.md),
[12](12-search.md), [13](13-cli.md), [14](14-capture.md), [15](15-distribution.md),
[16](16-readme.md); 17 adds its own.

## How the stack was built

The stack is linear, in the order of the table: `seshi` ← 01 ← 02 ← … ← 15 ← 16 ← 17. Each
branch is pushed; there are no PRs yet.

Branches 01–06 were built one after another. Branches 07–15 were then built in parallel, each
from 06 (10 from 09, 14 and 15 from 13), so each was written and tested without the others.
They were then rebased, one at a time and in order, into the linear stack. 07 already sat on
06; 08 went onto 07, 09 onto 08, and so on up to 15 onto 14. History was kept (no squashing). Where two branches met in a
shared file (the config schema, `spec/openapi.yaml`, the command registry, the routes), both
sides were kept. Each rebase added a wiring commit for what only works once the branches below
it are present (07's rules reaching 09's spans, 12's search in 13's CLI, 07's rules in 14's
uploader, and so on), and `bun run check`, `bun run typecheck` and `bun run test` passed at
each new tip. Each branch's note has a section on that wiring and what is still open.

The heads of 06–15 from before the rebase are kept in the repository where the rebase was done,
as `refs/backup/pre-linearise/seshi-NN-<name>`, so each original branch can still be compared
with its rebased form (`git range-diff`). They are local refs and were not pushed.

## Rules for every branch

- `bun run check`, `bun run typecheck` and `bun run test` pass at every branch tip.
- Tests never call external services. Use recorded fixtures or local fakes.
- Commits follow Conventional Commits and end with the `Co-Authored-By` trailer.
- Each branch adds `docs/seshi/build/NN-<name>.md`. It records what the branch built, the extension points later branches use, any deviations from the decisions and why, and what still needs checking.
- Shared files (the config schema index, the command registry, the integration registry, `spec/openapi.yaml`) get small, additive edits, so that rebasing parallel branches stays easy. If `bun.lock` conflicts, run `bun install` again; don't merge it by hand.
