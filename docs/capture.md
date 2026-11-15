# Capturing sessions (F9)

seshi captures coding-agent sessions as they happen. Hooks in each agent hand every turn to
seshi; a background uploader sends what is new to the team's server; a sweep catches whatever
the hooks missed; and a status line says whether this session is being captured. Capture can be
turned off for everything, a repo, a folder, or one session, and a session turned off is
retracted from the server.

```
agent turn ──▶ seshi hook ──▶ spool ──▶ seshi daemon (uploader) ──POST /v1/sessions──▶ server
                 │ rules                    │ sweep of the agents' folders
                 ▼                          ▼
            state file  ◀────────────  upload positions, secrets, problems
                 ▲
            seshi statusline (local only)
```

## Installing

Sign in first ([cli.md](cli.md#signing-in-f82)), then:

```sh
seshi capture install            # every agent found on this machine
seshi capture install claude-code codex
seshi capture install --service  # also keep the uploader running between sessions
```

| Agent | What `install` writes | Events (F9.2) |
|---|---|---|
| Claude Code | hooks, the status line and the `/seshi` skill in `~/.claude/settings.json` and `~/.claude/skills/seshi/` (`CLAUDE_CONFIG_DIR` moves them) | SessionStart, Stop, SubagentStop, PreCompact, SessionEnd |
| Codex | `notify` in `~/.codex/config.toml` (`CODEX_HOME` moves it); a `notify` program already there keeps running, after seshi's | notify, plus the sweep of `~/.codex/sessions` |
| Cursor (IDE and CLI) | hooks in `~/.cursor/hooks.json` | stop, sessionEnd |

`install` merges: every hook already in those files stays, and running it twice is the same as
once. A status line someone else set up is kept (add `seshi statusline` to it yourself).
`seshi capture uninstall` takes out only seshi's entries; sessions already uploaded stay on the
server.

Hooks run the binary by its absolute path when seshi is the compiled binary, else `seshi` from
the agent's PATH; `--command <program>` names it. A Claude Code plugin with the same hooks and
skill is in `integrations/claude-code/plugin/`, for rolling out through a plugin marketplace or
managed settings. `--service` adds a launchd agent (macOS), a systemd user unit (Linux) or a
Task Scheduler task (Windows) that runs `seshi daemon --keep-alive`. While an uploader a hook
started is still running, the service's uploader waits for it to stop and then takes over.

## What is captured

One decision function judges every session, the same for hooks, the sweep, the status line and
`seshi upload` (F9.3):

1. **Shared rules can only turn capture off, and always win.** The org rule (`capture.remotes`
   in a managed CLI config: only repos whose git remote matches) and a repo's own committed
   `.seshi/config.toml` with `capture = false`.
2. **A pause** (`seshi capture pause 2h`, or until `seshi capture resume`) stops everything
   personal.
3. **The most specific personal level decides**: the session's own toggle, then the longest
   matching folder rule (`[[capture.paths]]`), then the global `capture.enabled` (on by default
   once capture is installed).

So a session can be turned on in a folder that is off, but not in a repo the team excluded. A
session whose folder is not known is not captured, since its repo's rule cannot be checked
(Cursor's transcripts do not say where they ran, so the sweep captures only Cursor conversations
a hook has seen). See [config.md](config.md#the-clis-config) for the settings.

```sh
seshi capture off --session         # this session (from inside the agent: the /seshi skill)
seshi capture off --session <id> --agent codex
seshi capture off --path ~/clients/acme
seshi capture off                   # everything, for this user
seshi capture status                # what applies here, and why
```

In Claude Code, `/seshi capture off`, `/seshi capture on` and `/seshi capture status` run
these for the current session: seshi's SessionStart hook sets `SESHI_SESSION_ID` for the
commands Claude Code runs. Without it, `--session` alone means the session seen most recently in
the current folder.

## The status line

```
Session Capture ◉
Session Capture ◉ · 3 queued
Session Capture ◉ · sign in
Session Capture ◉ · upload failing
Session Capture ⏸
```

◉ means this session is being captured, ⏸ that it is not (off, paused or excluded); anything that
needs action follows a separator, at most two things. It reads only local files, never the
network. Claude Code runs it as its status line; for Cursor and Codex, `seshi capture status`
says the same and more (which rule decided, the queue, the last errors).

## The uploader

Hooks only append a small file per event to the spool and exit, always with 0 and no output, in
a few milliseconds (X3.3). The uploader (`seshi daemon`) is started by a hook when it is not
running and stops after five idle minutes; one runs per machine. For each session it sends:

- the whole log until the server holds a trace of it (a short session the session filter skips
  stays on the machine and is sent whole again once it grows);
- then only the new complete lines, as a chunk at the server's offset, which the session filter
  never judges, so an agent-only tail is never lost.

It follows the server's answers: a `409 offset_mismatch` resends from where the server says (the
whole log when it says 0); a `409 conflict` on a session this machine wrote (the rules or the
normalizer changed) resends it with `replace`; `403` and `422` wait until the transcript changes;
anything else is retried with backoff. Every 15 minutes it sweeps the agents' transcript folders
for sessions the hooks missed, never reaching back past when capture was installed.

Uploads use the credential `seshi login` stored: the device token (with an IdP) or the org key
and your username. In local mode they go to your own bucket.

## Retraction (F9.7)

Turning a session off stops its uploads and removes what was uploaded. Each session has a random
secret that only its hash ever leaves this machine with; turning the session off sends the
secret, and the server deletes the session (a tombstone with reason `retracted`). A retraction
waits in the spool while the uploader is not running. Turning the session on again uploads it
from the start as a new session (`<id>~1`). If the state file is lost, the secret is gone: delete
the session with `seshi sessions rm` (with an IdP) or ask an admin. A server can turn retraction
off with `capture.allow_retract = false`.

If the server holds no such session for your credential although this machine stored it (it was
uploaded under another username, say), the retraction is not reported as done: `seshi capture
status` and the status line say `retraction refused`, and turning the session off again tries
again.

## Uploading by hand

```sh
seshi upload ~/.claude/projects/-code-app/1f2e….jsonl
seshi upload ~/exports/              # every transcript in a folder
seshi upload --since 30d             # backfill the installed agents' recent sessions
```

`seshi upload` goes through the same rules, state and uploader as hooks, so what it sends can be
retracted the same way. If the background uploader is running it does the work, and this
command waits for it.

## Files

| Where | What |
|---|---|
| `~/.local/state/seshi/` (`$XDG_STATE_HOME/seshi`; `%LOCALAPPDATA%\seshi` on Windows) | the capture folder, readable only by you |
| `state.json` | toggles, pause, upload positions, retraction secrets, problems |
| `spool/` | one small file per hook event: paths and ids, never transcript text |
| `uploader.json` | the running uploader's process id and heartbeat |
| `rules.json` | the capture rules as last read from the CLI config |
| `capture.log` | errors from hooks and the uploader (hooks never print) |

`SESHI_NO_UPLOADER=1` makes hooks spool without starting an uploader (CI, tests).

## Not yet

Client-side pre-redaction (F2.4) before upload is wired once the rule packs (branch 07) are in;
the server always redacts either way. The Claude desktop app's Session Capture chip (a mod) and
Datadog Trajectory's local files are later.
