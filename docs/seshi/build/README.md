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
| 17 | `seshi-17-review` | A review of the whole stack against the decisions, with fixes, and the final check of the stack | All (B1.3 in part) | Built, checked |
| 18 | `seshi-18-decisions` | Decisions on the ten questions 17 left open (built in 19–24) | F9.5, X4.9, F3.4, F4.1, F4.4, F2.5, X6.4, F8.4, F9.1 | Decided, built |
| 19 | `seshi-19-change-feed` | Change entries before the pointer; unique change keys | X6.4 (18 rows 7, 8) | Built |
| 20 | `seshi-20-review-drop` | A content-free stub when review drops a session's first envelope | F3.4 (18 row 3) | Built |
| 21 | `seshi-21-resend` | Stale sessions, the `rebuild` field, `seshi capture resend`; a rebuild skips what review dropped | X4.9 (18 row 2) | Built |
| 22 | `seshi-22-otlp` | OTLP body caps; span input history stored once | F4.1, F4.4 (18 rows 4, 5) | Built |
| 23 | `seshi-23-orphan-sweep` | The orphan sweep: after backfill and replace, daily, `seshi redact sweep` | F2.5 (18 row 6) | Built |
| 24 | `seshi-24-capture` | Pause stops sessions where they are; the uploader stays up while retries wait; Windows CI | F9.5, F9.1, F8.4 (18 rows 1, 10, 9) | Built |
| 25 | `seshi-25-desktop-mod` | The Claude desktop app's Session Capture chip and `/session-capture`, in the Claude Code plugin; a plugin marketplace | F9.4–F9.6 | Built |
| 26 | `seshi-26-resend-spread` | Stale rebuilds spread over a day, at most two a pass | X4.9 | Built |
| 27 | `seshi-27-security-fixes` | Fixes for 13 findings of a security review of the whole stack | X5, X5.10, F2, F4, F9.5, F9.7, F10 | Built |
| 28 | `seshi-28-doctor` | `seshi doctor`: gathers a session's evidence (laptop, transcript, server) and checks it end to end | F9, X4, X6 | Built |
| 29 | `seshi-29-explore` | `seshi explore`: a local, read-only web page over the doctor's engine (sessions, checks, pipeline, records side by side, timeline) | F9, X4, X6 | Built |

F7 (Cursor Cloud sync) is deferred and is not built. Agreed but not built, found in 17's review
and left for a decision (see [17](17-review.md#not-fixed)): the first-run notice for Cursor and
Codex (F9.4). The Claude desktop mod (F9.4–F9.6) is built in 25, and the uploader resend in 21. B1.3's state words
are used on the search empty state and `seshi upload`'s lines (17); the rest of B1.3 (the other
commands' lines, poses in the docs) is not applied.

Status: every branch is built and pushed; nothing is merged and CI has not run on any of them
(no PRs). `seshi-17-review` is the tip to review or merge. Its final check (see
[17](17-review.md#final-check)) passed `check`, `typecheck`, `test`, the generators, the
compiled binary's smoke test, `check:hook` and the Docker build there, and `check` and
`typecheck` at every tip below it. `test` also passed at every tip but 14 and 16, which still
carry the uploader's spool-order flake that 17 fixed (and one unexplained 30 s timeout at 17
in seven full runs, recorded there). What is left is in each note's "Still to check" and 17's
"Not fixed": mostly checks against real services (S3 backends, the Console, Datadog, IdPs,
agents, Windows) and decisions the design does not yet make.

Each branch has its notes here: [01](01-restructure.md), [02](02-config.md), [03](03-store.md),
[04](04-pipeline.md), [05](05-auth.md), [06](06-instance.md), [07](07-redaction-rules.md),
[08](08-model-review.md), [09](09-otlp.md), [10](10-datadog.md), [11](11-s3-sync.md),
[12](12-search.md), [13](13-cli.md), [14](14-capture.md), [15](15-distribution.md),
[16](16-readme.md), [17](17-review.md), [18](18-decisions.md), [19](19-change-feed.md),
[20](20-review-drop.md), [21](21-resend.md), [22](22-otlp.md), [23](23-orphan-sweep.md),
[24](24-capture.md), [25](25-desktop-mod.md), [26](26-resend-spread.md), [27](27-security-fixes.md), [28](28-doctor.md), [29](29-explore.md).

## How the stack was built

The stack is linear, in the order of the table: `seshi` ← 01 ← 02 ← … ← 15 ← 16 ← 17 ← 18 ← 19 ← … ← 24 ← 25 ← 26 ← 27 ← 28 ← 29. Each
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

## How 19–24 were built

The same way as 07–15: each was built in parallel from 18, then rebased in order into the linear
stack (20 onto 19, 21 onto 20, and so on up to 24 onto 23), keeping both sides where they met.
Where two branches met in behaviour, the meeting was built during the rebase, with tests:

- 20 and 21: a rebuild, or a replace after a rule or normalizer change, skips the records review
  dropped from a session's first envelope (`dropped_prefix` in the metadata). See 21's "Meeting 20".
- 21 and 24: a rebuild of a session a pause stopped is sent only up to where it stopped.
- 19 and 23: the sweep's backfill and replace paths keep 19's order (entry, pointer, then deletes).
- 23: a publish that finds its trace object already there writes it again, and the sweep checks
  an object's age once more just before deleting it, so a reused object is never swept.

The pre-rebase heads are kept as `refs/backup/pre-linearise-18/seshi-NN-<name>` in the repository
where the rebase was done (local refs, not pushed).

