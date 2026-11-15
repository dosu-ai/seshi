# 33 · Generated capture scenarios with shrinking (phase 3)

Branch `seshi-33-scenario-gen`, on `seshi-32-scenarios` (0d22120). Branch 32 built an
in-process scenario runner and nineteen hand-written scenarios; they found one real bug. This
branch writes the scenarios nobody wrote: a generator of valid step lists from a seed, a
shrinker that cuts a failing one down to a minimal step list, a small fixed budget of it in
`bun run test`, and `bun run scenarios:explore` for long runs. Running about 28,000 generated
scenarios found sixteen real seshi bugs (all fixed here, each in its own commit with a unit
test and a kept scenario), two runner bugs, five invariants stated more strictly than the
design, and three ways the generator or the faults were unrealistic. Phase 2 (real processes)
is built on another branch; nothing here touches it.

## What was built

- **The generator** (`tests/tooling/scenario/generate.ts`). fast-check draws a *plan*: a setup
  choice and up to `maxSteps` abstract choices, each a weighted step kind and four small numbers
  (0–99). `buildScenario` turns a plan into YAML-shaped steps, deterministically, by walking the
  choices against a model of what exists (main sessions and their turns, subagents and the
  parent each belongs to, compacted sessions, armed HTTP and store faults, a rule change not yet
  backfilled, whether a pause, `off` or path rule came before). The raw steps go through
  `parseScenario`, the validator hand-written files go through. `toYaml` writes them back one
  step per line, in the style of the hand-written files; a test checks the YAML reads back as
  the same scenario.
- **The explorer** (`explore.ts`). One run is one seed: `fc.check(property, { seed, numRuns: 1 })`
  draws one plan and runs its scenario with `runScenario`. Any throw is a failure: an invariant,
  a quiet check, or an unexpected exception (a schema error is the generator's own bug and stops
  the run instead). On a failure fast-check shrinks the plan, and the minimal scenario is written
  to `tests/scenarios/found/<seed>-<hash>.yaml` with a header: the seed and the command that
  generates it again, the original and shrunk lengths, and the failure (temporary folders written
  `<home>` and `<world>`).
- **Two ways to run it.** `tests/scenarios/generated.test.ts` runs 40 fixed seeds (33000–33039)
  of up to 25 steps in `bun run test`; `bun run scenarios:explore [--runs N] [--seed S]
  [--max-steps M] [--shrink-runs K]` (defaults 200 runs, a random seed it prints, 25 steps, 300
  shrink runs) prints the runs, steps, passes and faults, each failure with its file, the
  failures grouped by kind, and exits 1 when anything failed.
- **Found scenarios run as regressions.** `scenarios.test.ts` runs `tests/scenarios/found/*.yaml`
  after the hand-kept ones. Four were promoted to numbered scenarios with `expect` steps (20–23).

### Why fast-check

It gives seeded, replayable generation and *integrated* shrinking: the shrinker works on the
plan (fewer choices, smaller numbers) rather than on YAML, and because validity is enforced by
the builder and not by the arbitraries, every candidate it tries is a valid scenario. Index 0 of
every option list is the plainest choice, so numbers shrinking toward 0 make steps plainer too
(local mode is chosen by the high end of its number, so a shrink prefers server mode). A
hand-rolled delta-debugger over step lists would have had to re-check preconditions after every
cut and shrink parameters separately. The cost is one devDependency (`fast-check` 4.10).

### Determinism

The same seed and `--max-steps` always make the same scenario. Shrinking is deterministic too:
fast-check's shrink order is fixed for a seed; a candidate counts as failing only when it fails
*the same way* (the same headline, and the original's first finding still among its findings,
numbers, session names and bucket keys made generic), so the shrink does not slip to another
bug; each distinct scenario runs once (a cache keyed by its steps answers the many candidates
that make the same steps); and the budget is a count of scenario runs (300 by default, 150 in
the test suite), never a time. The runner itself is deterministic for a given scenario as far as
it matters: its clock runs with real time between jumps, which moves timestamps by milliseconds
but never across a backoff or an hour.

## Weights and preconditions

