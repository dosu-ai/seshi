---
name: verify-seshi
description: Drive a real, isolated seshi (the session-capture CLI, its local or served session store, and the `seshi explore` web page) to prove a behaviour end to end, with evidence. Use when a change touches capture, upload, redaction, sessions, search, the server or the doctor/explore tools, and you need to show it works the way a user would see it, not just that unit tests pass.
---

# verify-seshi

seshi captures coding-agent sessions (Claude Code, Codex, Cursor, pi, OpenCode) through agent hooks and a
background uploader, redacts them, and stores them in a bucket, either directly ("local mode")
or through `seshi serve` (an HTTP API plus a worker). Users touch it through the `seshi` CLI,
the agents' hooks, the `seshi explore` page and, in the Claude desktop app, a Session Capture
chip. This skill drives the CLI and the hooks for real in a throwaway home folder, with the
helper `scripts/control-seshi`, and records evidence for every step.

All commands below run from the repository root. `C` stands for the helper:

```bash
C=.claude/skills/verify-seshi/scripts/control-seshi
```

## Launch

There is no long-lived dev server to share. Each verification run gets its own folder under
`$TMPDIR/seshi-verify/<run-id>` with its own HOME, XDG folders, agent folders (`~/.claude`,
`~/.codex`), a `file://` bucket and, in server mode, its own `seshi serve` on a free port. It
never touches your real home, keychain (`SESHI_KEYCHAIN=false`) or agents, so runs can go side
by side.

```bash
bun install                       # once per checkout
$C up                             # local mode: the CLI writes the bucket itself
$C up --server                    # or: seshi serve on 127.0.0.1:<free port>, signed in with the org key
export VERIFY_SESHI_RUN=<id>      # copy the export line `up` prints; every later command needs it
```

- `up` prints `run <id>: <mode> mode at commit <sha>`, the run folder, the evidence folder and
  the `export` line. Local mode is seshi's serverless mode: `up` runs
  `seshi init --serverless --url file://<run>/bucket --owner "$USER"`, which writes the bucket's
  layout marker and `[serverless]` in the run's CLI config (owner: your OS username, `verifier`
  when `USER` is unset; no shared settings, so seshi's built-in defaults apply). Its output is
  in the run's `logs/init.log`. In server mode it instead runs `seshi admin init`, starts
  `seshi serve`, waits until `GET /healthz` answers `{"ok":true,...}`, then runs
  `seshi login --key -` as the user `verifier`. Ready means `up` returned 0 and `$C doctor` says
  `ready`. When `up` fails it stops what it started, deletes the run folder and keeps its logs
  in `.verify/seshi/<run-id>/up-logs/`.
- seshi runs from source (`bun run apps/seshi/src/main.ts`, through a `seshi` shim on the run's
  PATH). `$C up --binary` uses `dist/seshi` instead; run `bun run build` first. Use the binary to
  verify packaging, the source otherwise.
- Teardown is `$C down` (see Cleanup).

## Doctor

Run this first, and again whenever anything looks off. It changes nothing.

```bash
$C doctor
```

It prints the run, the commit the run started at against the repo's commit now (restart the run
if they differ and you mean to test the new code), `seshi --version`, and `seshi whoami`. In
server mode it also checks the server: the process is the one this run started, `/healthz`
answers, and the port is held by that process. It ends with `ready` (exit 0) or `NOT READY`
(exit 1, with a `FAIL` line). Don't drive a run that isn't ready; `$C down` and start again.

## Drive

| What | Command |
|---|---|
| Run any seshi command in the run | `$C cli --name <label> -- <seshi args…>` (example: `$C cli --name ls -- sessions ls`) |
| Simulate an agent session turn | `$C agent claude-code <session-id> [--turns N] [--secret]` |
| Start the explorer page | `$C explore`, which prints `http://127.0.0.1:<port>/?token=…` |
| Stop one process | `$C stop serve` or `$C stop explore` |
| The run's environment, for ad-hoc commands | `eval "$($C env)"` (in a subshell; it changes HOME) |

`agent` is the real capture path, the way Claude Code drives it:
1. It appends turns to the session's transcript in the run's `~/.claude/projects/`.
2. It pipes the hook payload (`session_id`, `transcript_path`, `cwd`, `hook_event_name`) into
   `seshi hook claude-code SessionStart` (first call only) and `Stop`.
