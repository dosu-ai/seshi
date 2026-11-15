# seshi verification map

This folder is the maintained source for verifying what seshi does from a user's point of view.
Read this index before driving seshi, then use the matching feature file as the recipe.

## Baseline preconditions

- A run started with `C=.claude/skills/verify-seshi/scripts/control-seshi; $C up` (local mode) or
  `$C up --server` (server mode), and `export VERIFY_SESHI_RUN=<id>` from its output.
- `$C doctor` ends with `ready`, and its commit line shows the code you mean to test.
- A fresh run is empty: no sessions, no capture toggles, no pause. Each recipe starts from that
  unless its preconditions say otherwise.
- Never drive a seshi you didn't start in this run (your real home, a teammate's server).

## Driving conventions

- Run every seshi command through `$C cli --name <label> -- <args…>`, so it gets the run's
  environment and its evidence is saved. Use `$C agent claude-code <id>` for agent activity.
- Treat each command as literal. Session ids in the recipes (`cap-1`, `tog-1`, …) are
  per-recipe, so recipes can share one run without colliding.
- Prefer `--json` output for assertions. Human output is for the person reading the evidence.
- The explore page is driven in the Browser pane by accessible names (button and tab labels,
  link text) and its API by path, never by screen coordinates.

## Proof and skip reporting

- Capture the action and the resulting state from a second, read-only view. For example: the
  `agent` call, then `sessions ls`, then `doctor`.
- CLI proof is the `.cmd`, `.out`, `.err` and `.code` files `$C cli` writes to
  `.verify/seshi/<run-id>/`.
- Page proof is a text snapshot (`get_page_text` or `read_page`) and a screenshot, saved in the
  same folder and named for the feature.
- Record which entry point (CLI, hook, API, page) each artifact came from.
- Report an entry point you could not reach with the command you tried and the precondition
  that was missing. Never count it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible
behaviour. It then has exactly four H2 sections, in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with control-seshi`: `Preconditions:` first, then labelled bullets that pair
   each action with an exact command and the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

## Features

- [Capture and upload](./capture.md): an agent session reaches the store through the hooks and
  the uploader, chunk by chunk, in local and server mode.
- [Turn capture off, on or pause it](./toggle-pause.md): per-session toggles with retraction, and
  pause and resume.
- [Sessions and search](./sessions-search.md): list, show, export and visibility of stored
  sessions, and search over them.
- [Redaction](./redaction.md): secrets in a transcript never reach the store, and `seshi redact
  test` shows what each rule takes out.
- [Doctor and explore](./doctor-explore.md): `seshi doctor` checks a session end to end, and the
  `seshi explore` page shows the same evidence read-only.

Not mapped yet: the Claude desktop Session Capture chip (`claude plugin test
integrations/claude-code/plugin`, plus a look in the desktop app); OTLP intake
(`POST /otlp/v1/traces`); the Datadog and S3 pollers; IdP sign-in.
