# Capturing sessions (F9)

seshi captures coding-agent sessions as they happen. Hooks in each agent hand every turn to
seshi; a background uploader sends what is new to the team's server (or, in serverless mode,
runs the pipeline and writes the bucket itself); a sweep catches whatever
the hooks missed; and a status line says whether this session is being captured. Capture can be
turned off for everything, a repo, a folder, or one session, and a session turned off is
retracted from the session store.

```
agent turn ──▶ seshi hook ──▶ spool ──▶ seshi daemon (uploader) ──POST /v1/sessions──▶ server
                 │ rules                    │ sweep of the agents' folders
                 ▼                          ▼
            state file  ◀────────────  upload positions, secrets, problems
                 ▲
            seshi statusline (local only)
```

## Installing

Sign in to your team's server first (`seshi login`, [cli.md](cli.md#signing-in-f82)), or set
this machine up to write a bucket directly (`seshi init --serverless`,
[serverless.md](serverless.md)), then:

```sh
seshi capture install            # every agent found on this machine
seshi capture install claude-code codex
seshi capture install pi opencode
seshi capture install --service  # also keep the uploader running between sessions
```

| Agent | What `install` writes | Events (F9.2) |
|---|---|---|
| Claude Code | hooks, the status line and the `/session-capture` skill in `~/.claude/settings.json` and `~/.claude/skills/session-capture/` (`CLAUDE_CONFIG_DIR` moves them) | SessionStart, Stop, SubagentStop, PreCompact, SessionEnd |
| Codex | `notify` in `~/.codex/config.toml` (`CODEX_HOME` moves it); a `notify` program already there keeps running, after seshi's. SessionStart and UserPromptSubmit hooks in `~/.codex/hooks.json` for the notice and `$session-capture`, and the `$session-capture` skill in `~/.agents/skills/session-capture/` | notify, plus the sweep of `~/.codex/sessions`; SessionStart and UserPromptSubmit only for the notice and `$session-capture` |
| Cursor (IDE and CLI) | hooks in `~/.cursor/hooks.json`, the Cursor CLI's status line in `~/.cursor/cli-config.json`, and the `/session-capture` skill in `~/.cursor/skills/session-capture/`; it suggests the status bar extension ([below](#the-cursor-status-bar)) | stop, sessionEnd; beforeSubmitPrompt for `/session-capture` and the last chat prompted |
| pi | the extension `~/.pi/agent/extensions/seshi.ts` (`PI_CODING_AGENT_DIR` moves it) | agent_end (Stop), session_shutdown (SessionEnd, not on `/reload`); `/session-capture`, a command of its own; plus the sweep of `~/.pi/agent/sessions`, or of the folder `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in pi's settings names |
| OpenCode | the plugin `~/.config/opencode/plugins/seshi.js`, the TUI plugin `~/.config/opencode/seshi/tui.js` with its entry in `tui.json`'s `plugin` list, and the `/session-capture` command `~/.config/opencode/command/session-capture.md` (`XDG_CONFIG_HOME` moves them) | session.idle (Stop), with the whole session; session.created (SessionStart) for the notice; `/session-capture` |

pi and OpenCode run no shell hooks: they load code at start-up, so seshi installs a file each
loads, written whole (and rewritten by the next `install`, so edits do not last) and removed by
`uninstall`. It runs `seshi hook pi|opencode <event>` with a JSON payload on stdin, as the other
agents' hooks do, so the rules, the spool and the uploader are the same. A file of the same name
that is not seshi's is left alone, and that agent is not captured. Restart pi (or `/reload`) and
OpenCode after `install`. Started with `--no-extensions` (pi) or `--pure` (OpenCode), or with
`--no-session` (pi), they capture nothing. pi's session files are append-only JSONL with the
folder in their first line, so they upload in chunks and the sweep and `seshi upload --since`
find sessions no hook saw. OpenCode keeps its sessions in a database, not in files: after each
turn the plugin reads the session through OpenCode's own client and hands it to seshi whole (the
`{info, messages}` export `opencode export` prints), and seshi writes it to
`transcripts/opencode/` in the capture folder, only for a session it captures, and uploads it
whole each time. OpenCode has no end-of-session event, so its sessions end when the uploader
finds them quiet. A subagent's session (OpenCode's task tool) is captured as its own session with
its parent's id.

OpenCode's TUI loads its plugins from the `plugin` list in `tui.json`, so `install` adds seshi's
TUI plugin there and keeps every other entry and setting; `uninstall` takes out only that entry
(and the file, when nothing but its `$schema` is left). OpenCode also reads a `tui.jsonc`, but a
`tui.json` with comments is left alone, since rewriting it would drop them: `install` and
`capture status` say what to add to its `plugin` list by hand. Capture works without the TUI
plugin; only the status and `/session-capture` without a model turn need it.

`install` merges: every hook already in those files stays, and running it twice is the same as
once. A status line someone else set up, in Claude Code or the Cursor CLI, still shows, with
seshi's after it: `install` moves it to `~/.claude/seshi-statusline.json` (or
`~/.cursor/seshi-statusline.json`) and points the status line at
`seshi statusline --chain <that file>`, which runs it with the same input first. A skill named
`seshi` that is not seshi's is left alone. `seshi capture uninstall` takes out only seshi's
entries and puts a chained status line back; sessions already uploaded stay in the store.

The skill is the same in every agent (Cursor also reads Claude Code's and Codex's skill folders,
so it may list it more than once): it turns capture off or on for the session the agent is in,
or says whether it is captured, naming the agent with `--agent`. seshi knows which session that
is in Claude Code (`SESHI_SESSION_ID`, set by its SessionStart hook) and in Codex
(`CODEX_THREAD_ID`); in Cursor it is the one Cursor session seen in the current folder in the
past day.

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

## Cursor Cloud agents

Cursor Cloud agents run in a VM Cursor builds from the repository, and run only the
repository's hooks (`.cursor/hooks.json` at its root), never `~/.cursor/hooks.json`. So for them
seshi's hooks are committed to the repository, the repository's environment setup installs seshi
on the VM and signs it in, and each hook uploads to your team's seshi server before it returns.
Cursor's API for cloud agents (F7) is not used.

### 1. The hooks, committed

```sh
seshi capture install cursor --project            # the repository around this folder
seshi capture install cursor --project ~/code/app
git add .cursor/hooks.json .cursor/seshi-cloud.sh && git commit -m "Capture Cursor Cloud agents"
```

This merges three hooks into `.cursor/hooks.json`, keeping everyone else's, and writes the setup
script `.cursor/seshi-cloud.sh`:

```json
{ "command": "s=$(command -v seshi || echo \"$HOME/.local/bin/seshi\"); [ -x \"$s\" ] || exit 0; exec \"$s\" hook cursor stop --cloud", "timeout": 60 }
```

for `stop` and `sessionEnd` (60 s each) and `beforeSubmitPrompt` (30 s), so `/session-capture`
works in cloud chats. The hooks run `seshi` from the PATH (or where the setup script puts it),
never the installing machine's path, and neither file holds a token, a server URL or anything
else secret. `install` again rewrites seshi's entries and the script (a new seshi pins its own
version); `seshi capture uninstall cursor --project` takes out only seshi's, and
`seshi capture status --project` says whether they are in and current. `--project` never takes
the home folder, whose `.cursor` is the user-level config.

### 2. The VM's setup

Add the script's two steps to `.cursor/environment.json`, after any steps of your own:

```json
{
  "install": "npm ci && sh .cursor/seshi-cloud.sh install",
  "start": "sh .cursor/seshi-cloud.sh start"
}
```

- `install` runs when Cursor builds the environment: it puts the seshi release the script pins
  (the version that wrote it) in `/usr/local/bin`, or `~/.local/bin` when that is not writable,
  with the [install script](install.md).
- `start` runs at the start of every agent run: it makes sure that seshi is there, marks the VM
  (`seshi capture install cursor --cloud`, below), and signs in:
  `printf %s "$SESHI_TOKEN" | seshi login --server "$SESHI_SERVER" --token -`. Cursor adds
  secrets only when an agent starts, not to the build, so signing in is this step's.

Neither step fails the environment: without seshi or the secrets they say why on stderr, and
cloud sessions are not captured. If your team sets the environment up in Cursor's dashboard
(Environments) instead, add the same two commands there: a saved environment reads
`.cursor/environment.json` only when it is pointed at it.

### 3. The cloud owner, its token and the secrets

The server decides a session's owner from the credential, never from what the data says, so cloud
sessions are all stored under one owner, `cursor-cloud`, whoever started the agent. An admin
mints a device token for it, the kind a laptop gets when someone signs in:

```sh
seshi tokens create device --owner cursor-cloud --expires 365d --label "Cursor Cloud agents"
```

A device token writes sessions as its owner (`owner_basis: verified`) and reads nothing else. It
lasts 90 days unless `--expires` says otherwise. Add `--visibility org` if your deployment's
default visibility is `owner`, or only admins will read cloud sessions.

In Cursor's dashboard (Cloud Agents, Secrets), add:

| Secret | Value |
|---|---|
| `SESHI_SERVER` | your seshi server's URL |
| `SESHI_TOKEN` | the token; a **Runtime Secret**, so Cursor redacts it from transcripts and tool output |

seshi never reads `SESHI_TOKEN` itself (it passes over the name, as it does `SESHI_SESSION_ID`);
only the start step pipes it to `seshi login`. `SESHI_SERVER` is seshi's own `server` setting,
with the same meaning.

**Rotating the token.** Before it expires, mint a new one, put it in `SESHI_TOKEN`, then revoke the
old one (`seshi tokens ls --owner cursor-cloud`, `seshi tokens revoke <id>`). The start step signs
in on every run, so the next run uses the new token. Cursor does not renew a secret, so a token
that lapses stops cloud capture: each stop says so on its stderr and in `capture.log`
(`the token for <server> (cursor-cloud) expired 2027-11-17; an admin makes a new one …`), as
`seshi capture status` and `seshi doctor` do on the VM. seshi knows the expiry from
`seshi login`, which records it.

### Hooks on everyone else's machines

Cursor runs a repository's hooks beside each person's own, so every teammate's Cursor runs the
committed hooks too. They do nothing there. Cursor documents no environment variable or payload
field that says a hook runs in a cloud agent (`is_background_agent` comes only with `sessionStart`
and `sessionEnd`, which cloud agents never fire), so the start step **marks the VM**: the file
`cursor-cloud` in seshi's state folder. The marker is seshi's own and is written only by a step
that runs only on the VM, and checking it is one file lookup.

- A laptop with seshi: the committed hooks exit at once, with nothing spooled, started or said;
  seshi's user-level Cursor hooks capture as before.
- A laptop without seshi: the shell finds no `seshi` and exits 0 with nothing said.
- Windows: Cursor runs hooks in PowerShell, where the committed line (POSIX `sh`) fails. Cursor
  lets the prompt through and logs the failure in its Hooks output; nothing else happens.
- On a marked VM, seshi's user-level Cursor hooks (if any) stand aside, so the two never both
  upload a conversation.

### What a cloud run uploads, and when

- Cloud agents fire `stop`, not `sessionEnd`. Each `stop` uploads in the hook, before it returns
  (for up to 45 s of its 60), instead of leaving it to a background uploader: the VM can be gone
  as soon as the run ends. An upload that fails is said on the hook's stderr
  (`seshi: cursor:<id> was not uploaded: …`) and in `capture.log`. Where Cursor shows a cloud
  hook's stderr is not documented.
- The transcript: Cursor Cloud has sent an empty `transcript_path`, so seshi also takes the
  `CURSOR_TRANSCRIPT_PATH` Cursor sets for hooks, then looks under `~/.cursor/projects`. When it
  finds none, the hook says so.
- The capture rules apply as on a laptop: the folder is the VM's checkout, so the repository's
  `.seshi/config.toml` and the server's rules decide, and pre-redaction happens before upload.
- `/session-capture off`, `on` and `status` work in a cloud chat, and `off` retracts what was
  uploaded before the hook returns. A VM rebuilt for a follow-up (below) no longer holds the
  retraction secret of what an earlier VM uploaded: an admin removes that with `seshi sessions rm`.
- **Tool results are not captured yet**: Cursor's transcripts hold the agent's tool calls but not
  what they returned, and seshi's Cursor adapter does not yet add them from `postToolUse`.
- Who started the agent is not recorded: the session's owner is `cursor-cloud`.

### Follow-ups

A follow-up to an agent that has gone idle, even days later, is a new run. Cursor resumes the VM
from its disk snapshot (kept for 30 days of inactivity) or, when that is gone, builds a new one
from the environment. On a resumed VM the transcript and seshi's upload state are as the last run
left them, and the upload goes on from where it was. On a rebuilt one seshi's state is gone, and
what Cursor puts in the transcript there is not documented (nor checked yet): the whole
conversation, only the new run, or nothing.

So with no state, seshi sends the whole transcript. When it starts with what the server stored
(the whole conversation), the server extends the stored session. When it does not, seshi does
not replace the stored session: the VM's file is not to be trusted over what an earlier VM
uploaded, and replacing it with a shorter log would lose history. It **continues** it instead, as
a new session `<id>~r1` whose `parent_session_id` (and `fork_of`) is the stored one, and later
stops on that VM extend `<id>~r1`. A later rebuild that does not extend that either goes on to
`~r2`.

## What is captured

One decision function judges every session, the same for hooks, the sweep, the status line and
`seshi upload` (F9.3):

1. **Shared rules can only turn capture off, and always win.** The org rule (`capture.remotes`
   in a managed CLI config: only repos whose git remote matches) and a repo's own committed
   `.seshi/config.toml` with `capture = false`. They hold for every folder a session was seen
   in: a session that worked in an excluded repo and then moved into a captured one (a nested
   repo, `--add-dir`) carries that work in its transcript, so it is not uploaded, and nothing
   more of a captured session is sent once it works in an excluded repo. A subagent is judged
   by its parent's folders too (and the parent's parent's): what the parent did in an excluded
   repo reaches the subagent through its task, so it is not uploaded, wherever it runs. What
   it uploaded before stays (rule changes do not retract).
2. **A pause** (`seshi capture pause 2h`, or until `seshi capture resume`) stops sessions where
   they are. Every session running when it starts, or seen while it lasts, keeps what it has
   uploaded and uploads nothing more, ever: not after the pause ends either. A session started
   during the pause is not captured at all, even when it is first seen after the pause. Nothing
   is retracted. Sessions started after the pause ends (or after `seshi capture resume`) are
   captured as usual. `resume` does not restart a stopped session; `seshi capture on --session
   <id>` does, and then all of it is uploaded, including what it wrote while stopped. (A session
   turned on during a pause is not stopped by that pause.)
3. **The most specific personal level decides**: the session's own toggle, then the longest
   matching folder rule (`[[capture.paths]]`), then the global `capture.enabled` (on by default
   once capture is installed).

So a session can be turned on in a folder that is off, but not in a repo the team excluded. A
session whose folder is not known is not captured, since its repo's rule cannot be checked
(Cursor's transcripts do not say where they ran, so the sweep captures only Cursor conversations
a hook has seen). See [config.md](config.md#the-clis-config) for the settings.

```sh
seshi capture off --session         # this session (from inside the agent: the /session-capture skill)
seshi capture off --session <id> --agent codex
seshi capture off --path ~/clients/acme
seshi capture off                   # everything, for this user
seshi capture pause 2h              # stop every session where it is; new ones are not captured
seshi capture on --session <id>     # upload a session a pause stopped, all of it
seshi capture status                # what applies here, and why
```

How a pause differs from turning a session off: off retracts what the session uploaded; a pause
keeps it on the server and sends nothing more. Under the hood, the state file records the offset
each stopped session reached (`frozen`); every send of that session stops there, even a resend
of the whole log the server asks for (after a `409`, a moved transcript or a `replace`).

In Claude Code, `/session-capture off`, `/session-capture on` and `/session-capture status` run
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
Session Capture ◉ · needs review key
Session Capture ⏸
```

