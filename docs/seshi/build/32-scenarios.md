# 32 · Capture scenarios with fault injection (phase 1)

Branch `seshi-32-scenarios`, on `seshi-31-store-check` (6115024). Most bugs found in this stack
lived where capture paths meet: pause and rebuild (21 × 24), review stubs and replace (20 × 21),
a 409 resend after a moved transcript, retraction during an outage, change entry and pointer
order (19), the sweep and a reused object (23), subagents and excluded repos (27 #13). Each was
found by reading code and pinned by a hand-written unit test. This branch adds declarative
scenarios: a YAML list of agent activity, uploader passes, capture commands, clock moves and
injected faults, run in-process with invariants after every step and the doctor's and
`checkStore`'s verdicts once quiet. No real agent or model runs, so a scenario costs no tokens.
Phase 1 is in-process, deterministic and fast. The format reference an agent reads cold is
[tests/scenarios/README.md](../../../tests/scenarios/README.md).

## What was built

- **The format** (`tests/tooling/scenario/schema.ts`). YAML parsed with Bun's built-in
  `Bun.YAML` (no dependency), then checked by a hand-written validator: a step is one word or
  one key; every unknown step, unknown field and bad value fails before anything runs, naming
  the file, the step's index and its kind (`x.yaml: step 2 (turns): unknown field 'cout'`). A
  file that does not parse is a failing test, not a crash of the suite.
- **The world** (`world.ts`), all in the test process:
  - the server: `buildInstance` (the boot path `seshi serve` runs: marker, packs) over a folder
    bucket wrapped by the fault store, with the fake reviewer, the scenario's rules and format
    registry and the scenario clock, served on 127.0.0.1 behind a handler a restart swaps;
  - the machine: `tests/tooling/cli.ts`'s `Machine` running real `seshi` commands through
    `main` (hooks, `capture …`, `doctor`, `login` with the org key; local mode's CLI config);
  - the uploader: the production `Uploader`, production pre-redactor (`preRedactor`, which
    fetches the org's rules) and production `httpSink` with the account's credential, built
    fresh per pass like `seshi daemon --once` (`pass({ sweep: true })`). Only its `fetch` is
    wrapped, `now` and a seeded `random` injected, and its git identity fixed (no `git`
    processes). In local mode the sink is `localSink`'s logic over the world's Instance;
  - the fake reviewer: a `ModelReviewer` from `reviewerFromConfig` with a provider factory whose
    decision provider answers from the scenario's queue (`allow` when empty) and whose redactor
    finds the scenario's marks; every request is kept for `reviewed` and the secret invariant;
  - synthetic transcripts (`transcript.ts`) in the shape of verify-seshi's `transcript.ts`,
    longer per turn so two turns pass the session filter and one does not.
- **One clock** (`clock.ts`). It starts at 2026-09-01T09:00Z, runs with real time (so lock waits
  and short timeouts still end) and jumps on `clock`. Readers that take a clock get it (the
  uploader, the Instance, auth, `checkStore`, the sweep, the backfill). The rest of the process
  (the CLI's capture commands, hook spool entries, any default `new Date()`) reads it through a
  global `Date` replaced while a scenario runs and restored after. The fault store records each
  object's last write in scenario time, so listing and `stat` ages follow the scenario clock;
  transcript mtimes are set to it as well. Starting in the past keeps every OS-written time
  later than the scenario's, so a file lock never looks stale by accident.
- **Faults** (`faults.ts`). Production code is untouched: an HTTP fault is a `fetch` wrapper
  handed to `httpSink`; a store fault is a `Store` wrapper. Each counts matches from the moment
  it is armed, fires on the `nth` and for `times` matches (or `always` until `heal`).
- **The runner** (`runner.ts`): each step, then the invariants; `settle` and the end run the
  quiet checks. A failure throws one message: the file, the step's index and a short form of
  the step, what broke, then evidence (findings, state lines, the faults that fired, the capture
  log's last lines).
- **Vitest**: `tests/scenarios/scenarios.test.ts` makes each `*.yaml` a test; it is part of
  `bun run test` (not `test:laptop`, which leaves `tests/` out). `tests/tooling/scenario/
  scenario.test.ts` tests the validator, the fault wrappers and the clock.
- **Package export**: `apps/seshi/package.json` exports `./capture-runtime`, so the runner can
  import the production `preRedactor` by package name (the layer check refuses paths into an
  app). No code changed for it.

## Steps

Agent: `turns` (session, count, `secret`, `mark`, `in`, `hook`), `subagent` (parent, id, turns,
`in`), `compact` (`append` | `shrink`), `move-transcript`, `hook`. Uploader: `pass`. Capture:
`capture <args>` (any `seshi capture` command, with an expected exit code). Time and server:
`clock`, `restart-server`, `rules` (add or set org rules), `format-bump`, `backfill`, `sweep`.
Review: `review: [allow | redact | drop | fail]`. Faults: `fault` (HTTP or store), `heal`.
Checks: `expect` (pass summary; per session `server` present/absent/stub/redacted, `records`,
`traces`, `visibility`, `matches-transcript`, `sent-all`, `frozen`, `toggle`, `rebuild`,
`last-status`, `retract`, `id`, `doctor`; `bucket` has/lacks; `reviewed`; `store-check` warnings;
`log`), `settle`.

Faults:

| Fault | Fields | Effect |
|---|---|---|
| HTTP status | `http: "POST /v1/sessions"`, `status`, `code`, `expected` | The uploader gets that answer; the server sees nothing. A 409 names `offset_mismatch` (with `expected`) or `conflict`. |
| `drop-response` | `http` | The server commits; the uploader gets a connection error. |
| `reset` | `http` | A connection error before the server sees the request. |
| `latency` | `http`, a duration | The scenario clock moves while the request is out. |
| store | `store: put \| delete`, `key` glob, `error: fail \| precondition`, `after` | The nth matching write or delete throws a store error or `PreconditionFailed`, before it lands or after (`after: true`). |

All take `nth` (1) and `times` (1 or `always`). HTTP faults apply to the uploader's session
requests in server mode only (the runner refuses them in local mode).

## Invariants

After every step:

1. The laptop's `file_offset` never runs past the transcript (a `shrink` excused until the next
   pass).
2. Nothing past a frozen offset is stored: the server's records are at most what the transcript
   makes up to the stop as first seen, or what the server held when the stop was set; a stop
   that moves forward with no fault fired since is itself a break (the uploader moves a stop
   only when the server turns out to hold more: a lost answer, a 409).
3. No planted credential anywhere in the bucket (trace objects gunzipped) or in any request the
   fake reviewer received.
4. `checkStore` reports no error (warnings allowed mid-scenario).

Once quiet (`settle`, and an implicit one at the end):

1. `seshi doctor --json --since 3650d` fails no check for any session the laptop knows.
2. `checkStore`: no errors, no warnings but `setup.allow` and `settle.allow`.
3. The server matches each session's capture decision (turned off: tombstoned or absent, its
   retracted generation tombstoned; stored from here: stored; never stored from here: not).
4. No fault is still armed.

`settle` passes and moves the clock to the next retry or `not_before` until a pass does nothing
and nothing waits.

## Scenarios

| File | Guards | Passes |
|---|---|---|
| 01-pause-then-stale-rebuild | 21 × 24: a stale rebuild stops at the frozen offset | yes |
| 02-review-drop-stub | 20: a dropped first envelope leaves a stub; later turns stored; dropped text never stored | yes |
| 03-stub-rules-replace | 20 × 21: a replace after a rule change skips the dropped prefix, never re-reviews it | yes |
| 04-stub-chunk-format-version | 31's fix: a chunk continuing a stub records the current format version | yes |
| 05-moved-transcript-409 | 14 × 21: a moved transcript, 409 `offset_mismatch` (expected 0), 409 `conflict` converge | yes |
| 06-dropped-response | X4.7: a resend after a lost answer is idempotent, first upload and chunk, across a restart | yes |
| 07-pointer-write-fails | 19: a failed pointer write leaves a tolerated entry (`change_not_applied`, `change_orphan`), a precondition is retried | yes |
| 08-retract-during-outage | 24 × F9.7: retraction retries through 503s; turned-off content never reappears | yes |
| 09-off-then-on | F9.7: turned on again, a fresh `~1` holds all of it (local mode) | yes |
| 10-format-bump-spread | 26: rebuilds wait for `not_before`, chunks go meanwhile, two a pass | yes |
| 11-subagent-excluded-repo | 27 #13: a subagent is judged by its parent's folders | yes |
| 12-repo-visibility | 27 #2: a repo's `visibility = "org"` does not widen an owner-default session | yes |
| 13-secrets-across-chunks | F2.4: secrets through a filtered first upload, chunks, a subagent, review redact, a rebuild, a replace, a compaction | yes |
| 14-replace-leftovers-swept | 23: a replace whose delete fails leaves objects; young at 30 min, `orphan_trace` at 2 h, swept | yes |
| 15-compaction | X6.3: an appended summary goes as a chunk, a shorter log as a whole replace; records exact | yes |
| 16-backfill-then-doctor | the bug below: the doctor's prefix check after a redaction backfill | yes, with the fix |
| 17-pause-after-lost-answer | 24 × X6.3: a stop behind what the server holds; `capture on` converges | yes |
| 18-stub-retract-dropped-rebuild | 20 × F9.7 × 21: retracting a stub; a dropped rebuild, then 503s and a restart | yes |
| 19-local-store-faults | 19 × F9.7 in local mode: a change entry, a trace object and a tombstone's pointer fail mid-write | yes |

19 rather than 12–15: 16 pins the bug the runner found, and 17–19 came from probing
combinations while writing the runner and cost about 0.1 s each.

## A real bug, found and fixed

**`seshi doctor` failed `prefix` for every session a redaction backfill rewrote** (commit
`fix(doctor): skip the prefix check after a redaction backfill`). A backfill rewrites a
session's traces under the current rules and, by design (F2.5, `backfill.ts`), leaves
`normalized` as the earlier rules made it: the next whole upload is a 409 conflict and a
replace. Once the machine had fetched the new rules (any upload after the change), the doctor
compared the old prefix hash with the transcript under the new rules and reported `fail`
("rewritten history, or another machine's") for a session nothing was wrong with; a later chunk
did not clear it. Found by scenario 13 (and pinned by 16): the quiet check's doctor run failed
after `rules` + `backfill`. The fix reads the change feed: after a backfill's entry (a published
replace with `reason: "redacted"`) and before the next whole write (a published entry without
`continuation`), `prefix` is skipped and says why. Unit test in `doctor.test.ts`; docs/capture.md's
check table says so.

## Observations (not bugs, recorded for later)

- **A replace whose old-object delete fails answers 500 although it landed** (scenario 14). The
  pointer and entry are written, then `ingest` deletes the replaced objects; a failed delete
  throws, the first remaining object is never tried, and the uploader retries a write that is
  already there (its retry is a duplicate and converges; the sweep removes the leftovers after
  the hour). Best-effort deletes, as the sweep already is, would save the round trip.
- **A moved transcript with nothing new is not resent.** `pending` compares sizes, so a moved
  file goes whole only once it grows. Harmless (nothing new to send); scenarios add a turn.
- **An in-place rewrite that leaves the transcript longer is not detected by the uploader.** It
  sends a chunk from the old offset into the rewritten bytes; the doctor's `prefix` check fails
  for it. Transcripts are append-only for every agent captured today, so `compact` offers only
  `append` and `shrink`.
- **After a rule change, a session not sent again keeps what the old rules stored** and the
  doctor fails `residue` on it until `seshi redact backfill` runs (by design; scenarios add a
  `backfill`).

## Proofs that the runner catches bugs

Each fix below was reverted in the working tree (never committed), the scenarios run, and the
fix restored.

1. **21 × 24, the rebuild cut at the stop.** `uploader.ts` `sync`: `const limit = session.rebuild
   && this.rebuildDue(session.rebuild) ? size : sendLimit(session, size)`. Scenario 01 failed at
   the pass that sent the rebuild:
   ```
   step 14 (pass sweep=true): an invariant broke
     claude-code:main: the pause stopped it at 3970 bytes; the stop moved to 9997 with no lost answer
     claude-code:main: stopped at 3970 bytes (11 records), yet the server holds 26 records
   ```
2. **20 × 21 ("Meeting 20"), the replace skipping the dropped prefix.** `pipeline.ts`: the call
   to `pastDropped` disabled. Scenario 03 failed at the replace:
   ```
   step 10 (pass sweep=true): checkStore found errors
     error chain_start: the first trace starts at record 0; the dropped prefix ends at 11 (…/metadata.json)
   ```
3. **31's fix, a continued stub's format version.** `pipeline.ts` chunk path: `session.head !==
   undefined &&` removed. Scenario 04 failed at the first stale check, and 02 at its quiet check:
   ```
   04 step 9 (expect …): main: rebuild: expected "none", got "waiting"
   02 step 9 (settle max=40): once quiet, checkStore is not clean
     warn format_version_missing: no normalizer.format_version: it counts as stale, and its uploader resends it (X4.9)
   ```
4. **27 #13, a subagent judged by its parent's folders.** `state.ts` `otherFolders`: the walk up
   the parents disabled. Scenario 11:
   ```
   step 8 (expect …): agent-helper: server: expected "absent", got "present"
     bucket: 'from-the-subagent' is in bucket/owners/alice@acme.com/sessions/…/trace.….json.gz
   ```
5. **27 #2, a repo's visibility only narrows.** `uploader.ts` `details`: any repo visibility
   sent. Scenario 12: `step 5 (expect …): cloned: visibility: expected "owner", got "org"`.

## Timings

The 19 scenarios take about 2.2 s of test time (2.9 s for the file under vitest, 0.07–0.26 s
each); the full `bun run test` took 21 s on this machine (Apple silicon). Most of a
scenario's time is the doctor runs at `settle` and in `doctor` facts.

## Deviations and why

1. **The global `Date` is replaced while a scenario runs**, besides the injected clocks. The
   CLI's capture commands and the hook take no clock, and the brief rules out new hooks or
   settings in production code; replacing `Date` in-process reaches them without either.
2. **`rules` and `format-bump` are separate steps**, not one: a rule change makes whole uploads
   conflict (and residue appear), a format bump makes sessions stale; scenarios want one without
   the other. Both restart the server with the new parts.
3. **Steps added beyond the brief:** `backfill` (the doctor rightly fails `residue` after a rule
   change until one runs), `heal`, `setup.server` (extra server TOML, for
   `default_visibility`), `subagent.in`. `expect` gained `bucket`, `reviewed`, `store-check`,
   `log`.
4. **No `rewrite` compaction**; see Observations.
5. **The uploader's agents come from `INTEGRATIONS[].capture`**, the objects `seshi daemon` loads
   through `capture-agents.ts` (a test checks they are the same), and its git identity is
   fixed. The uploader lock is not taken (one pass at a time anyway).
6. **The HTTP fault is a `fetch` wrapper on the uploader's sink, not a proxy**: the
   pre-redactor's rules fetch, the CLI and the doctor reach the server unfaulted.
7. **Local mode's sink** repeats `localSink`'s twenty lines over the world's Instance, so store
   faults and the clock reach it; `localSink` builds its own Instance from the CLI config.

## Still to do

Phase 2 (proposed): out of process and concurrent. Real `seshi daemon` processes and a real
`seshi serve`, faults through a proxy on the wire, and the races phase 1 serializes away: a hook
during a pass, two uploaders and the lock, the worker's daily sweep against a publish that
reuses an object, a pause landing mid-upload. Generated scenarios: random step sequences from
the same vocabulary, shrunk to the shortest failing one. The S3 store over the writable
`FakeS3` as well as the folder store.

Phase 3 (proposed): against what phase 1 fakes. Real agents (Claude Code, Codex) writing
transcripts, the real providers behind review on an opt-in budget, live S3/R2 buckets, Windows
for the laptop side.

Also open: the doctor's other checks have not been driven through every scenario's sessions in
both modes; `capture install`, Codex and Cursor sessions, OTLP and the pollers are not scenario
steps yet.
