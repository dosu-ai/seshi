# 34 · Capture scenarios with real processes (phase 2)

Branch `seshi-34-scenario-proc`, on `seshi-32-scenarios` (0d22120). Phase 1 (32) runs scenarios
in one process: it moves the clock and wraps `fetch` and the store, so it cannot reach what
happens between processes: an uploader SIGKILLed halfway through a chunk, a server killed with a
request inside it, the uploader lock contested and taken over, the spool and state written by
separate processes, a TCP connection torn mid-request, two uploaders at once, a hook or
`capture off` landing while a pass is sending. Phase 2 runs the same YAML format against real
processes on this machine, with a TCP fault proxy on the wire. The format reference is the
"Process mode" section of [tests/scenarios/README.md](../../../tests/scenarios/README.md#process-mode).

## Design

- **Layout.** The runner is `tests/tooling/scenario-proc/` (`schema.ts` the format, `world.ts`
  the processes and folders, `proxy.ts` the fault proxy, `procs.ts` the process registry,
  `runner.ts` the steps and checks, `main.ts` the command, `scenario-proc.test.ts` its own unit
  tests). The scenarios are `tests/scenarios-proc/*.yaml`, apart from `tests/scenarios/`
  because `scenarios.test.ts` runs every `*.yaml` there in-process. Nothing of phase 1 was
  edited: the process format imports its validator and transcript writer.
- **The format.** `setup: { mode: process }`. A step that means the same out of process (`turns`,
  `subagent`, `compact`, `move-transcript`, `hook`, `pass`, `capture`, `restart-server`, `heal`,
  `expect`, `settle`) is checked by the in-process validator itself, so it takes the same fields
  and fails with the same message, renumbered to the file's step. Refused before anything runs,
  with the reason: `clock` (no time travel; production code gets no test hooks), `review` (the
  fake reviewer is in-process), `rules`, `format-bump`, `sweep`, `backfill`, store faults,
  `latency`, `expect: reviewed`, `pass: { sweep: false }`. Added: `fault` (proxy rules),
  `background`, `join`, `await`, `daemon`, `stop`, `kill`, `wait`, and `expect` gains
  `requests`, `started`, `runs` and `uploader-lock`.
- **The world** (`world.ts`), per scenario: a temporary folder with a throwaway home (agent
  folders, XDG folders), a `file://` bucket and the server's TOML; `seshi admin init`, then
  `seshi serve` on a free port, then the proxy on another, then `seshi login --key -` through the
  proxy as `alice@acme.com`. Every child gets an environment built from scratch (PATH, TMPDIR,
  HOME, the XDG folders, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GIT_CONFIG_GLOBAL`,
  `SESHI_KEYCHAIN=false`, `SESHI_NO_UPLOADER=1`, `NO_COLOR=1`): no `SESHI_*` the developer has
  set reaches it, and seshi refuses unknown ones anyway. seshi runs from source (`bun run
  apps/seshi/src/main.ts`), or the binary `SCENARIO_SESHI_BIN` names. Hooks never start an
  uploader, so every `seshi daemon` is one the scenario started and knows the pid of.
- **Processes** (`procs.ts`). Every child is spawned in a process group of its own
  (`Bun.spawn({ detached: true })`, pid = group id) and killed by that id, never by name: a kill
  reaches what the child started (a `git` the uploader ran). `runProcessScenario` stops the
  proxy and kills every group in a `finally`, pass or fail, then lists every process left in any
  of its groups (`ps -A -o pid=,pgid=,command=`, the same on macOS and Linux); one left fails the
  run.
- **Checks.** As in-process, read from disk: after every step the laptop's offsets never pass
  the transcript, nothing past a frozen offset is stored (the stop moves only after a proxy rule
  fired), no planted secret in the bucket, `checkStore` finds no errors (only while nothing runs
  in the background: a check mid-write proves nothing). Once quiet: `seshi doctor --json --since
  3650d` fails no check, `checkStore` is clean but for allowed warnings, the server matches each
  session's capture decision, no proxy rule is left armed. Besides, a server that exits by itself
  and a kill rule with no single uploader to kill fail the step.
- **Time is real.** `settle` joins background runs, stops long-running daemons (SIGTERM), then
  makes passes; when only retries are left it sleeps until the next one (backoff 5 s, doubling),
  refusing to wait more than 70 s. Scenarios that need several failures put them on separate
  sessions in one pass (04), so one 5 s backoff covers them.

## The proxy

`Bun.listen` on 127.0.0.1; each client connection gets its own `Bun.connect` to the server. The
request head is read for the method, path and body length (Content-Length or chunked framing);
`Connection: close` replaces any connection header on the request and on the answer, whose
framing is read too, so each connection carries one request and the client never reuses one
the proxy closed. Writes keep backpressure (what a socket does not take waits for its drain).
A rule matches by method and path (`*` globs) and counts matching requests from when it is
armed: it fires on the `nth`, for `times` (or `always` until `heal`), as phase 1's faults do.

| Rule | What happens on the wire |
|---|---|
| `delay: D` | the request is held D, then forwarded |
| `close-request: N` | the head and N body bytes reach the server, then both sides close |
| `reset: true` | closed before anything reaches the server |
| `close-response: N` | the whole request goes; N bytes of the answer come back, then a close |
| `status: S` (`code`, `expected`) | the proxy answers once the body arrived; the server sees nothing |
| `drop-response: true` | the server answers in full (committed); the client gets a close |
| `kill-client: N \| all` | after N body bytes have reached the server (30 ms for it to read them), the one running uploader's group is SIGKILLed and the server's side closed: a torn request. With `all` the whole request goes, and the answer is read and dropped |
| `kill-server: N \| all` | after N body bytes, `seshi serve` is SIGKILLed at once; any answer it sent first is dropped. `restart-server` starts it again on the same port over the same bucket |

Every request is recorded (method, path, status, the rule, what became of it); `--trace` prints
them, and a failure shows the last twelve.

## Races

| Step | Use |
|---|---|
| `background: { as, step }` | start a `pass`, `turns`, `hook`, `subagent` or `capture` and go on; `join` waits and fails with it |
| `await: { request }` | wait until the proxy saw that request since the last background run or daemon started: "the pass is now sending" |
| `daemon: { as, idle, keep-alive }` | a long-running `seshi daemon` (`--keep-alive`: a service entry, which waits for the lock) |
| `stop` / `kill` | SIGTERM and wait, or SIGKILL (which leaves `uploader.json` behind) |
| `expect: started` / `runs` / `uploader-lock` | how many of the named passes took the lock; what a run did; whether `uploader.json` is absent, live or stale |

The four races asked for, as built: two `daemon --once` at the same moment (05, and 07 after a
takeover), with a 1.5 s `delay` so the winner is still sending when the loser looks; a hook
spooling during a pass (08: `background` pass, `await` its request, `turns` with their Stop
hooks); `capture off --session` while that session's chunk is held at the proxy (06); a stale
lock left by a killed uploader (01, 02, 09 by `kill-client`; 07 by `kill` of a long-running
daemon) taken over by the next.

## Scenarios

| File | Guards | Passes |
|---|---|---|
| 01-uploader-killed-mid-chunk | X6.3 × F9.1: the uploader SIGKILLed after 300 of 966 body bytes; the server stores nothing of the chunk, the lock is stale, the next uploader takes over and sends it once (`matches-transcript`, 3 uploads in all) | yes |
| 02-uploader-killed-after-commit | X4.7 × X6.3: SIGKILLed after the whole first upload, then the whole chunk; the server committed both; each resend is answered from the applied envelope, one trace per piece, no record twice | yes |
| 03-server-killed-mid-request | F9.1 × X6.3: `seshi serve` SIGKILLed with a chunk's head in it (passes fail and back off, `will retry`), restarted, the chunk goes once; then killed with a whole chunk in it, restarted, converges whatever the kill interrupted | yes |
| 04-torn-connections | X4.7 × X6.3 over TCP: a reset, a request closed after 200 body bytes, a committed upload whose answer is dropped (three sessions, one pass), then a chunk's answer cut after 40 bytes; torn requests never commit, lost answers resend idempotently | yes |
| 05-two-uploaders-at-once | F9.1: two `daemon --once` together, twice; one takes the lock each time and the proxy sees one upload per piece | yes |
| 06-capture-off-during-send | F9.5 × F9.7: `capture off --session` while the chunk is held at the proxy; the held chunk lands, the uploader's state write keeps the toggle and the pending retraction, nothing written after the toggle is sent, the next pass retracts | yes |
| 07-stale-lock-takeover | F9.1: a long-running daemon holds the lock (a `--once` beside it exits at once), is SIGKILLed, and of two uploaders started together exactly one takes the stale lock over | yes (with the fix below) |
| 08-hook-during-pass | F9.1: hooks spool a known session's turns and a new session while a pass is mid-send; the next pass takes both in, nothing lost or twice | yes |
| 09-retraction-lost-answer | F9.7: the server tombstones but the answer is dropped; the retry's whole DELETE goes and the uploader is SIGKILLed; the next uploader is told 410 and records it done | yes |

`tests/scenarios-proc/cleanup/fails-midway.yaml` is the cleanup proof, run after the set: it
fails an expectation while `seshi serve`, a pass whose upload the proxy holds for 30 s and a
`--keep-alive` daemon waiting for that pass's lock are all running. The command checks those
three were running when it failed and that none of their pids, nor any process in their groups,
is alive afterwards:

```
  running when it failed, all gone since: serve (pid 11294), daemon --once (held) (pid 11297), daemon (long) (pid 11300)
✓ cleanup proof: a failing scenario left no process behind (1.3 s)
```

`scenario-proc.test.ts` (in `bun run test`, about 1 s) checks the format's refusals, that every
file in `tests/scenarios-proc` parses, each proxy rule against a small `Bun.serve` upstream, and
that the registry kills a child's whole group.

## A real bug, found and fixed

**Two uploaders could both take over a stale uploader lock** (commit `fix(capture): let one
uploader at a time take over a stale lock`). `acquireUploaderLock` creates `uploader.json`
exclusively; when it exists and its holder is gone, it judged the lock stale, wrote its own over
it and read it back. Two uploaders started together (two hooks after a crash, a hook and the
service entry) could both judge the old lock stale, and if one wrote and read back before the
other wrote, both held it: two passes ran at once, against F9.1. Found while writing 07's
two-takers step; a probe that starts two processes on a stale lock at the same millisecond
showed both taking it in 2 of 60 rounds. The fix takes a stale lock over under a guard file
(`uploader.json.takeover`, created exclusively): the lock is judged again under it and replaced
only if still stale; a taker that finds the guard held gives way, and a guard older than 10 s
(its taker died mid-takeover) is removed for the next one. After the fix, 0 of 150 rounds, each
with exactly one holder. Unit test in `state.test.ts` (it fails on the old code: the second taker
got a lock); `docs/capture.md`'s file table names the guard. Scenario 07 hits the window only by
chance (its two uploaders start a millisecond or two apart), so it guards the fix rather than
reliably reproducing the old bug.

## Proofs that the scenarios catch what they should

Each break was made in the working tree, never committed, the scenarios run, and the code
restored.

1. **The uploader ignores its lock.** `apps/seshi/src/commands/daemon.ts`: `--once` runs its pass
   whether or not it took the lock (`if (!lock && !keepAlive && !values.once)`, `if
   (values.once)`). 05 and 07 fail:
   ```
   05 step 6 (expect …): expectation not met
     requests: POST /v1/sessions: expected 1, got 2
     started: 2 of first-a, first-b took the uploader lock, not 1
   07 step 7 (expect …): expectation not met
     runs.beside: started: expected false, got true
   ```
2. **The server skips its idempotency check.** `packages/ts/pipeline/src/pipeline.ts` `planned`:
   the answer from `session.applied` for a known idempotency key never given. A resend of a
   committed chunk then meets the offset check (409 `offset_mismatch`), the uploader moves its
   offsets but keeps the stale `shipped`, and the doctor catches it once quiet. 02 and 04 fail:
   ```
   02 step 13 (settle max=40): once quiet, seshi doctor fails a check
     main: offsets: the last answer said 11 records (90261017b9fd), the server now holds 26 (00a345d8ab79)
   04 step 15 (settle max=40): once quiet, seshi doctor fails a check
     a: offsets: the last answer said 16 records (1d82227087cf), the server now holds 26 (df35c83bd704)
   ```
3. **The uploader's write after an answer clobbers a toggle set meanwhile.**
   `packages/ts/capture/src/uploader.ts` `sync`: the success `save` puts back `toggle`,
   `toggled_at` and `retract` as the pass read them before the request. 06 fails:
   ```
   step 10 (expect …): expectation not met
     main: toggle: expected "off", got "none"
     main: retract: expected "pending", got "none"
   ```

## Runtime

`bun run scenarios:process` takes about 50 s on this machine (Apple silicon): 51.7 s, 50.6 s and
50.3 s in three runs back to back, all passing. 03 (12 s) and 04 (12 s)
spend most of it in backoff sleeps, 09 (7.5 s) in one; the race scenarios take 3–4 s; 01 and
02 about 1.3 s. A scenario starts 10–23 processes. The CI job is `scenarios-process` in
`.github/workflows/ci.yml`: Linux, on `schedule` (03:17 UTC) and `workflow_dispatch`, read-only
token, `persist-credentials: false`, actions pinned as the rest of the file; the scheduled run
skips the other jobs (`if: github.event_name != 'schedule'` on the five that start the graph).

## Deviations and why

1. **Scenarios in `tests/scenarios-proc/`**, not `tests/scenarios/`: the in-process test runs
   every `*.yaml` there, and phase 3 works in that folder.
2. **`clock` is refused**, not emulated: moving time for real processes needs a hook in
   production code. Backoff waits are real; `wait` sleeps (at most 60 s).
3. **`kill-client` kills "the one running uploader"**, the daemon processes the scenario
   started; with more than one running it kills them all and fails the step.
4. **Count by body bytes**, not request bytes: the head's size varies with the token and user
   agent; N body bytes is the same point of the same chunk on every run (the body is gzipped
   JSON past 8 KiB, so it is not a transcript offset).
5. **No `repeat` step** for the takeover race: a probe outside the runner measured it instead.

## Still to check

- The takeover race reproduced reliably by a scenario (many rounds, or three or more takers),
  rather than by a probe.
- A 409 `offset_mismatch` whose recovery leaves nothing more to send keeps the laptop's
  `shipped` from the last answer (proof 2 shows the doctor flags it); with the idempotency check
  in place a resend of the same bytes never gets there, but a resend whose bytes differ (rules
  fetched anew between the commit and the resend) might. Not reproduced; worth a scenario once
  process mode can change the server's rules.
- The server's worker (the daily sweep against a publish reusing an object), Codex and Cursor
  sessions, a long-running daemon taken over mid-pass by a newer one (`beat` failing), kills
  during `state.json` writes (the state lock's 10 s staleness), and the S3 store behind the
  server.
- Windows: process groups and `ps` are POSIX; the runner is Linux and macOS only.
