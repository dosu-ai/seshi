<!--
Read CONTRIBUTING.md first. Solve one problem per pull request. The title is a
Conventional Commit, because semantic-release cuts versions from it:
"fix(redact): keep git SHAs out of the entropy pass".
Keep every heading below, including when an agent writes the description.
-->

## Problem

<!-- What is wrong or missing, in a sentence or two, described as what a user
or a reader of the bucket sees. Link the issue it closes (`Closes #123`). -->

## Change

<!-- How this fixes it. If the diff spans the SDK, the server and the spec,
say why each part is needed. -->

## Verification

<!-- The tests or manual checks you ran and what you observed. State anything
you could not check. CI already runs the full suite, so "tests pass" alone is
not enough. -->

## Contract

Check every line that applies:

- [ ] The bucket layout changed, and `spec/layout.md` says how.
- [ ] A route, status or field changed, and `spec/openapi.yaml` matches.
- [ ] The goldens changed on purpose, and I regenerated them with `bun run goldens`.
- [ ] None of the above.

## Docs and privacy

- [ ] Docs that describe the changed behavior are updated (`docs/server.md`, `.env.example`, the READMEs), or nothing user-visible changed.
- [ ] Every transcript, fixture and golden in this diff is synthetic. Nothing comes from a real session, redacted or not.

<!-- If an agent wrote the change, end with the model and harness, for example
"Written with Claude Opus 5.5 in Claude Code". -->
