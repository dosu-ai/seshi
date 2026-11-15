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

Sign in to your team's server first (`seshi login`, [cli.md](cli.md#signing-in-f82)), or point
the CLI at your own bucket ([local mode](config.md#the-clis-config)), then:

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
started is still running, the service's uploader waits for it to stop and then takes over. A
service does not get your shell's environment: the launchd and systemd entries carry
`XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (so it uses the same
capture folder, CLI config and agent folders as the hooks), and `install` names any `SESHI_*`
setting it sees, which the service will not (put those in the CLI config), and on Windows a
moved agent folder, which a Task Scheduler task cannot carry.

## What is captured

One decision function judges every session, the same for hooks, the sweep, the status line and
`seshi upload` (F9.3):

1. **Shared rules can only turn capture off, and always win.** The org rule (`capture.remotes`
   in a managed CLI config: only repos whose git remote matches) and a repo's own committed
   `.seshi/config.toml` with `capture = false`. They hold for every folder a session was seen
   in: a session that worked in an excluded repo and then moved into a captured one (a nested
   repo, `--add-dir`) carries that work in its transcript, so it is not uploaded, and nothing
   more of a captured session is sent once it works in an excluded repo. What it uploaded
   before stays (rule changes do not retract).
2. **A pause** (`seshi capture pause 2h`, or until `seshi capture resume`) holds every upload
   back while it lasts. It does not keep anything out: what sessions write during it stays in
   their transcripts and is uploaded when the pause ends, including sessions that started and
   ended during it. To keep a session out, turn it off (`seshi capture off --session`), which
   also retracts what it uploaded.
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
commands Claude Code runs. Without it, `--session` alone means the one session seen in the
current folder in the past day; when more than one ran there it lists them and asks for
`--session <id>` rather than guess (a subagent never counts: its parent's toggle covers it).

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
  stays on the machine and is sent whole again once it grows; one whose first upload model
  review dropped is held on the server as a stub of where its log ends, so what follows goes as
  a chunk and the dropped part is not sent again);
- then only the new complete lines, as a chunk at the server's offset, which the session filter
  never judges, so an agent-only tail is never lost.

It follows the server's answers: a `409 offset_mismatch` resends from where the server says (the
whole log when it says 0); a `409 conflict` on a session this machine wrote (the rules or the
normalizer changed) resends it with `replace`; `403` and `422` wait until the transcript changes;
anything else is retried with backoff. Every 15 minutes it sweeps the agents' transcript folders
for sessions the hooks missed, never reaching back past when capture was installed.

The server keeps no raw transcripts, so when seshi's reading of an agent's format improves, it
cannot rebuild what it already stored: the machine that uploaded a session sends it again. At
most once an hour the uploader asks the server which of your sessions an older version of the
format's normalizer built (`GET /v1/sessions/stale`), and on its next pass sends each one it
still has the transcript of again, whole, marked `rebuild`: the server builds the session from
the whole log and reviews it again, replacing what it held. Each session goes once per
normalizer version, even if the server still lists it afterwards (model review dropped the
rebuild, say). A session turned off is never sent again, and one whose transcript is gone
cannot be.

Uploads use the credential `seshi login` stored: the device token (with an IdP) or the org key
and your username. In local mode they go to your own bucket.

### Redacting before upload (F2.4)

Nothing a rule knows leaves the machine. Before each piece is sent, the uploader redacts it with
your server's rule packs and the built-in pack, the same rules the server runs
([redaction.md](redaction.md)): secrets become `[redacted:<rule>]`, and a call
that reads a sensitive file (`.env`, keys) or runs a secret command keeps its call while its
result is withheld, even when the result only arrives in a later chunk. The server redacts
everything again regardless, so what the client did is never trusted.

The uploader fetches the rules (`GET /v1/redaction/rules`) once per run and keeps them in
`redaction-rules.json`; the next run sends their ETag and an unchanged rule set costs a `304`.
A server without the rules route leaves the built-in pack. When the server cannot serve the
rules, the ones fetched before are used; with none, nothing is sent until it can (retried like
any upload). Redacting changes line lengths, so the uploader keeps its place in your file and
the server's offset (in redacted bytes) apart. After the server's rules change, the next whole
upload of a session this machine stored may get `409 conflict`, and is sent again with
`replace`. In local mode the Instance in the same process redacts before it writes, so nothing
is fetched.

## Retraction (F9.7)

Turning a session off stops its uploads and removes what was uploaded. Each session has a random
secret that only its hash ever leaves this machine with; turning the session off sends the
secret, and the server deletes the session (a tombstone with reason `retracted`). A retraction
waits in the spool while the uploader is not running. Turning the session on again uploads it
from the start as a new session (`<id>~1`). A session's subagents (Claude Code's `agent-<id>`
sessions, which hold its task prompts and their tool output) go with it unless they were toggled
themselves: turning the session off retracts what they uploaded and keeps later ones from being
sent, by hooks or the sweep. If the state file is lost, the secret is gone: delete
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

```sh
seshi capture resend --session 1f2e…   # one session (no id: the one this agent runs)
seshi capture resend --all             # every session uploaded from this machine
```

`seshi capture resend` sends sessions this machine uploaded again, whole, with `rebuild`, as the
uploader does by itself for stale ones: the server builds each from the whole log and reviews it
again, even when nothing in the log is new. Use it after an outage of the review provider, to
have envelopes that review skipped or dropped reviewed again (a dropped first upload stays
out: it is never sent to review again). Sessions turned off, never
uploaded from here, or whose transcript is gone are left out and listed. It marks the sessions
and wakes the uploader; `seshi capture status` shows them as `resending` until they are sent.

## Files

| Where | What |
|---|---|
| `~/.local/state/seshi/` (`$XDG_STATE_HOME/seshi`; `%LOCALAPPDATA%\seshi` on Windows) | the capture folder, readable only by you |
| `state.json` | toggles, pause, upload positions, retraction secrets, problems |
| `spool/` | one small file per hook event: paths and ids, never transcript text |
| `uploader.json` | the running uploader's process id and heartbeat |
| `rules.json` | the capture rules as last read from the CLI config |
| `redaction-rules.json` | your server's redaction rules as last fetched, with their ETag |
| `capture.log` | errors from hooks and the uploader (hooks never print) |

`SESHI_NO_UPLOADER=1` makes hooks spool without starting an uploader (CI, tests).

## Not yet

The Claude desktop app's Session Capture chip and `/session-capture` (a mod), a first-run
notice inside Cursor and Codex that capture is on, and Datadog Trajectory's local files are
later. In the desktop app, the
`/seshi` skill's `capture off|on|status --session` covers one session meanwhile.
