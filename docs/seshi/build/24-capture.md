# 24 · Capture: pause, the uploader during outages, Windows CI (decisions 1, 9, 10)

Branch `seshi-24-capture`, on `seshi-18-decisions`. Builds three of the decisions in
[18](18-decisions.md): `seshi capture pause` stops sessions where they are (1, F9.5), the
uploader stays up while uploads or retractions wait to retry (10, F9.1), and the tests of what
runs on laptops run on a Windows runner (9, F8.4). User docs: [docs/capture.md](../../capture.md)
(what is captured, the status line, the uploader, files) and docs/cli.md (the pause row).

## What was built

- **A pause stops sessions where they are (decision 1).**
  - State (`state.ts`): a session gets `frozen: {at, offset}`, the transcript offset the
    server held from this machine when a pause stopped it (`uploadedOffset`: `file_offset` when
    stored, else 0), and `started_at`. The state keeps the pauses that ended (`pauses`, at most
    `MAX_PAUSES` = 20; `endPause` records one at `resume`, or at its own `until` when that came
    first). Helpers: `freeze` (keeps an earlier offset), `sendLimit`, `pauseWindows`.
  - The rule is in the one decision function (`rules.ts` `decide`). New inputs: `toggledAt`,
    `pausedAt`, `frozen`, `uploaded`, `started`, `pauses`; a new output, `frozen`, the offset
    the session stops at (`level: "pause"`, `capture: false`). After the shared rules: a session
    turned off is off; one already stopped stays stopped; while a pause is in force, any session
    is stopped at what it uploaded (a new one at 0); one that started during any recorded pause
    is stopped at 0, even when first seen after it. A session turned on after a pause began is
    not stopped by that pause. `stateFacts(state, agent, session, now, parentId?)` builds those
    inputs (and the toggle, a parent's included) from the state, and every caller of `decide`
    uses it: the hook, the sweep, the uploader, the status line, `capture status` and
    `seshi upload`. A subagent of a stopped session is stopped too unless it has its own toggle.
  - Recording it: `seshi capture pause` stops every session in the state (and every session a
    spooled hook entry names that the uploader has not taken in yet) at what it uploaded. A hook
    cannot write the state (X3.3), so a hook that gets `frozen` spools a new `paused` entry (no
    work of its own: no uploader started, not counted as queued); the uploader takes it in and
    stops the session. The sweep adds a session it finds during a pause, or that started in one,
    already stopped. The uploader stops a session its own decision says to, and records when a
    session not yet sent started (read once, from the transcript's head, while any pause is
    recorded), so one that started during a pause and first hooked after it stays off.
    `seshi upload` records the stop for a session it is handed during a pause.
  - Sending (`uploader.ts` `sync`): every piece is cut at `sendLimit`, read afresh before each
    piece, so a pause that lands mid-session stops it between pieces; that covers a whole
    resend after `409 offset_mismatch`, a moved transcript and a replace after `409 conflict`
    (and any later resend, such as another branch's stale-session resend, that goes through
    `sync`). A piece already on its way when the pause landed moves the stop to its end (the
    server holds it); so does a `409` whose `expected` is past the stop. `pending`, `queued` and
    the held size use the limit too. Nothing is retracted.
  - `seshi capture resume` ends the pause (kept in `pauses`) and says how many sessions stay
    stopped; it unfreezes nothing. `seshi capture on --session <id>` removes `frozen` from the
    session and its subagents without a toggle of their own (JSON `unfrozen: true`), and the
    uploader goes on from where it stopped, so the server ends with all of it, what it wrote
    while stopped included.
  - Words: `pause` says sessions stop where they are, how many, that sessions started during it
    are not captured and nothing is retracted; `capture status` shows the pause's effect and how
    many sessions are stopped (`stopped` in JSON); `sessionWord` says `stopped by a pause`; the
    status line shows ⏸ for a stopped session after the pause ends, and `statusline --json`
    carries `frozen_at`.
- **The uploader stays up while retries wait (decision 10).** `PassSummary.retrying` counts the
  queued uploads and retractions in backoff after a failure (`next_attempt_at`, not permanent).
  `run()` does not stop for idleness while that is above 0, until `retryWindowMs` (default 30
  minutes) after its last successful upload or retraction (or its start, if none), then logs and
  exits as before. With nothing waiting to retry, it stops after `idleMs` (5 minutes) as before;
  a permanent refusal or a needed sign-in is not something to wait for.
- **Windows CI (decision 9).** `vitest.laptop.config.ts` lists the laptop tests (`LAPTOP_TESTS`);
  `bun run test:laptop` runs them; the `test-windows` job in ci.yml runs `bun install` and that
  on `windows-latest`, with `core.autocrlf false` so fixtures keep their line endings, and the
  release job needs it. `scripts/laptop-tests.test.ts` checks that every pattern still names test
  files and that none reaches the server's tests; `release-config.test.ts` checks the job.
  - The list: capture's tests (hooks, spool, uploader, sweep, state, rules, place, sink); kit's
    `capture.test.ts` (the hooks' contract, `commandLine`, installers' file helpers); the Claude
    Code, Codex and Cursor capture tests (hook handlers, sweep paths, installers); the config
    package's CLI config, secret and units tests; the client's tests (the CLI uploads through
    it); and `apps/seshi`'s account, cli, capture wiring, integration registry and entry point
    tests.
  - Portability fixes made without a Windows host: `captureDir`/`capturePaths` and
    `cliConfigPath` join macOS and Linux paths with `posix` whatever the process runs on (they
    take the platform as an argument); `rulePath` (`capture off --path`) wrote an absolute path
    for a folder under home on Windows (it checked `${home}/`) and now writes `~/…` there,
    comparing as Windows does; the capture tests' hosts use this machine's platform (folder
    rules compare its own paths), tests set `APPDATA` beside `XDG_CONFIG_HOME`, the place test
    makes a junction on Windows, the uploader test takes the project name with `basename`, and
    the shebang test is skipped on Windows. File-mode checks were already skipped on win32;
    `HOME || USERPROFILE || homedir()` was already how the CLI finds home.
- **Tests** (all local, no network): `rules.test.ts` (stopped at what was uploaded, a stopped
  session after the pause, started during a pause, turned on after it began, off before the
  pause); `state.test.ts` (ended pauses, `stateFacts` with a parent's stop); `hook.test.ts`
  (the `paused` entry, nothing to upload); `uploader.test.ts` (a running session stopped and
  later bytes never sent; a pause landing mid-upload with a 409's whole resend stopping at the
  offset; a moved transcript's replace cut at the offset; a session started during a pause off
  by hook, sweep and first hook after it, never retracted; resume does not unfreeze, turning on
  uploads all of it; turned on during a pause; 5 clean idle minutes; a refusal is idle; staying
  up 30 minutes after the last success while one session keeps failing; 30 minutes from the
  start when nothing succeeds); `tests/capture/capture.test.ts` end to end through the CLI
  (pause, hook, daemon, resume, status line, `capture status`, `capture on --session`, and
  `seshi upload` during a pause).

## Extension points

- **Anything that sends a session** goes through `Uploader.sync`, which cuts every piece at the
  session's `sendLimit`; a new resend path (the stale-session resend) needs nothing more to
  respect a pause. One that builds its own pieces must use `sendLimit(session, size)`.
- **Anything that judges a session** builds `decide`'s input from `stateFacts`, so the pause,
  the stop and the toggle's time are always there.
- **The desktop mod (F9.4)**: a session's chip shows ⏸ when `decide` returns `level: "pause"`;
  turning it on is `seshi capture on --session`'s state change (delete `frozen`, `toggle: "on"`,
  `toggled_at`).

## Deviations and why

1. **A session turned on after a pause began is not stopped by it.** The decision does not say;
   without this, `capture on --session` during a pause would be stopped again by the next hook
   (pause beats the session level), and there would be no way to keep one session going
   through a pause. A session turned on before the pause is still stopped.
2. **`capture on --session` goes on from the stop rather than resending from 0.** F9.7's "from
   the start as a new session" is about a retracted session, which the server no longer has. A
   stopped one was never retracted, so its stored prefix stays and the rest follows as chunks:
   the server ends with the whole session, which is what "uploads the whole session" asks.
3. **"Running when the pause starts" is every session in the state**, plus the ones a spooled
   hook names. Which sessions are still running is not knowable from the state; a finished one
   with nothing left to send is unaffected, and one with bytes still queued (an outage) keeps
   only what was uploaded, as the decision says.
4. **A session turned off decides before the pause**, so it reports `level: "session"` rather
   than `"pause"` while paused. Both say not captured; only the reported level changed.
5. **The hook does not know when a session started** (it reads no transcript, X3.3). The
   uploader checks it before the first upload, and the sweep from the transcript; the hook's
   own decision for a session first seen after a pause may say capture, and the uploader's,
   from the same function with the start time added, stops it before anything is sent.
6. **Past pauses are kept (20)** so the started-during rule still holds after `resume`, a new
   state field the decision did not name.
7. **The 30 minutes count from the uploader's start when nothing has succeeded since**, not from
   a success recorded in the state by an earlier uploader.
8. **The Windows job runs a list of files, not "the full suite"**: the server's config and
   commands and `tests/` (end to end against a served Instance) stay on Linux with the server,
   as decision 9 says. The CLI's server-side commands (`serve`, `admin`, `workers`, `sync`,
   `reprocess`, `review`, `search`, `redact backfill`, `config check|show` of the server config)
   are left out with them; `tests/capture/capture.test.ts`, which drives the capture commands
   end to end, needs a served Instance and is left out too. 15's deviation 14 is superseded:
   the binaries job still smoke tests the Windows binaries, and this job adds the tests.