◉ means this session is being captured, ⏸ that it is not (off, stopped by a pause, paused or
excluded); anything that
needs action follows a separator, at most two things. It reads only local files, never the
network. Claude Code and the Cursor CLI run it as their status line (the Cursor CLI's with
`--agent cursor`). Codex's status line takes only its own
built-in items, so there seshi's SessionStart hook says it once, when a session starts or
resumes, as a notice: `Session Capture ◉ · this session is uploaded to your team's session
store as you work; $session-capture off stops it`, or `Session Capture ⏸ · <why not>`. Codex asks you to
trust a new hook the first time it runs.

Codex's sandbox keeps the commands its agent runs from writing seshi's state folder, so in
Codex `$session-capture off`, `$session-capture on` and `$session-capture status` (or `$session-capture`), typed as a message of its
own, are done by seshi's UserPromptSubmit hook, which runs outside the sandbox, before the
model sees the message; the result shows as a notice.

The Cursor IDE has no status line, and shows a hook's message only when the hook stops a
prompt. So Cursor's beforeSubmitPrompt hook does the same for `/session-capture off`, `/session-capture on` and `/session-capture status`
(or `/session-capture`) typed as a message of its own: it stops the message, the answer appears in its
place, and the model never runs. Every other message passes.

Elsewhere the skill runs `seshi capture off|on`, asking to leave a sandbox when there is one.
In every agent, the skill and `seshi capture status` say the same and more (which rule
decided, the queue, the last errors).

