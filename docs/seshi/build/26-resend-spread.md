# 26 — Spreading stale rebuilds

21 resends a session whole with `rebuild` when the server lists it as stale (X4.9). Every
Letta-based format (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi, ATIF) carries
`@letta-ai/trajectory`'s `NORMALIZER_VERSION` in its version, so one bump of it makes nearly
every captured session stale at once, and every uploader resent all of them within the hour of
its stale check, each reviewed again by the provider when a policy applies.

## What was built

- **A random wait.** When the stale check marks a session, its `rebuild` gets `not_before`: now
  plus a random time within `resendSpreadMs` (24 hours by default). Until then the rebuild is
  not due: the session's new turns still go as ordinary chunks, and it is not counted as
  queued. `seshi capture resend` sets no `not_before`, so what a person asks for goes at once.
- **A per-pass cap.** A pass sends at most `rebuildsPerPass` (2) rebuilds; the rest go in the
  passes after (every 2 seconds while the uploader runs). This also paces `capture resend --all`.
- **Tests** (`packages/ts/capture/src/uploader.test.ts`): a rebuild spread to 12 hours waits,
  chunks going on, and goes once its time comes; three rebuilds go two in one pass and one in
  the next. The other stale tests run with no wait (`random: () => 0`).

## Still to check

- **An uploader that is not running** when a rebuild comes due sends it the next time it runs
  (a hook starts it). Machines with long gaps between sessions resend later than the spread.
- **The window is a constant**, not a config key; a team that wants rebuilds sooner or later
  cannot change it without a release.
- **`capture status`** says `resending` for a session whose rebuild is still waiting.