## Still to check

- **The Windows job has never run** (no Windows host here, and no PR). Expect a first round of
  fixes. What is unverified until it does:
  - Whether every listed test passes on Windows. Paths were checked only by running the pure
    path tests with `node:path` swapped for `path.win32` on macOS (a throwaway config, not
    committed), which found the `posix` joins and `rulePath` above; tests that touch the file
    system could not be checked that way.
  - Renames over a file another process has open: `writePrivateFile`, the spool and the lock
    files rename into place, which Windows can refuse (`EPERM`/`EBUSY`) while a reader holds
    the target; the tests run one process at a time and may not show it.
  - `process.kill(pid, 0)` liveness and lock takeover, `Bun.spawn` of `git` in the uploader's
    claims, and junction resolution in `placeOf`.
  - Fixture line endings with `core.autocrlf false`; the default (`true`) would rewrite them.
  - Whether `bun install --frozen-lockfile` and the `bun` vitest condition behave the same on
    the Windows runner.
- `capture.test.ts` end to end (hooks, daemon and the capture commands through the CLI) runs on
  Linux only; on Windows only the units run.
- A stopped session's `json`-encoded transcript (no capture agent uses one today) cannot be
  resent cut at an offset: the cut document does not parse, so nothing is sent, which keeps the
  rule but means a server that lost such a session does not get its prefix back.
- `state.json` now also grows by `frozen` and `started_at` per session and up to 20 pauses; see
  14's note on its size.

## Shared files touched

`package.json` (`test:laptop`), `tsconfig.json` (the new vitest config),
`.github/workflows/ci.yml` (the `test-windows` job, the release's `needs`),
`scripts/release/release-config.test.ts` (the new `needs` and the job),
`packages/ts/config/src/paths.ts` (`cliConfigPath` joins), `packages/ts/capture/src/index.ts`
and `fast.ts` (exports), docs/capture.md, docs/cli.md, and 17-review's "Not fixed" (the pause,
the uploader idle exit and Windows CI items removed).