pi has no status line of its own to run, so seshi's extension puts `seshi statusline --agent pi`
in pi's footer, refreshed when a session starts and after each agent run, and registers
`/session-capture off|on|status` as a pi command: seshi does it, the answer shows as a notification, and
the model never sees it (any other argument changes nothing, and says so). OpenCode shows the
start notice above in a toast when a new session starts, and seshi's TUI plugin puts
`seshi statusline --agent opencode` (up to its first `·`) on the right of the prompt, for the
session in view, refreshed when it comes into view and after each turn: `Session Capture ◉`, or
`⏸` in the theme's warning colour. `/session-capture`, `/session-capture off`, `/session-capture on` or `/session-capture status`
typed in a session's prompt is taken by the TUI plugin when you submit it: seshi does it, the
prompt is cleared, the answer shows in a toast, and nothing reaches the model. Anything else
after `/session-capture`, and `/session-capture` where there is no TUI plugin (`opencode run --command session-capture`, the
web UI) or no session yet (OpenCode's home screen), goes to the command file, which OpenCode
always sends to the model; seshi's server plugin does what it asks first and puts the answer,
with a request for a one-line acknowledgement, in place of the command, so the model's reply is
the only cost. Once seshi has said a session is not captured (at its start, or by `/session-capture`), the
server plugin stops reading and handing over its turns, until seshi's status line says it is
captured again (after the TUI's `/session-capture on`, or `seshi capture on --session`). In both agents,
the extension and the plugins pass the session's id themselves: seshi's own `SESHI_SESSION_ID`,
set in a shell another agent started, is ignored.

The Claude desktop app's Code tab has no status line. There, seshi's Claude Code plugin draws the
same words as a chip in the prompt footer; clicking it turns capture off or on for the session,
and `/session-capture [on|off|status]` does the same by command. It needs the plugin installed
(`/plugin install seshi --marketplace dosu-ai/sessiondb`), not just `seshi capture install`; see
[the plugin's README](../integrations/claude-code/plugin/README.md#the-desktop-chip).

### The Cursor status bar

Cursor's editor windows have no status line either. The **seshi Session Capture** extension
(`dosu.seshi-cursor`, from Cursor's Extensions view; [its source](../integrations/cursor/extension/))
puts the same words in their status bar for the chat you have open, coloured when something
needs action, and a click turns capture off or on for that chat (a team's rule is explained
instead).

- **Which chat.** Cursor has no API for it. The extension asks Cursor for the open chats
  through an undocumented command (`composer.getOrderedSelectedComposerIds`) and matches the
  active chat tab to them; they come in the same order. When that is not possible (a new chat's
  tab appears before its id, or a Cursor update changes either), it shows the chat you last
  sent a message in, which Cursor's beforeSubmitPrompt hook records per folder in
  `recent/`, and a click asks which chat first. **seshi.useCursorInternals** off uses only the
  last chat.
- **What it runs.** `seshi statusline --agent cursor --json --folder <workspace folder>…` with
  `--session <focused chat>` and `--selected <open chats>`, and
  `seshi capture off|on --session <id> --agent cursor`. It never reads seshi's files itself. The
  program is **seshi.command**, else the one seshi's own hook in `~/.cursor/hooks.json` runs,
  else `seshi` on the PATH.
- **When it refreshes.** When seshi's state, a recorded prompt or the CLI config changes, when
  tabs or the window change, every 2 seconds for the open chats while the window has focus,
  and every 30 seconds.
- **Where.** Editor windows only: the Agents Window does not show extensions' status bar items,
  and the Cursor CLI has its own status line (above). `/session-capture` works in both.

## The uploader

Hooks only append a small file per event to the spool and exit, always with 0 and no output, in
a few milliseconds (X3.3). The uploader (`seshi daemon`) is started by a hook when it is not
running and stops after five idle minutes; one runs per machine. While uploads or retractions
wait to retry (the server is down, the network is out), it is not idle: it keeps running and
retrying for up to 30 minutes after its last successful upload or retraction, then stops; what
is left waits, with its place kept, for the next hook to start it again (or for the service,
`--service`). For each session it sends:

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
format's normalizer built (`GET /v1/sessions/stale`), and sends each one it still has the
transcript of again, whole, marked `rebuild`: the server builds the session from the whole log
and reviews it again, replacing what it held. A normalizer change makes many sessions stale at
once, so each waits a random time within a day before it goes, and an uploader pass sends at
most two; new turns of the session go as usual meanwhile. `seshi capture resend` does not wait. Each session goes once per
normalizer version, even if the server still lists it afterwards (model review dropped the
rebuild, say). A session turned off is never sent again, and one whose transcript is gone
cannot be.

Uploads use the credential `seshi login` stored: the device token (with an IdP) or the org key
and your username. In serverless mode the uploader runs the pipeline itself and writes the
bucket with the key `seshi init --serverless` stored; uploads can then wait for reasons of their
own ([below](#uploads-that-wait)).

### Uploads that wait

Some problems stop every upload until you act. The sessions stay on this machine, in the spool,
with their place kept; nothing is lost, and the uploader sends them once the problem is gone.
The status line names the problem after the separator, and `seshi capture status`,
`seshi upload` and `seshi doctor` print it with what to do:

| Word | Why | What to do |
|---|---|---|
| `sign in` | No credential for the server, or it was refused | `seshi login --server <url>` |
| `needs review key` | Serverless mode: the team requires model review (`review.required = true`), and no key for a policy's provider is set on this machine. Nothing has been uploaded unreviewed | `seshi review key set <provider>`, or set the variable the policy names (such as `ANTHROPIC_API_KEY`) where the uploader runs (a `--service` uploader does not see your shell's variables); then `seshi doctor` |
| `needs update` | Serverless mode: the bucket needs a newer seshi to write (`seshi admin layout --min-version`) | Update seshi ([install.md](install.md)) |
| `bad shared settings` | Serverless mode: the bucket's shared settings (`config/`) fail their checks on this machine, and there is no earlier good copy to use. Uploading without them would skip the team's redaction and review settings | `seshi doctor` says what fails. An admin fixes `config/` (`seshi admin config pull`, edit, `push`), or you update seshi or fix this machine's `serverless.config`; the copy is checked again after each |
| `bucket refused` | Serverless mode: the bucket key can't write this owner's folder or read the shared settings, the bucket refused a write during an upload (a rotated or expired key, a clock far off), the bucket has no seshi marker, or the store fails the storage test | `seshi doctor` says which. Check the key's permissions and that `serverless.owner` is the folder it may write (`seshi whoami`); run `seshi init --serverless` on a bucket with no marker; use a store with conditional writes ([serverless.md](serverless.md#credentials)) |

`seshi upload` exits 3 while uploads wait for a review key, an update or usable shared settings,
and 5 for `sign in` and `bucket refused`. In serverless mode, a refusal from the bucket while one
session is written holds every upload (`bucket refused`), since it is about the key, not the
session; with a server, a `403` for one session is not a hold: that session waits until its
transcript changes.

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
`replace`. In serverless mode the pipeline in the same process redacts before it writes, with
the rule packs its settings name (the bucket's shared settings and this machine's own), so
nothing is fetched.

## Retraction (F9.7)

Turning a session off stops its uploads and removes what was uploaded. Each session has a random
secret that only its hash ever leaves this machine with; turning the session off sends the
secret, and the server deletes the session (a tombstone with reason `retracted`). A retraction
waits in the spool while the uploader is not running. Turning the session on again uploads it
from the start as a new session (`<id>~1`), also when the retraction is still waiting: it is
not called off, since it may already have landed with its answer lost. A session's subagents (Claude Code's `agent-<id>`
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

## Checking a session

```sh
seshi doctor --session            # the session this agent runs (or the one seen in this folder)
seshi doctor --session 1f2e… --deep
seshi doctor                      # every session seen in the past day; --since 7d for more
```

`seshi doctor` reads the three views of a session that only this machine has together: the
transcript, the capture state (the decision and why, offsets, a pause's stop, the toggle and
retraction, a waiting rebuild, the spool, errors and retries, the uploader's log lines for it)
and what the server, or the bucket in serverless mode, stored. Each check says `ok`, `warn`, `fail` or
`skip`, with a hint when something needs doing:

| Check | What it looks at |
|---|---|
| Decision | What the capture rules say now, and which rule said it (information) |
| Transcript | The file is there and is this session's, and is no shorter than what was sent |
| Queue | Hook entries, bytes not yet uploaded, retries, refusals, a retraction or rebuild waiting |
| Server presence | Stored when sent and stored; gone or tombstoned when turned off and retracted; nothing when filtered; a stub when review dropped the first upload (also after a resend answered `unchanged`) |
| Retraction secret | The secret kept here is the one the session was stored with |
| Offsets | Where the server's log ends agrees with what this machine sent (and a pause's stop); a warning, not a failure, while a replace review dropped waits for the transcript to grow, or when a pause stopped the session after a piece whose answer was lost |
| Records, Prefix hash | The transcript, normalized again up to the server's offset, has as many records as the server counts, and the same prefix hash (compared only under the same redaction rules; not after a redaction backfill rewrote the session, which leaves the prefix hash of the earlier rules, nor when the stored records keep an earlier rule's markers or a stub's dropped start was hashed under earlier rules; not when the server holds a piece this machine heard no answer for; a warning while a dropped replace waits) |
| Trace chain | Every trace can be fetched, continuations follow on, the total is the metadata's |
| Redaction residue | No redaction rule matches anything stored; a match names the rule and record, never the text |
| Staleness | The session was built by the current normalizer, or a rebuild is on its way |
| Change feed | The latest trace (or the tombstone) is in the change feed readers follow |
| Search | With `--deep`: found by a word of its last record; a deleted session is not |

It changes nothing (no uploads, state or spool entries) and exits 8 when a check failed. A server
never shows a stub, so against a server a dropped first upload is checked from this machine's
side only; serverless mode reads the bucket itself.

### Exploring sessions in a browser

```sh
seshi explore                     # opens http://127.0.0.1:<port>/?token=… in your browser
seshi explore --no-open --since 30d --port 8765
```

`seshi explore` is the doctor with a page: the same evidence and checks, for every session this
machine saw in the past 7 days (`--since` widens it). The list shows each session's capture glyph
(`◉`/`⏸`) and reason, its last answer and its worst check (as a word and an icon), with filters
and a refresh; the checks run in the background, a session at a time. Opening a session shows:

- the header: agent, id, folder, `Session Capture ◉/⏸` with the reason, visibility and where it
  is stored;
- the checks, failures first, with their hints;
- the pipeline: transcript bytes → records → redacted → sent → stored, with the gaps called out
  (the review-dropped prefix, a pause's stop, a filtered session, withheld tool results);
- **Records**: the transcript re-normalized by the current adapter and redacted with this
  machine's rules on the left (a redaction shows as the `[redacted:<rule>]` marker), what the
  server stored on the right, aligned by record index, with mismatches marked, the end of the
  server's log, a pause's stop and the dropped prefix drawn as dividers, and long records folded;
- **Timeline**: spool entries, uploader log lines, change entries, review decisions, toggles,
  pauses, retractions and rebuilds, by time;
- **Raw**: the evidence as JSON.

It is read-only: no uploads, no state writes, no spool entries, and only GETs to the server. It
listens on 127.0.0.1 only; every request needs the token in the address it prints (the page takes
it out of the address bar, so reloading needs the printed address again), requests naming another
host are refused, and the page loads nothing from the network. The transcript is never shown raw,
the retraction secret never leaves the machine (only its hash), and stored records are shown as
the server stored them.

## Files

| Where | What |
|---|---|
| `~/.local/state/seshi/` (`$XDG_STATE_HOME/seshi`; `%LOCALAPPDATA%\seshi` on Windows) | the capture folder, readable only by you |
| `state.json` | toggles, the pause and past pauses, where each paused session stopped, upload positions, retraction secrets, problems |
| `spool/` | one small file per hook event: paths and ids, never transcript text |
| `uploader.json` | the running uploader's process id and heartbeat; `uploader.json.takeover` exists for a moment while an uploader takes over a dead one's lock, so two never both do |
| `rules.json` | the capture rules as last read from the CLI config |
| `redaction-rules.json` | your server's redaction rules as last fetched, with their ETag |
| `capture.log` | errors from hooks and the uploader (hooks never print, except a Cursor Cloud hook saying what it could not upload) |
| `cursor-cloud` | the mark of a Cursor Cloud VM ([above](#hooks-on-everyone-elses-machines)) |
| `transcripts/opencode/` | OpenCode sessions as seshi was handed them, one `<id>.json` each, for captured sessions only: OpenCode keeps its own in a database. A session's copy goes when it is turned off, and the folder when OpenCode is uninstalled |
| `serverless/<id>/` | serverless mode, per bucket: the cached shared settings, the storage test's result, this machine's drop and failure records, the daemon's upkeep times ([serverless.md](serverless.md#what-a-laptop-writes-and-keeps)) |

`SESHI_NO_UPLOADER=1` makes hooks spool without starting an uploader (CI, tests).

## Not yet

- Cursor Cloud runs in a repository without seshi's committed hooks, through Cursor's API (F7).
- Tool results in Cursor sessions, local or cloud (from `postToolUse`).
- Session Capture in Cursor's Agents Window, which shows no extension's status bar item.
- A first-run notice inside Cursor that capture is on.
- Datadog Trajectory's local files.
- Backfilling OpenCode sessions no plugin handed over (`seshi upload --since` finds only those):
  for now, `opencode export <id> > s.json && seshi upload s.json`.
- pi's forks Oh My Pi and OpenClaw: their session files upload by hand; whether they load pi's
  extensions from the same folder is not checked.
