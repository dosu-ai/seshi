# Capture scenarios

A scenario is a YAML file here that strings together agent activity, uploader passes, capture
controls, clock moves and injected faults, and says what must hold. The runner checks a set of
invariants after every step and the doctor's and the bucket checker's verdicts once the system
is quiet. No real agent or model runs: transcripts are synthetic Claude Code turns and review
is a fake reviewer, so a scenario costs no tokens and runs in well under a second.

```sh
bun --bun vitest run tests/scenarios           # every scenario (part of bun run test)
bun --bun vitest run tests/scenarios -t 07     # the ones whose file name or title has "07"
```

Each `*.yaml` file here and in `found/` is one test in `scenarios.test.ts`. The runner is
`tests/tooling/scenario/` (`schema.ts` the format, `runner.ts` the steps and checks, `world.ts`
the in-process world, `faults.ts` the fault wrappers, `clock.ts` the clock, `transcript.ts` the
turns; `generate.ts` and `explore.ts` the generated scenarios, [below](#generated-scenarios)).
Build notes: `docs/seshi/build/32-scenarios.md`, `docs/seshi/build/33-scenario-gen.md`.

## The world

Everything runs in the test process:

- **The server**: a seshi Instance built by `buildInstance` (the boot path `seshi serve` runs)
  over a temporary folder bucket, served on 127.0.0.1. `restart-server` builds a new Instance
  over the same bucket behind the same address.
- **The machine**: a temporary home folder running real `seshi` commands through `main`: hooks,
  `seshi capture …`, `seshi doctor`, `seshi login` (with the org key, as `alice@acme.com`).
  In local mode the CLI config points at the same bucket and the owner is `me`.
- **The uploader**: the production `Uploader` with the production pre-redactor and HTTP sink,
  built fresh for each `pass` like `seshi daemon --once`. Only its `fetch` is wrapped (HTTP
  faults), its clock and `random` injected, and its git identity fixed.
- **Sessions**: a scenario names them (`main`, `a`), and the name is the session id. A session
  lives in a folder under the home (`code/app` unless a step says `in:`); its transcript is
  `~/.claude/projects/<folder>/<id>.jsonl`. A subagent `id: helper` is session `agent-helper`,
  in `<parent>/subagents/`. After a retraction and `capture on`, the upload id is `main~1`.
- **One clock**: the scenario clock starts at 2026-09-01T09:00Z, runs with real time and jumps
  with `clock`. The uploader, the Instance, auth, the sweep, `checkStore` and every `new Date()`
  in the process (the CLI's capture commands, hook spool entries) read it; object ages in the
  bucket and transcript times follow it too.
- **Turns**: one turn is four lines (a prompt, a reply with a tool call, the tool result, a
  closing reply), about 1,300 characters. One turn is too small for the server's session filter
  (about 2,000 characters); two pass it.

## Format

```yaml
name: a short title                 # required
description: >                      # required: what happens, in a few sentences
  …
guards: "21 × 24: what it guards"   # optional: the bug or decision, shown in docs and reports
setup:                              # optional; every field has a default
  mode: server                      # server (default) | local
  review: true                      # the fake reviewer on every envelope; or { on_failure: drop | skip }
  rules:                            # org redaction rules at the start, beside the built-in pack
    - { id: acme-key, pattern: "ACME-\\d{4}" }
  repos:                            # folders made git repos, with .seshi/config.toml content
    code/secret: { config: "capture = false\n" }
    code/app: {}                    # a repo with no config
  server: |                         # extra server config (TOML), top-level keys first
    default_visibility = "owner"
  allow: [orphan_trace]             # checkStore warnings allowed once quiet
  seed: 1                           # the uploader's random (where a stale rebuild lands in its day)
steps:
  - turns: { session: main, count: 2 }
  - pass
  - …
```

A step is one word (`- pass`) or one key with its fields (`- turns: { … }`). An unknown step,
an unknown field or a bad value fails the test before anything runs, naming the file and the
step: `tests/scenarios/x.yaml: step 4 (turns): unknown field 'cout'`.

### Agent activity

| Step | Fields (default) | What it does |
|---|---|---|
| `turns` | `session`, `count` (1), `secret` (false), `mark`, `in`, `hook` (Stop) | Appends `count` turns to the session's transcript (creating it), then runs `seshi hook claude-code <hook>`. `secret: true` plants the fake credentials (an AWS key, a password, a GitHub token) in the first new turn. `mark: word` puts `[word]` in every new prompt, for `bucket`/`reviewed` checks. `in: code/x` runs the turns in that folder (the transcript stays where it is). `hook: none` writes without a hook (the uploader's sweep finds it). |
| `subagent` | `parent`, `id`, `turns` (2), `secret`, `mark`, `in`, `hook` (true) | Appends turns to `agent-<id>`'s transcript under the parent's, then runs the `SubagentStop` hook naming it. Runs in the parent's folder unless `in` says. |
| `compact` | `session`, `mode` (append), `keep` (1), `hook` (Stop) | `append`: a compaction summary appended, as Claude Code writes it. `shrink`: the transcript rewritten as its first `keep` turns plus a summary, shorter than what was uploaded. |
| `move-transcript` | `session`, `to` (code/moved), `hook` (Stop) | Moves the transcript to the project folder of `to` and runs the session there. A moved transcript goes whole, but only once it has new bytes: follow it with `turns`. |
| `hook` | `session`, `event` (Stop), `in` | Runs one hook: `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`. |

### The uploader and capture controls

| Step | Fields | What it does |
|---|---|---|
| `pass` | `sweep` (true) | One uploader pass (spool, sweep, retractions, uploads, the stale check), as `seshi daemon --once`. Its summary is what `expect: { pass }` reads. A pass that needs a sign-in fails the scenario. |
| `capture` | a string, or `{ args, code }` | Runs `seshi capture <args>` (`off --session main`, `on --session main`, `pause 2h`, `resume`, `resend --session main`, `off --path code/x`) and expects exit `code` (0). |

### Time and the server

| Step | Fields | What it does |
|---|---|---|
| `clock` | a duration: `+2h`, `30m`, `1d` | Moves every clock forward. Backoff, `not_before`, the hourly stale check, pauses and object ages all follow. |
| `restart-server` | | A new Instance over the same bucket. |
| `rules` | `add: [{ id, pattern }]`, or `set: [...]` | Changes the org's redaction rules (and restarts). Whole uploads of stored sessions then conflict and replace; what is not sent again needs a `backfill`. |
| `format-bump` | a format, `claude-code` | Raises the format's normalizer version (and restarts): every stored session of it becomes stale (X4.9). |
| `backfill` | | The redaction backfill (`seshi redact backfill`) with the current rules, its sweep included. |
| `sweep` | | The orphan sweep (the worker's daily `sweep` job). |

### Review

| Step | Fields | What it does |
|---|---|---|
| `review` | a list of `allow`, `redact`, `drop`, `fail` | Queues the fake reviewer's next decisions, one per envelope reviewed; `allow` once the queue is empty. `redact` finds the scenario's marks; `fail` is a provider error, after which the policy's `on_failure` applies. Needs `setup: { review: true }`. |

### Faults

A fault counts what matches it from the moment the step runs, fires on the `nth` match (1)
and keeps firing for `times` matches (1, or `always` until a `heal`).

| Step | Fields | What it does |
|---|---|---|
| `fault` (HTTP) | `http: "<METHOD> <path>"`, `nth`, `times`, and one of: `status` (with `code`, `expected` for a 409), `drop-response: true`, `reset: true`, `latency: 2s` | On the uploader's requests only, server mode only. `status` answers instead of the server (`409` needs `code: offset_mismatch` or `conflict`). `drop-response` lets the server commit and gives the uploader a connection error. `reset` fails before the server sees it. `latency` moves the clock while the request is out. `*` in the path globs (`DELETE /v1/sessions/*`). |
| `fault` (store) | `store: put \| delete`, `key` (a glob), `nth`, `times`, `error` (fail \| precondition), `after` (false) | Fails a bucket write or delete with a store error or `PreconditionFailed`, before it lands, or after it (`after: true`, a lost answer). `*` in the key matches anything, `/` included: `owners/*/sessions/*/metadata.json`, `owners/*/changes/*`, `owners/*/sessions/*/trace.*`. |
| `heal` | | Removes every fault. |

### Checks

`expect` takes any of:

```yaml
- expect:
    pass: { uploaded: 1, failed: 0 }    # the last pass's summary: taken, found, uploaded,
                                        # retracted, failed, queued, retrying, signIn
    sessions:
      main:                             # a session name, or an upload id (main~1) for server facts
        server: present                 # present | absent | stub | redacted (the stored pointer)
        records: 11                     # normalized.records
        traces: 2                       # traces listed
        visibility: owner
        matches-transcript: true        # stored records = what the transcript makes up to the
                                        #   laptop's offset (none lost, none twice)
        sent-all: true                  # the laptop's offset is the transcript's size
        frozen: true                    # stopped by a pause
        toggle: off                     # on | off | none
        rebuild: waiting                # none | waiting (for not_before) | due
        last-status: dropped            # the laptop's last answer
        retract: done                   # pending | done | failed | none
        id: main~1                      # the upload id the laptop uses now
        doctor: ok                      # or the ids of the checks that must fail: [prefix]
    bucket:
      has: [kept-part]                  # some object (trace objects unzipped) holds it
      lacks: [dropped-part]             # no object does
    reviewed:
      - { text: dropped-part, times: 1 }  # decision calls whose input held the text
    store-check: { warn: [change_orphan] }  # checkStore warns these now
    log: ["will retry"]                 # lines of the capture log
```

`settle` (`{ allow: [codes], max: 40 }`) runs passes, moving the clock to the next retry or
rebuild time when nothing else is left, until a pass does nothing and nothing waits; then it
fails if any fault is still armed, and runs the quiet checks. A scenario that does not end with
`settle` gets one at the end.

## What is checked

After every step:

1. The laptop's `file_offset` never runs past the transcript's size (after a `shrink`, from the
   next pass).
2. Nothing past a frozen offset is stored: the server holds no more records than the transcript
   makes up to the stop (or than it held when the pause landed), and a stop only moves forward
   after an answer was lost.
3. No planted credential is anywhere in the bucket, gzipped trace objects included, nor in
   anything sent to review.
4. `checkStore` finds no errors. Warnings are allowed mid-scenario, and so is
   `redacted_trace_object` for a session whose retraction this machine is still retrying (a
   tombstone that landed but answered as failed leaves its traces until the retry removes them).

Once quiet (at `settle` and at the end):

1. `seshi doctor` fails no check for any session the laptop knows.
2. `checkStore` finds no errors, and no warnings but `setup.allow` and `settle.allow`. Once a
   store fault fired on a change entry or a session pointer, `change_orphan` and
   `change_not_applied` are allowed too: the entry of a failed write stays for good, by design
   (19, X6.4 decision 7). Once any store fault fired, `orphan_trace` is allowed (the orphan
   sweep removes it, F2.5), and once a trace object's write failed, `stub_trace_object` (the
   same leftover in a session that became a stub).
3. The server matches each session's capture decision: a session turned off is tombstoned or
   absent (its earlier generation tombstoned), one stored from here is stored, one never stored
   from here is not (unless a pause stopped it after it sent a piece whose answer was lost: the
   server holds that piece, and check 2 above bounds it).

## Writing one

- Start from a bug or a decision and write its name in the header comment and `guards`.
- Drive the paths together: a pause and a rebuild, a stub and a replace, a fault and a resend.
  Expect the outcome, not the mechanism: `matches-transcript`, `bucket.lacks`, `server`.
- Two turns pass the session filter; one does not (`last-status: filtered`).
- Move the clock past backoff (`+1m` covers the first retries) and past the stale check's hour
  (`+2h`); a stale rebuild waits up to a day (`+1d`).
- End an `always` fault with `heal`, or `settle` fails.
- After `rules`, sessions not sent again keep what the old rules stored, and the doctor fails
  `residue` on them: add a `backfill`.
- When a scenario fails, the message names the step and carries the evidence: the findings, the
  faults that fired and the capture log's last lines.

## Generated scenarios

The hand-written scenarios cover the combinations someone thought of. The generator
(`tests/tooling/scenario/generate.ts`) writes the others: from a seed, a random step list of up
to 25 steps from the same vocabulary, weighted toward turns, passes and faults, across one to
three sessions and their subagents, in server mode mostly and local mode about one time in
seven, with review on about two times in five. It only writes valid scenarios: a step that
needs a session comes after the session's first turns, HTTP faults only in server mode,
`review` only with review on, `heal` before a `backfill` or `sweep` while a store fault is
armed, a `backfill` after a rule change and before any `settle`, a `shrink` compaction only
where it really shortens the transcript and settled at once (build note 32: an in-place rewrite
that leaves the transcript longer is not detected, by design), no injected `409 conflict` and no
`PreconditionFailed` a store would never give, and every scenario ends with
`heal` (when a fault is armed) and `settle`, so the quiet checks run. The scenario passes the
same validator a hand-written one does. The weights and every precondition are in the build
note.

```sh
bun run scenarios:explore                          # 200 runs from a random seed (printed)
bun run scenarios:explore --runs 5000 --seed 1     # longer, from a fixed seed
bun run scenarios:explore --seed 60224 --runs 1    # one seed again, as a found file says
bun run scenarios:explore --max-steps 40 --shrink-runs 500
```

Each run is one seed. When its scenario fails (an invariant breaks, a quiet check fails, or
anything throws), fast-check shrinks it: fewer steps and plainer ones, as long as it still fails
the same way (the same headline, and its first finding still among the findings), up to
`--shrink-runs` scenario runs (300). The minimal scenario is written to
`tests/scenarios/found/<seed>-<hash>.yaml`. The summary lists the runs, steps, passes and faults,
each failure and its file, grouped by kind, and the command exits 1 when anything failed. The
same seed and `--max-steps` always generate, and shrink to, the same scenario, with the generator
as it is: when the generator changes, an old seed makes another scenario, and the found file's
YAML is what counts.

`bun run test` runs a small fixed budget of the same (`generated.test.ts`: 40 seeds of up to 25
steps, about 3 s); a failure there writes its found file too and names it. CONTRIBUTING.md
suggests a nightly `scenarios:explore` with fresh seeds.

### Reading a found file

```yaml
# Found by the scenario explorer (tests/tooling/scenario/explore.ts); see tests/scenarios/README.md.
# seed: 1169 (bun run scenarios:explore --seed 1169 --runs 1 --max-steps 25)
# original length: 18 steps; shrunk to 7 in 50 runs
# failure:
#   step 7 (settle max=40): once quiet, seshi doctor fails a check
#     main: queue: refused (conflict): the upload does not extend the stored session …
#     faults fired:
#       store put owners/me/sessions/…/metadata.json: … → fail after the write
name: found by seed 1169
description: "A generated scenario (seed 1169) shrunk from 18 to 7 steps; …"
setup: { mode: local }
steps:
  - turns: { session: main, count: 2 }
  - fault: { store: put, key: "owners/*/sessions/*/metadata.json", after: true }
  - pass
  - compact: { session: main, mode: shrink, keep: 1 }
  …
```

The header holds the seed (and the command that generates it again), how long the scenario
was before shrinking, and the failure as the runner reported it on the minimal scenario (the
run's temporary folders written `<home>` and `<world>`, its server `<server>`). The
body is an ordinary scenario: run it with `bun --bun vitest run tests/scenarios -t <seed>`.
Shrinking keeps steps the failure does not need when removing them changes what the generator
makes (a `heal` belongs to the fault it heals), so read it with the failure in mind.

### What to do with one

Decide what it is: a seshi bug, a runner or generator bug, or an invariant stated more strictly
than the design (the build note lists every one found so far and why). Then:

- **A seshi bug**: fix it with a unit test, and keep the scenario as a regression. Either leave
  it in `found/` (it runs as a test there), or promote it: rename it to the next number here
  (`22-what-it-guards.yaml`), give it a real `name`, `description`, `guards` and header comment
  saying what it guards and which seed found it, and add `expect` steps for the outcome, the
  way the hand-written ones do.
- **A runner or generator bug**: fix it; keep the file only if it now passes and guards the fix.
- **An invariant too strict**: adjust it in `runner.ts` with the reason (the decision or build
  note) beside it, and here under [What is checked](#what-is-checked).

`found/` only ever holds scenarios that pass: a failing one is never committed.

## A full example

```yaml
# Guards 21 × 24: a rebuild of a session a pause stopped is sent only up to where it stopped.
name: pause, then a stale rebuild
description: >
  A session is uploaded and paused, keeps growing, then a format bump makes it stale. The
  rebuild waits its turn, goes whole, and stops at the frozen offset.
guards: "21 × 24: a stale rebuild stops at the frozen offset"
steps:
  - turns: { session: main, count: 2 }
  - pass
  - capture: pause 2h
  - turns: { session: main, count: 2, mark: written-while-paused }
  - pass
  - expect:
      pass: { uploaded: 0 }
      sessions:
        main: { frozen: true, records: 11 }
  - format-bump: claude-code
  - clock: +3h
  - pass                                  # the stale check marks it, to wait within the day
  - expect:
      sessions:
        main: { rebuild: waiting }
  - clock: +1d
  - pass                                  # the rebuild goes, cut at the stop
  - expect:
      pass: { uploaded: 1 }
      sessions:
        main: { rebuild: none, records: 11, traces: 1 }
      bucket:
        lacks: [written-while-paused]
  - settle
```

With the stop ignored by the rebuild, this fails at the pass that sends it:

```
tests/scenarios/01-pause-then-stale-rebuild.yaml: step 14 (pass sweep=true): an invariant broke
  claude-code:main: the pause stopped it at 3970 bytes; the stop moved to 9997 with no lost answer
  claude-code:main: stopped at 3970 bytes (11 records), yet the server holds 26 records
```

## Process mode

The runner above lives in one process: it moves the clock and wraps `fetch` and the store, but
it cannot kill an uploader halfway through a chunk, tear a TCP connection, or run two uploaders
at once. Process mode runs the same format with real processes, isolated the way the
verify-seshi skill isolates a run:

```sh
bun run scenarios:process                       # every tests/scenarios-proc/*.yaml, then the cleanup proof
bun run scenarios:process tests/scenarios-proc/05-two-uploaders-at-once.yaml --trace
SCENARIO_SESHI_BIN=dist/seshi bun run scenarios:process   # the compiled binary instead of the source
```

It is not part of `bun run test` (the set takes about a minute and needs free ports); CI runs it
nightly. `--keep` keeps a failing scenario's folder (server logs, bucket, state); `--trace`
prints every request the proxy saw and what became of it. The files live in
`tests/scenarios-proc/` (not here: every `*.yaml` here is an in-process test), the runner in
`tests/tooling/scenario-proc/`. Build note: `docs/seshi/build/34-scenario-proc.md`.

**The world.** Each scenario gets a temporary folder with a throwaway home (agent folders, XDG
folders, the capture state), a `file://` bucket and its own ports. `seshi serve` runs as a
process (from source, `bun run apps/seshi/src/main.ts`), behind a TCP fault proxy; the machine
logs in through the proxy with the org key as `alice@acme.com` (`SESHI_KEYCHAIN=false`). Hooks
are real `seshi hook claude-code …` processes with the payload on stdin; `SESHI_NO_UPLOADER=1`
keeps them from starting uploaders, so every `seshi daemon` is one the scenario started. Every
process gets its own process group and is killed by its id in a `finally`, pass or fail; a
process left over fails the run. Time is real: there is no clock to move.

**The format.** `setup: { mode: process }` (with `repos`, `allow` and `server` as above). These
steps mean what they mean in-process: `turns`, `subagent`, `compact`, `move-transcript`, `hook`,
`pass` (`seshi daemon --once --json`), `capture`, `restart-server` (a new `seshi serve` on the
same port), `heal`, `expect`, `settle`. Refused before anything runs, with the reason: `clock`
(production code gets no test hooks; use `wait`), `review`, `rules`, `format-bump`, `sweep`,
`backfill`, store faults, `latency`, `expect: reviewed`, `pass: { sweep: false }`.

| Step | Fields | What it does |
|---|---|---|
| `fault` | `http: "<METHOD> <path>"`, `nth`, `times`, one action (below) | Arms a proxy rule. It counts the requests that match from now, fires on the `nth`, for `times` (1, or `always` until `heal`). |
| `background` | `as`, `step` (a `pass`, `turns`, `hook`, `subagent` or `capture`) | Starts the step and goes on without waiting. |
| `join` | a name or a list | Waits for background runs; a run that failed fails here. |
| `await` | `request: "<METHOD> <path>"`, `nth` (1), `timeout` (20s) | Waits until the proxy has seen that request since the last `background` or `daemon` started. |
| `daemon` | `as`, `idle`, `keep-alive` | Starts a long-running `seshi daemon` (`--keep-alive`: waits for the lock instead of exiting). |
| `stop` / `kill` | a run's name | SIGTERM (and wait) or SIGKILL its process. |
| `wait` | a duration (at most 60s) | Real time passes. |

Proxy actions (`kill-client` and `kill-server` take a byte count or `all`):

| Action | What happens |
|---|---|
| `delay: 2s` | The request is held, then forwarded. |
| `close-request: N` | The head and N body bytes reach the server, then both sides close: a torn request. |
| `reset: true` | The connection closes before anything reaches the server. |
| `close-response: N` | The server answers; the client gets N bytes of it, then a close. |
| `status: 503` (`code`, `expected`) | The proxy answers; the server sees nothing. |
| `drop-response: true` | The server answers in full (it committed); the client gets a close. |
| `kill-client: N` | After N body bytes reach the server, the one running uploader is SIGKILLed; the server sees a torn request. With `all`, the whole request goes and the answer is never read. |
| `kill-server: N` | After N body bytes, `seshi serve` is SIGKILLed with the request inside it. Bring it back with `restart-server`. |

`expect` also takes `requests: { "POST /v1/sessions": 2 }` (requests the proxy saw over the run),
`started: { of: [a, b], count: 1 }` (how many of those passes took the uploader lock),
`runs: { a: { started, killed, code, pass: { uploaded: 1 } } }` and
`uploader-lock: absent | live | stale` (`uploader.json`, and whether its pid lives). `pass`
reads the last foreground pass; a pass a kill rule ended has no summary.

**What is checked** is what the in-process runner checks, read from disk (the state file, the
bucket) and from `seshi doctor --json`; `checkStore` runs between steps only while nothing runs
in the background. `settle` joins background runs, stops long-running daemons, then makes passes,
sleeping until the next retry when only retries are left (backoff starts at 5 s and doubles; it
refuses to wait more than 70 s), and runs the quiet checks.

```yaml
# Guards F9.1: two uploaders started together; the lock lets one send.
name: two uploaders at once send each byte once
description: >
  A session has something to send; two uploaders start together while the proxy holds the
  upload 1.5 s. Exactly one takes the lock, and the server sees one upload.
setup: { mode: process }
steps:
  - turns: { session: main, count: 2 }
  - fault: { http: POST /v1/sessions, delay: 1500ms }
  - background: { as: a, step: pass }
  - background: { as: b, step: pass }
  - join: [a, b]
  - expect:
      started: { of: [a, b], count: 1 }
      requests: { "POST /v1/sessions": 1 }
      sessions:
        main: { traces: 1, matches-transcript: true }
  - settle
```

With `seshi daemon --once` made to ignore the lock, this fails:

```
tests/scenarios-proc/05-two-uploaders-at-once.yaml: step 6 (expect …): expectation not met
  requests: POST /v1/sessions: expected 1, got 2
  started: 2 of first-a, first-b took the uploader lock, not 1
```