| Kind | Weight | What it becomes |
|---|---|---|
| turns | 20 | 1–3 turns (2 first) for one of 1–3 sessions (`main`, `a`, `b`); 1 in 5 plants secrets or a mark; 1 in 10 runs without a hook, with `SessionEnd`, in `code/other`, or in `code/private` (a repo with `capture = false` when the setup has one) |
| pass | 18 | `pass` (1 in 5 without the sweep) |
| http | 9 | server mode only: `POST /v1/sessions` (7 in 10), `DELETE /v1/sessions/*`, `GET /v1/sessions/stale`; 503, 500, 502, 429, drop-response, reset, latency 2s or 5m, 409 `offset_mismatch` with `expected` 0 or past the transcript; `times` 1, 2 or `always`, or `nth: 2` |
| clock | 7 | `+1m`, `+5m`, `+30m`, `+2h`, `+1d` |
| store | 6 | put of a pointer, a change entry or a trace object, or delete of a trace or pointer; fail or `PreconditionFailed`; before or after the write; once or twice |
| subagent | 5 | `x` or `y` of an existing session (a subagent keeps its first parent) |
| review | 5 | review on only: 1–3 of allow, redact, drop, fail |
| off, on | 4 each | `--session` of an existing session (1 in 4 may name a subagent) |
| compact | 3 | `append`, or `shrink` (see below) |
| pause, resend, restart, heal | 3 each | `pause 2h`, `pause`, `pause 30m`; `resend --all`; `restart-server`; `heal` when something is armed |
| hook, move, resume, rules, bump, backfill, sweep, settle | 2 each | a hook event; a move to `code/moved` or `code/other` followed by a turn; `resume`; a rule added or the rules set (unique ids, patterns that match the turns); `format-bump`; `backfill`; `sweep`; an intermediate `settle` |
| path | 1 | `off --path code/other`, `on --path`, global `off`, `on` |

Setup: server mode 85 in 100, review on 2 in 5 (`on_failure` drop or skip), `default_visibility
= "owner"` 1 in 5, the private repo 1 in 4, the uploader's seed 1–1000. `fc.array` with
`size: "max"`: about 12 choices on average for 25, plus the closing steps.

Preconditions, each a rule of the builder:

- a step that needs a session comes after its first turns (else the choice yields nothing);
- HTTP faults only in server mode; `review` only with review on;
- a `heal` before a `backfill` or a `sweep` while a store fault is armed (they write the bucket
  themselves, and the runner fails the step when they fail);
