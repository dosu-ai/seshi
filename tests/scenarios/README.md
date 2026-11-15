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

Each `*.yaml` file is one test in `scenarios.test.ts`. The runner is `tests/tooling/scenario/`
(`schema.ts` the format, `runner.ts` the steps and checks, `world.ts` the in-process world,
`faults.ts` the fault wrappers, `clock.ts` the clock, `transcript.ts` the turns). Build note:
`docs/seshi/build/32-scenarios.md`.

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
4. `checkStore` finds no errors. Warnings are allowed mid-scenario.

Once quiet (at `settle` and at the end):

1. `seshi doctor` fails no check for any session the laptop knows.
2. `checkStore` finds no errors, and no warnings but `setup.allow` and `settle.allow`.
3. The server matches each session's capture decision: a session turned off is tombstoned or
   absent (its earlier generation tombstoned), one stored from here is stored, one never stored
   from here is not.

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
