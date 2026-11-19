# 18 — Decisions on the review's open questions

[17](17-review.md) left ten findings unfixed because each needed a decision the design did not
make. They were decided on 15 Nov 2026 and are recorded on
[../design-decisions.html](../design-decisions.html) as "Revised 15 Nov 2026" under the decision
named. This branch records the decisions; branches 19–24 build them (see the build README).

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | What `seshi capture pause` does | Stop sessions where they are: a running session uploads nothing more, ever; a session started during the pause is off. No retraction; whole-log resends stop at the frozen offset. | F9.5 |
| 2 | Rebuilding laptop-uploaded sessions | The server marks sessions built by an older normalizer `stale`; the uploader resends them whole with a new `rebuild` envelope field that forces a build and review even when the log only extends what is stored. `seshi capture resend [--all \| --session <id>]` by hand. | X4.9 |
| 3 | A dropped first envelope (F3.1 against F3.4) | F3.4 wins. A drop writes a content-free session stub (session ID, owner, offset, prefix hash) beside the drop record; later appends extend it and are reviewed alone. The dropped text is never stored. | F3.4 |
| 4 | OTLP body cap | 64 MiB on the wire, 256 MiB after gunzip, `[limits]` keys, 413 naming the key. | F4.1 |
| 5 | Span records growing with the square of the calls | Store each input-history message once by content hash; span records point at them; the assembler streams. | F4.4 |
| 6 | Trace objects left by a stopped backfill or replace | A sweep deletes trace objects no metadata names that are over 1 hour old, when a backfill ends and daily. No schema change. | F2.5 |
| 7 | A change entry lost when a write fails after the pointer moves | Write the change entry before the pointer (at-least-once). | X6.4 |
| 8 | Change keys colliding within one millisecond | Make keys unique now: `<stamp>-<archive_id>-<suffix>-<kind>.json` (built with the archive id: native session ids are not key-safe); update `spec/layout.md` and every feed reader. Nothing is deployed, so no migration. | X6.4 |
| 9 | Windows in the CI test matrix | Run the laptop packages' tests (hooks, spool, uploader, CLI, config) on a Windows runner; the server stays Linux-only. | F8.4 |
| 10 | Uploader exiting during an outage | Stay running while uploads or retractions wait to retry, for at most 30 minutes after the last success. A pass whose work all failed is not idle. | F9.1 |

## Notes for building them

- 7 and 8 both change the publish path and `spec/layout.md`; build them together, and before
  anything outside this repository reads the change feed.
- 3 and 2 both add to the envelope and session metadata schemas (`rebuild`, the stub); the
  schema check regenerates the types.
- 9 cannot be checked here (no Windows machine); it is checked when CI first runs.
- 5 changes the span store only. Existing span records need no migration because nothing is
  deployed.