- before any `settle` (and at the end): a `heal` when a fault is armed, a `backfill` after a rule
  change (the doctor rightly fails `residue` until one runs, 32's observations);
- `resend` only as `--all` (`--session` exits 0, 4 or 9 depending on what the uploader did);
- a move is followed by a turn (a moved transcript goes whole only once it grows, 32);
- `shrink` only where it really shortens the transcript, never through an earlier summary, only
  for a session every pass uploads (no pause, `off` or path rule before, never in the private
  repo), and settled at once: build note 32 records an in-place rewrite that leaves the
  transcript longer as undetected by design (transcripts are append-only for every agent
  captured today), and a shrink that grows again before the uploader sends it is one;
- no injected `409 conflict`: a server answers it to a whole log that no longer extends what it
  holds, and the uploader replaces only a session it sent; injected blind it lands on first
  uploads and chunks, where it can only mean another machine's session, which the uploader
  refuses by design (uploader.ts, X4.6). The real conflict path is reached through rule changes
  and whole resends;
- `PreconditionFailed` before the write only on the pointer (a compare-and-swap that lost a
  race); trace objects and change entries are put only if absent (publish.ts, json.ts), so a
  store refusing them before they land says "it exists" of something missing. After the write
  it is allowed on any put; deletes here are unconditional.

## Budgets and timings

- In `bun run test`: 40 seeds of up to 25 steps, 2.2 s of test time (3.0 s for the file under
  vitest), in its own file, so it runs beside the others. The whole `bun run test` took 19–23 s
  on this machine (Apple silicon) over the last runs, against 21 s in 32's note. The 27 kept
  scenarios in `found/` and four new hand-kept ones bring `scenarios.test.ts` from 2.2 s to
  4.5 s of test time.
- Exploration: about 15 scenarios a second when nothing fails (60–70 ms each), so 3,000 runs
  in about five minutes. A failure costs its shrink: 25–110 scenario runs here, 2–10 s.

## The exploration

Each run used the code of its time: the failures of one were triaged and fixed before the
next. Steps count the generated scenario (closing steps included), not the shrink's runs.

| Run | Seeds | Runs | Steps | Time | Failures | Before it |
|---|---|---|---|---|---|---|
| 1 | 1–20, 100–139 | 60 | about 650 | 25 s | 2 | the first generator |
| 2 | 1000–1399 | 400 | 4,158 | 84 s | 16 | the conflict injection removed |
| 3 | 2000–2999 | 1,000 | 10,850 | 46 s | 1 | bugs 1 and 2, the first runner and invariant fixes, the precondition rule |
| 4 | 5000–7999 | 3,000 | 31,941 | 187 s | 8 | the shrink rule |
| 5 | 10000–15999 | 6,000 | 67,115 | 412 s | 9 | bugs 3–5, 7 (part) |
| 6 | 20000–27999 | 8,000 | 87,672 | 540 s | 10 | bugs 6–9, the rest of 7 |
| 7 | 40000–45999 | 6,000 | 66,280 | 377 s | 3 | bugs 10–15 |
| 8 | 60000–63999 | 4,000 | 43,858 | 247 s | 2 | bug 16, the shrink-excuse fix |
| | | **28,460** | **about 312,500** | **32 min** | **51** | |

The 51 failures shrank to the 27 distinct ones below, the open one included (several seeds
found most). In runs 5–8 (the earlier ones predate the count) the scenarios that passed made
89,366 uploader passes and fired 5,337 faults. The failure rate fell
from 4% (run 2) to 0.05% (run 8); run 8's two are found/60224 (fixed in the runner since) and
the one open finding under Still to check.

## Every failure found, and what was done

Seeds name the first runs that found each (several found the same failure); the found file
kept is in `tests/scenarios/found/` unless a numbered scenario says otherwise.

### Real seshi bugs, fixed

| # | Found by | Failure | Fix (commit) | Kept as |
|---|---|---|---|---|
| 1 | 104, 1322 | the doctor failed `offsets` and `records` for a session whose replace review dropped (`replace_next`, by design waiting for the transcript to grow) | warn instead (`fix(doctor): warn, not fail, while a replace review dropped waits`) | 20 |
| 2 | 1169 | a first upload stored with its answer lost, then a shrink: the retry's 409 conflict was refused for good, since the uploader replaced only sessions it knew it had stored | replace any session it sent, with its secret; the server checks it (`fix(capture): replace on conflict a session whose answer was lost`) | 21, found/1169 |
| 3 | 5707, 5928, 7322, 7700, 15407 | `resend` of a stub answers `unchanged`; the doctor knew a stub only by `dropped` and failed `presence` | either answer is a stub's (`fix(doctor): recognise a stub after a resend answered unchanged`) | 7322 |
| 4 | 7539, 10852 | a tombstone whose pointer landed but answered failed, or answered `PreconditionFailed`, left the retracted session's traces in the bucket (checkStore error) | keep the traces read across compare-and-swap attempts; `finishTombstone` removes leftovers before "already removed" (server and local sink) (`fix(pipeline): remove a tombstoned session's traces when its pointer write was retried`) | 7539, 10852 |
| 5 | 7587 | an offset_mismatch that moved the offsets to the transcript's end kept the last answer's records, which the doctor compared with the server | drop `shipped` on the move (`fix(capture): forget the last answer when offset_mismatch moves the offsets`) | 7587 |
| 6 | 11099 | a paused session whose transcript moved: the hook spooled nothing, the sweep forgot the session with its stop and secret, and a later hook captured it again | the hook tells the uploader the new path; the uploader follows a `paused` entry's path (`fix(capture): follow a paused session's transcript when it moves`) | 11099 |
| 7 | 7896, 12775, 15409 | a lost answer, then a pause: the doctor failed `offsets` (server ahead), `records` (no answer, lengths unknown) and `presence` (filtered, then grown and stored) | a warning, a skip, the lost-answer warning (`fix(doctor): a lost answer before a pause is a warning, not a failure`) | all three |
| 8 | 12396, 13980 | a rule renamed or replaced: the backfill found nothing new and re-labelled the rule set; the stored records keep the old rule's markers and the doctor failed `prefix` | skip when the stored records hold markers this machine's redaction does not write (`fix(doctor): skip the prefix when the stored records keep an earlier rule's markers`) | both |
| 9 | 14643 | a stub a chunk continued, then a log shorter than the dropped start: the replace recorded that log's position behind the trace (checkStore `chain_total`, an error) | change nothing and answer as a dropped replace (`fix(pipeline): leave a stub with a trace as it is when a replace ends in the dropped start`) | 22, found/14643 |
| 10 | 20218, 21278, 23005 | a rule added after review dropped a first envelope: the dropped start is hashed under the old rules and not stored to redo; the doctor failed `prefix` | skip when the dropped start no longer hashes as recorded (`fix(doctor): skip the prefix when a stub's dropped start no longer hashes as it did`) | 21278 |
| 11 | 20840 | a lost chunk holding a secret: the doctor mapped the server's length as if every length were kept and failed `records` | skip while the server holds more than this machine heard of (`fix(doctor): skip records when the server holds a piece with no answer`) | 20840 |
| 12 | 22478, 23825, 24135 | a backfill cleared `applied`, the drops in it too, so a chunk review dropped became an unexplained `chain_gap` | keep the drops (`fix(pipeline): keep the drops in applied when a backfill rewrites a session`) | 23825 |
| 13 | 20319 | a rebuild retried with the same key after the transcript grew was answered with the first attempt's result: offsets past what the server held | the key names the piece's end (`fix(capture): name the piece in a rebuild's idempotency key`) | 20319 |
| 14 | 27520 | a session turned off whose transcript moved was forgotten by the sweep, toggle and all; captured again, its uploads met the tombstone | the sweep looks a toggled session up by id when its path is gone (`fix(capture): keep a session turned off whose transcript moved`) | 27520 |
| 15 | 22691, 33039 | `capture on` called off a retraction still waiting, which may have landed with its answer lost: every later upload refused (422 redacted) | a waiting retraction is done, then `<id>~1`; a refused one is still called off; docs/capture.md says so (`fix(capture): do not call off a waiting retraction when a session is turned on`) | 33039 |
| 16 | 41834 | a session seen in a repo that turns capture off, whose transcript then moved, was forgotten (the same hole as 14), captured again as new: **what it wrote in the excluded repo was uploaded** (27 #13), under a new secret | the sweep looks up by id any known session whose path is gone (`fix(capture): keep any session whose transcript moved, not only one turned off`) | 23, found/41834 |

Six of the sixteen are the doctor reporting a failure for a state the design means (1, 3, 7,
8, 10, 11: the quiet check saw them); seven lose or misplace the laptop's state, and with it
data (2, 5, 6, 13, 14, 15, 16; 16 uploaded content an excluded repo's config kept out, and 4
left retracted content in the bucket); three leave the bucket in a state its own checker calls
wrong (4, 9, 12). Each fix was proven by reverting it in the working tree and watching its unit
test and its scenario fail.

### Runner and explorer bugs, fixed

- **A retraction in backoff never woke** (seeds 1043, 1142, 1225, 1339, 1366): `settle` moved the
  clock only for sessions not turned off, but a retraction waits out the backoff an earlier
  upload failure set. Kept: found/1339.
- **A shrink's excuse ended too early** (seeds 40941, 41365): invariant 1 allows an offset past a
  shrunk transcript until the uploader has looked, but the runner cleared it after any pass, one
  that skipped the session in backoff too. Kept: found/40941.
- The explorer's own: failure signatures carried bucket keys with random ids, so shrinks of
  store-key failures never matched (they now say `KEY`); the first version matched only the
  first finding exactly, so a candidate that added a finding stopped the shrink (now: the
  original's first finding still among them); a schema error thrown inside the property was
  shrunk like a finding (now it stops the run).

### Invariants stated too strictly, adjusted

- **Change entries of failed writes** (seeds 1042, 1095, 1108, 1337, 1390): once quiet,
  `change_orphan` and `change_not_applied` are allowed when a store fault fired on a change entry
  or a pointer. Decision 7 (X6.4) and scenario 07: the entry is written before the pointer moves,
  a failed write leaves it, readers and checkers tolerate it, checkStore warns, never errors.
  Kept: found/1108, found/1042-trimmed (trimmed by hand from 22 steps).
- **Orphan traces after store faults** (seed 7080): once quiet, `orphan_trace` is allowed when any
  store fault fired. F2.5: the orphan sweep removes unnamed objects an hour old; 32's scenario 14
  allows it the same way. Kept: found/7080.
- **Sent, but never answered as stored** (seeds 1233, 1272, 13605): "never stored from here, but
  the server holds it" now applies only to a session never sent. `stored` is set only from an
  answer; a sent session whose answer was lost and that is not sent again (a pause, F9.5; a repo
  that turns capture off, 27 #13) keeps what it uploaded without hearing so. Invariant 2 still
  bounds what a stopped session may hold. Kept: found/1233, found/13605.
- **A stub's leftover of a failed trace write** (seed 60224): a trace object whose write landed
  but answered as failed, in the folder of a session review then turned into a stub, is
  `stub_trace_object`, an error once older than the sweep's hour, because the orphan sweep
  (F2.5) should have removed it by then; a scenario runs no worker. Allowed (mid-scenario and
  once quiet) only when a trace object's write failed. Kept: found/60224.
- **Leftover traces while a retraction is retried** (seed 7539): mid-scenario,
  `redacted_trace_object` is not an error for a session whose retraction this machine is still
  retrying; the retry removes them (bug 4's fix). Once quiet it is checked as before.

### Unrealistic generator or faults, fixed in the generator

- **Injected 409 conflict** (seed 1): refused for good by design when it lands on a first upload.
  Removed (see Preconditions).
- **`PreconditionFailed` before a put-if-absent** (seeds 1123, 1242): `head_missing`, because the
  store claimed a missing object existed. Allowed only where a store can say it.
- **A shrink that grows before the uploader sees it** (seed 2273): the undetected in-place
  rewrite of 32's observations. Shrinks are settled at once, for plain sessions only.

## Production code changed

`apps/seshi/src/doctor/checks.ts` (bugs 1, 3, 7, 8, 10, 11), `apps/seshi/src/commands/capture.ts`
(15), `apps/seshi/src/capture-runtime.ts` and `packages/ts/api/src/app.ts` (4),
`packages/ts/capture/src/uploader.ts` (2, 5, 6, 13, 14, 16), `packages/ts/capture/src/hook.ts` (6),
`packages/ts/pipeline/src/ingest.ts` and `index.ts` (4), `packages/ts/pipeline/src/pipeline.ts`
(9), `packages/ts/pipeline/src/backfill.ts` (12). docs/capture.md's doctor table and retraction
section follow.

## Still to check

- **Open: one record short after a rule change, a lost answer and a backfill** (seed 62372, the
  last exploration, not triaged in time). The doctor fails `records` ("the transcript's first
  11910 bytes normalize to 31 records; the server counts 30"); every turn's text is in the
  bucket and the laptop has sent all of it, so it may be the doctor's count (pre-redaction
  under a rule that changes lengths, `module \d+`) rather than a lost record. Not kept in
  `found/` (it fails); the steps:

  ```yaml
  steps:
    - turns: { session: main, count: 2 }
    - pass
    - turns: { session: main, count: 2 }
    - rules: { add: [{ id: r1, pattern: "module \\d+" }] }
    - fault: { store: put, key: "owners/*/sessions/*/metadata.json", after: true }
    - pass
    - turns: { session: main, count: 2 }
    - fault: { store: put, key: "owners/*/sessions/*/metadata.json" }
    - heal
    - backfill
    - settle
  ```

- **A sweep in the quiet check.** Orphans of failed writes are allowed once quiet rather than
  swept; running the orphan sweep (as the worker would) before the last checkStore and then
  requiring it clean would also check the sweep removes them.

- **The generator's reach.** Steps it does not make: `expect` (the oracle is the invariants
  only), `capture` with `--session` for resend, `pause` lengths other than three, Codex and
  Cursor sessions, OTLP, `setup.rules` at the start, more than one machine. A sharper oracle
  (records stored = what the transcript makes, for every session, once quiet, where no review
  dropped anything) would catch silent loss the doctor does not report.
- **Coverage.** The explorer prints passes and faults fired, but not which code paths ran;
  per-kind counts of faults that fired (most armed faults fire, but `DELETE` and `stale` faults
  fire only when a retraction or a stale check happens) would show what is under-exercised.
- **Doctor checks that skip.** Several fixes make a check skip where it cannot compare (bugs 8,
  10, 11). Each is a place the doctor now says less; a check that compares the stored records
  themselves (not the prefix hash) would say more.
- **The rebuild key** now names the piece's end; a server that wants to deduplicate a retried
  rebuild of the same piece still does, but one retried across a growth rebuilds twice (once
  per length), which the review budget pays for.
- **Phase 2** (real processes, on its own branch) can run the same generator over its process
  world once its runner takes the same scenarios.