3. It runs `seshi daemon --once --json` to flush the uploader. `SESHI_NO_UPLOADER=1` keeps hooks
   from spawning a background uploader, so each flush is deterministic.

Calling `agent` again for the same id appends turns, which the uploader sends as a continuation
chunk. `--secret` plants known fake credentials (`AKIAIOSFODNN7EXAMPLE`,
`password: "hunter2secretvalue42"`, a `ghp_…` token) in the first new turn. Only Claude Code
is scripted; Codex and Cursor go through `seshi upload` or their own hooks by hand.

For the explorer page, open the printed URL in the Browser pane (`preview_start` with the
`url`). Its API takes the token in an `X-Seshi-Token` header:
`curl -H "X-Seshi-Token: <token>" http://127.0.0.1:<port>/api/sessions`.

In server mode the HTTP API is at the port `up` printed. `admin.json` in the run folder holds the
admin token (`admin.token`) and the org key (`org_key.token`). The CLI is already signed in as
`verifier`.

The feature map in [features/README.md](features/README.md) has the recipe for each feature.
Read it before driving, and cover every entry point it lists for the feature you are proving.

## Evidence

Every `$C cli` call saves `NN-<label>.cmd`, `.out`, `.err` and `.code` under
`.verify/seshi/<run-id>/` in the repository (gitignored), and `up` copies `run.json` (mode,
port, commit) there. Save anything else you capture (screenshots, `curl` bodies, an
`aria`/text snapshot of the explore page) in the same folder, named for the feature.

Proof standards:
- **Real user path.** Exercise the path a user takes: hooks plus the uploader, the CLI, the HTTP
  API, the page. Never write the bucket or `state.json` by hand to make a check pass, and don't
  call internal functions.
- **Action and result.** Capture the action (the command and its output) and the resulting
  state from a second, read-only view. Examples: `sessions ls` or `doctor` after an upload, and
  an `export` after a redaction.
- **Side effects.** Check them: the bucket has the session (`sessions show`, or the files under
  the run's `bucket/`), the state file has the toggle (`seshi capture status --session <id>`),
  a retracted session is gone (`sessions ls`).
- **No raw secrets.** Grep exports and API responses for the planted values; they must not
  appear. Never paste a real credential into a run.
- **Read-only tools.** `seshi doctor` and `seshi explore` claim to be read-only. When a proof
  relies on that, check it: the state file's mtime and the spool are unchanged, and a server's
  log shows only GETs.

## Cleanup

```bash
$C down
```

It stops only the processes this run started (by pid and start time, never by name), deletes
the run folder under `$TMPDIR/seshi-verify/`, and leaves `.verify/seshi/<run-id>/` in place. Run
it after every run, failed ones included, so no server or port is left behind. If a run's folder
is gone but a process survived, `$C stop` can't find it: look for
`seshi serve --config $TMPDIR/seshi-verify/<run-id>/seshi.toml` in `ps` and kill that pid only.

## Helpers

- `scripts/control-seshi`: the harness above. `$C help` prints its usage.
- `scripts/transcript.ts`: appends synthetic Claude Code turns (`bun scripts/transcript.ts
  <path> <session-id> <cwd> [--turns N] [--secret]`); `agent` calls it.

## Gotchas

- seshi reads every `SESHI_*` environment variable as a setting and refuses unknown ones. That's
  why the harness's own variables are `VERIFY_SESHI_RUN` and `VERIFY_SESHI_ROOT`. Don't export
  a `SESHI_` name seshi doesn't know.
- The server keeps a session only once it holds about 2,000 characters (the session filter). A
  one-turn transcript is answered "too small yet" and nothing is stored, though the daemon still
  counts it as uploaded. Use `--turns 4` or more, and assert storage with `sessions ls`.
- Search is indexed in the background by the worker. Right after an upload, `seshi search`
  can answer "no sessions match". Retry for a few seconds before calling it a failure.
- `seshi upload` without the harness reads the real agent folders of whatever HOME it runs
  with. Always go through `$C cli` or `$C env` so it sees only the run's folders.
- Server mode only: `seshi serve` alone reads `./seshi.toml` unasked. Other server commands need
  `--config "$TMPDIR/seshi-verify/<run-id>/seshi.toml"`. A local-mode run has no `seshi.toml`;
  the CLI config's `[serverless]` names its bucket.
