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
| Cursor (IDE and CLI) | hooks in `~/.cursor/hooks.json`, the Cursor CLI's status line in `~/.cursor/cli-config.json`, and the `/session-capture` skill in `~/.cursor/skills/session-capture/`; it suggests the status bar extension ([below](#the-cursor-status-bar)) | stop, sessionEnd; postToolUse, postToolUseFailure and beforeReadFile for tool results ([below](#tool-results-in-cursor)); beforeSubmitPrompt for `/session-capture` and the last chat prompted |
| pi | the extension `~/.pi/agent/extensions/seshi.ts` (`PI_CODING_AGENT_DIR` moves it) | agent_end (Stop), session_shutdown (SessionEnd, not on `/reload`); `/session-capture`, a command of its own; plus the sweep of `~/.pi/agent/sessions`, or of the folder `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in pi's settings names |
| OpenCode (1.x and 2.x) | the plugin `~/.config/opencode/plugins/seshi.js`, the TUI plugin `~/.config/opencode/seshi/tui.js` with its entry in `tui.json`'s `plugin` list (1.x) and the folder's in `cli.json`'s `plugins` list (2.x), and the `/session-capture` command `~/.config/opencode/command/session-capture.md` (`XDG_CONFIG_HOME` moves them) | 1.x: session.idle (Stop), with the whole session. 2.x: the `experimental.idle` hook, or the end of a run that failed or was interrupted (Stop), naming the session. session.created (SessionStart) for the notice; `/session-capture` |

pi and OpenCode run no shell hooks: they load code at start-up, so seshi installs a file each
loads, written whole (and rewritten by the next `install`, so edits do not last) and removed by
`uninstall`. It runs `seshi hook pi|opencode <event>` with a JSON payload on stdin, as the other
agents' hooks do, so the rules, the spool and the uploader are the same. A file of the same name
that is not seshi's is left alone, and that agent is not captured. Restart pi (or `/reload`) and
OpenCode after `install`. Started with `--no-extensions` (pi) or `--pure` (OpenCode), or with
`--no-session` (pi), they capture nothing. pi's session files are append-only JSONL with the
folder in their first line, so they upload in chunks and the sweep and `seshi upload --since`
find sessions no hook saw. OpenCode keeps its sessions in a database, not in files, and seshi
keeps each one in the shape OpenCode 1.x's `opencode export` prints (`{info, messages}`), whichever
OpenCode wrote it. The same two plugin files serve both of OpenCode's release lines (one default
export each: 1.x reads its `server` or `tui`, 2.x its `setup`). On 1.x, after each turn the plugin
reads the session through OpenCode's own client and hands it to seshi whole. On 2.x a plugin can
read no whole session, so it names the session, in the hook OpenCode awaits before a session goes
idle (`experimental.idle`, from 2.2.1; before that, and for a run that failed or was
interrupted, when the run ends), and seshi reads it from OpenCode's database. Either way seshi
writes it to `transcripts/opencode/` in the capture folder, only for a session it captures, and
uploads it whole each time. OpenCode has no end-of-session event, so its sessions end when the
uploader finds them quiet. A subagent's session (OpenCode's task tool) is captured as its own
session with its parent's id.

The sweep and `seshi upload --since` also read OpenCode's database, read-only, for the sessions
the plugin never handed over (from before `install`, or a run without the plugin) and for turns
it missed: `opencode.db` in OpenCode's data folder (`XDG_DATA_HOME` moves it) and each
`opencode-<channel>.db` beside it, which 2.x keeps for some release channels, or only the file
`OPENCODE_DB` names in the environment seshi runs in (a 2.x plugin also says its release channel,
so its hook reads that channel's file). A captured session found there is written to
the same `transcripts/opencode/<id>.json` the plugin writes, only when that copy is missing or
older than the database and holds something else (keys in another order, a newer
`time.updated`, or the session's totals OpenCode works out after a turn, its `cost`, `tokens` and
`summary`, and the file changes 1.x works out for each prompt, do not count; a new title does),
so a session is uploaded once whichever way seshi found it. The uploader's sweep also catches up
a session it already knows however long ago it started, when its hook could not read a turn.
seshi tells which OpenCode wrote the database from its tables: 1.x's `session`, `message` and
`part`, 2.x's `session_v2` and `session_message` (and `session_part`, from 2.2.2). OpenCode 2.x
copies a 1.x database's sessions into its own tables once, keeping only each message's last step
of usage, so a session in both is read from 1.x's copy, with only the messages said since in
2.x read from 2.x's. seshi never
runs OpenCode for this; a database it does not know (an early 2.x preview's among them) is
skipped, and `seshi upload --since` says why.

OpenCode 1.x's TUI loads its plugins from the `plugin` list in `tui.json`, so `install` adds
seshi's TUI plugin there and keeps every other entry and setting; `uninstall` takes out only that
entry (and the file, when nothing but its `$schema` is left). OpenCode also reads a `tui.jsonc`,
but a `tui.json` with comments is left alone, since rewriting it would drop them: `install` and
`capture status` say what to add to its `plugin` list by hand. OpenCode 2.x's TUI reads the
`plugins` list in `cli.json` instead, and loads a local plugin from its folder (`tui.js` in it):
`install` lists `~/.config/opencode/seshi` there, in place of the file entry 2.x copies over from
`tui.json`, which it cannot load. 2.x writes `cli.json` when it first starts, and seshi never
creates it (2.x would then not copy your `tui.json` over), so after a first start of OpenCode
2.x, run `seshi capture install opencode` again; `capture status` says so until then. seshi
changes `cli.json` holding the lock OpenCode 2.x holds on it, so neither undoes the other's
change; if OpenCode holds it for more than a few seconds, `install` leaves the file alone and
says to run it again. Capture
works without the TUI plugin; only the status and `/session-capture` without a model turn need
it.

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

seshi does not capture Cursor Cloud agents through hooks. A cloud agent's VM writes no transcript
file for a hook to upload, and committed hooks would need a seshi install and secrets in every
repository. Cloud agents are read from Cursor's Cloud Agents API instead, by a
[Cursor Cloud source](cursor-cloud.md) (F7): a poller lists each agent's runs and stores their
event streams, with nothing in the repository and nothing on the VM.

An earlier seshi could commit hooks for cloud agents (`seshi capture install cursor --project`).
If a repository has them, remove `.cursor/seshi-cloud.sh`, its two steps in
`.cursor/environment.json`, and the `seshi hook cursor … --cloud` entries in `.cursor/hooks.json`.
Off a cloud VM they do nothing: the shell line exits before it starts seshi, and this seshi ignores
a hook that passes `--cloud`. On a cloud VM they keep capturing: `.cursor/seshi-cloud.sh` installs
the seshi release that wrote it, which still marks the VM and uploads every run under
`cursor-cloud`. To stop that at once, revoke the token from the server
(`seshi tokens revoke --owner cursor-cloud`), then remove the files.

## Tool results in Cursor

Cursor's agent transcript records each tool call, never what it returned. Its hooks see the
results, so seshi installs three more hooks for Cursor, and Cursor runs them on every tool call:

| Hook | What seshi keeps from it |
|---|---|
| `postToolUse` | the tool's output: a shell command's output (`tool_output.output`; an exit code other than 0 marks it an error), an MCP tool's text, and for other tools Cursor's JSON as it is: `{"file_path":…,"success":true}` for an edit, `{"pattern":…,"success":true}` for a Grep or Glob (Cursor gives no matches), the subagent's id and status for a Task |
| `postToolUseFailure` | the error message of a call that failed (a command that exited non-zero, a file not found), as an error |
| `beforeReadFile` | the text of a file the agent reads: a Read's `postToolUse` gives only `{"file_path":…,"content_length":…}`. Cursor gives at most 100,000 characters. The hook prints nothing, so it never blocks a read (a `beforeReadFile` hook that prints nothing, or fails, lets the read go ahead) |

**What a result costs**: each tool call starts `seshi hook cursor <event>` once (twice for a
read), which judges the session as any hook does and writes one file of at most 32,000
characters. It reaches no network and starts no uploader. Measured on an M-series Mac with the
compiled binary: 16 ms for a short result, 31 ms for a 1.4 MB one (seshi's `--version` alone
takes 20 ms). Cursor waits for it before the agent goes on.

**What is kept, and where**: one file per hook in `kept/cursor/<conversation>/results/`, readable
only by you, and only for a captured session: a session turned off (`/session-capture off`),
paused, or in a folder the capture rules exclude keeps nothing. Turning a session off removes
what it kept, and so does a rule that turns it off later (a folder, the repo), at its next tool
call or the next sweep. A command or MCP arguments are kept only as a digest, to tell calls apart;
a result is removed once it is in the uploaded file. A result longer than 32,000 characters keeps its head and tail with
`[… N characters cut by seshi …]` between them (the normalizer stores at most 2,500 characters of
any result, as for every agent). A conversation that never shows up in the state file (a Task's
subagent, whose tools carry its own conversation id) is removed a day after its last result.

**What is uploaded**: before it reads a Cursor session, the uploader brings
`kept/cursor/<conversation>/transcript.jsonl` up to date and uploads it instead of the
transcript: the transcript's complete lines as they are, except that a line whose calls have
results gets each answered call's `tool_use_id`, and is followed by one
`{"role":"user","message":{"content":[{"type":"tool_result",…}]}}` line per result. These are
Cursor's own shapes, so every reader of Cursor transcripts (the normalizer, redaction,
`seshi normalize`) takes them as they are. The session's upload positions are kept in that
file; a session uploaded before this change goes on where it was, since the file holds the
transcript's bytes until the first result.

- **Matching**: the transcript's calls carry no id, and the hooks' names and inputs often differ
  from the transcript's (a StrReplace is a Read and a Write under one id; an MCP call is
  `MCP:<tool>` to the hook and `CallDynamicTool` with a `toolName` in the transcript; a Glob is a
  Grep with an empty pattern). The hooks of one call share its `tool_use_id`. Each call takes the
  first result, in the order they came, of the same kind of tool, and of the same command, path,
  pattern or MCP arguments when both sides say (a path the model wrote relative matches the
  absolute one the hooks give). Cursor runs a call's hooks before it writes the
  line holding the call, so a line's results are all kept by the time the line can be read; calls
  in one line (parallel tools) are matched however their results came.
- **A call whose result never came** (a tool without a hook, such as GetDynamicTools, or a hook
  that failed) is uploaded without one. **A result no call takes** is let go once a later result
  has been taken, or after a minute. **A result kept after its call was uploaded** (only if its hook outlived its
  timeout) is let go too: a result is never added before a line already sent, so the server's
  stored prefix never changes.
- **Uploaded twice**: the file only grows, so a session sent again, or whole (`seshi capture
  resend`), carries each result once. If Cursor rewrites the transcript (it no longer starts with
  what was composed), the file is composed again from the start, as the transcript would have been
  sent, with only the results no call had taken yet. A session where neither the transcript nor
  its results changed is not composed again.
- **Redaction** works on these lines as on any transcript's, before upload and again on the
  server: secrets in a result are replaced, and a call that reads a sensitive file or runs a
  secret command keeps its call while its result is withheld (it has the call's id).
- Not captured: Grep and Glob matches (Cursor's hook gives none), a subagent's own transcript and
  results (seshi does not capture Cursor subagents yet), and what the agent read through tools
  that fire no hook.
- A Read Cursor refused as too large reports success to its hooks, with the file's first 100,000
  characters, while the model was told it failed: seshi keeps that text.

Cursor's own database (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` on a
Mac) also keeps tool results, per IDE conversation (not the CLI's). Its `bubbleId:<conversation>:
<bubble>` rows hold `toolFormerData.result`: a shell command's output and an MCP tool's result
(JSON in a JSON string), but for a read only `{"totalLinesInFile":N}`. Opened with `immutable=1`
it misses what is still in the write-ahead log (recent conversations); `mode=ro` reads it while
Cursor runs. seshi does not read it: filling in sessions stored before this change from it would
add shell and MCP results to IDE sessions on the laptop that ran them, never a read's text, a
CLI or cloud session's results.

## What is captured

One decision function judges every session, the same for hooks, the sweep, the status line and
`seshi upload` (F9.3):

1. **Shared rules can only turn capture off, and always win.** The org's exclude list, which
   the server holds and the uploader downloads ([below](#the-orgs-exclude-list-on-a-laptop)),
   together with this machine's own `capture.exclude` (never the repositories and folders
   either lists); the org rule in a managed CLI config (`capture.remotes`: only repos whose git
   remote matches); and a repo's own committed `.seshi/config.toml` with `capture = false`. They hold for every folder a session was seen
   in: a session that worked in an excluded repo and then moved into a captured one (a nested
   repo, `--add-dir`) carries that work in its transcript, so it is not uploaded, and nothing
   more of a captured session is sent once it works in an excluded repo. A subagent is judged
   by its parent's folders too (and the parent's parent's): what the parent did in an excluded
   repo reaches the subagent through its task, so it is not uploaded, wherever it runs. What
   it uploaded before stays (rule changes do not retract). A session an entry of the exclude
   list turned off stays off for good: it is recorded as `excluded` in the state file, and a
   later change of its folder (another remote) or of the list does not send it.
   `seshi capture resend --session <id>` sends it, judged again, if no entry names it any more.
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

A session the rules capture is uploaded whole, unless it ran in a place the org lists in
`capture.redact_tool_calls`: then it goes with its tool calls redacted, below.

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

### Tool calls redacted

For a repository or folder whose code should not be stored, but whose sessions still teach how
people work there, the org lists it in the server's `[capture] redact_tool_calls`
([config.md](config.md#the-orgs-tool-call-redaction-list-capture-redact_tool_calls)) instead of
its exclude list. The uploader downloads that list with the exclude list (`GET
/v1/capture/rules`, kept in `capture-rules.json`, [below](#the-orgs-exclude-list-on-a-laptop))
and applies it with this machine's own `capture.redact_tool_calls`, which can only add entries.
A session in a listed place is uploaded with every tool call's input and output replaced by
`[redacted:tool-call]`, on the laptop, before anything else redacts it and before a byte leaves:

| Part of the session | Uploaded |
| --- | --- |
| The person's prompts | as written, then redacted as usual |
| The agent's replies and reasoning | as written, then redacted as usual |
| Each tool call's name and id, and their order | kept |
| Whether a call failed (`is_error`, `isError`, a status) | kept |
| A call's input | its keys, numbers and booleans kept; every string replaced |
| A call's result, also where the log repeats it (Claude Code's `toolUseResult`, Cursor's results from its hooks) | every string replaced; an output that is not the agent's own structure is replaced whole, keys and numbers included |
| The output of a command the person ran themselves (Claude Code's `!`, Codex's `<user_shell_command>`, pi's `bashExecution`; the command is kept), a background task's result (`<task-notification>`), text a tool or plugin added to the conversation (a skill's body, OpenCode's synthetic parts, pi's extension messages) | replaced |
| A compaction's summary of the conversation so far (Claude Code's, Codex's, pi's), which quotes what tools read and printed | replaced |
| A subagent's session (Claude Code's, Codex's) | not uploaded: all of it is its parent's tool call, whose name, id and failure the parent's log keeps |
| Anything else in the log the pass does not know (a new record kind, a new field) | replaced |

Each agent has its own pass, which knows where its format keeps tool calls (Claude Code, Codex,
Cursor, OpenCode, pi); there is no generic fallback. What a pass does not recognize is blanked
rather than sent, so a format that adds a record kind loses text from it instead of leaking a
tool's output. An agent without a pass sends nothing from such a place (`seshi capture status`
shows the session as refused, `tool_calls_not_redactable`).

What this does not catch: **the agent's own words can quote what a tool returned** ("the query
returned 4,812 rows", a stack trace it pastes back, a diff it describes), and a person can paste
code into a prompt. The org's redaction patterns still run on that text, as on any session. The
rule applies at upload time: sessions uploaded before a place was listed keep what they had, and
a session that ran there before the list reached the laptop has only its later pieces redacted.

The pass changes the length of nearly every line, so the uploader keeps its place in your file
apart from the server's offset in redacted bytes, as for any pre-redaction; a log sent again
whole (`seshi capture resend`, a `replace`) redacts to exactly the pieces sent before.

`seshi capture status` names the entry and where it came from (`tool calls: redacted, the org
redacts tool calls in acme/research (https://seshi.acme.dev's [capture] redact_tool_calls)`, or
`(capture.redact_tool_calls)` for this machine's; in `--json`, `redact_tool_calls` is that
reason and `redacted` is `{ entry, from: "server" | "config", server? }`).

The server applies the list too, to what no laptop redacted: its own sources (a Cursor Cloud
agent, [cursor-cloud.md](cursor-cloud.md#the-orgs-tool-call-redaction-list)) and, as a backstop,
any upload whose `repo` an entry names (a laptop running an older seshi, or one whose copy of
the list is old). It redacts the normalized records the same way: a tool call's arguments and
its result, what a background task or a command the person ran returned in the conversation,
and every text of a subagent's session (usually leaving too little to keep). What is only in a
raw log's structure, a compaction's summary, cannot be told apart in the records and comes
through from an older laptop as it was.

### Content an agent or a plugin adds

Agents and their plugins add text to a user's turn that the person never typed: a file read
for an `@` mention, a repository rule, a digest of what a memory service already knows. The
model sees it, so seshi stores it, labelled `synthetic: true` on its user record, so readers can
tell it apart from what the member typed. OpenCode marks such text parts `synthetic`; pi keeps
what its extensions add as `custom_message` entries, which seshi stores as the user messages the
model saw.

An integrator that adds content it does not want stored (its own output coming back, say) sets
`session_capture.omit = true` in the metadata the agent keeps beside it: an OpenCode part's
`metadata`, a pi `custom_message`'s `details`. An OpenCode part, for example:

```json
{ "type": "text", "synthetic": true, "text": "…", "metadata": { "session_capture": { "omit": true } } }
```

seshi then leaves its text out before redaction, so it reaches neither the server nor the
store, and keeps a user record in its place with empty content and `omitted: 1`, which counts
it. This works the same for live capture, `seshi upload`, `seshi normalize`, S3 sources, and
in server and serverless mode, since all of them read transcripts through the same formats. The
flag counts only when it is exactly `true`, and only on user-side input and injected context:
on what the model wrote or a tool returned it is ignored, so a model cannot hide its own output
and a tool result is never lost. Claude Code, Codex and Cursor keep no such metadata, so the
flag does not apply to them. See [formats.md](formats.md#content-an-agent-or-a-plugin-adds) for
the details per format.

Sessions stored before seshi honoured the flag keep the injected text until they are sent
again. A format change like this makes them stale, so the uploader resends them within a day
(`seshi capture resend` does it now).

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
the only cost. OpenCode 2.x does the same: its TUI plugin puts the status in the prompt's footer
and takes `/session-capture` as a slash command of its own (nothing is sent), and its toasts come
from the TUI plugin; `/session-capture` that reaches 2.x's server (the command file, from the web
UI, or typed into `opencode run`) is carried out by seshi's server plugin before the prompt is
sent, and the model gets the answer instead, as on 1.x. Once seshi has said a 1.x session is not
captured (at its start, or by `/session-capture`), the
server plugin stops reading and handing over its turns, until seshi's status line says it is
captured again (after the TUI's `/session-capture on`, or `seshi capture on --session`). In both agents,
the extension and the plugins pass the session's id themselves: seshi's own `SESHI_SESSION_ID`,
set in a shell another agent started, is ignored.

The Claude desktop app's Code tab has no status line. There, seshi's Claude Code plugin draws the
same words as a chip in the prompt footer; clicking it turns capture off or on for the session,
and `/session-capture [on|off|status]` does the same by command. It needs the plugin installed
(`/plugin install seshi --marketplace dosu-ai/seshi`), not just `seshi capture install`; see
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
a few milliseconds (X3.3); Cursor's tool-result hooks write the result beside the session instead,
and start no uploader ([above](#tool-results-in-cursor)). The uploader (`seshi daemon`) is started by a hook when it is not
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

With each upload go where the session ran, read from `.git` without running git: the repository's
remote (`origin`, else the first, lowercase and without credentials: `github.com/acme/app`), the commit `HEAD`
named when the hook fired (read when the upload goes for a session only the sweep found), the folder relative to the repository's root (never the absolute path), the repository's
folder name as `project`, the branch, and seshi's version and platform. Cursor's transcripts name
neither Cursor's version nor the model, so its hooks keep what their payloads say
(`cursor_version`, `model`) and the uploader sends them too.

It follows the server's answers: a `409 offset_mismatch` resends from where the server says (the
whole log when it says 0); a `409 conflict` on a session this machine wrote (the rules or the
normalizer changed) resends it with `replace`; `403 excluded` (the org's exclude list names the
session's repository) settles the session as excluded, and nothing more of it is sent
(`seshi capture resend --session <id>` tries it again, after the list changed);
other `403`s and `422` wait until the transcript changes; anything else is retried with backoff. Every 15 minutes it sweeps the agents' transcript folders
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

### The org's exclude list on a laptop

The org's exclude list is the server's (`[capture] exclude`,
[config.md](config.md#the-orgs-exclude-list-capture-exclude)). Before it uploads, the uploader
fetches it (`GET /v1/capture/rules`) and keeps it in `capture-rules.json` with its ETag; while it
runs it asks again every 5 minutes, and an unchanged list costs a `304`. Hooks, the status line
and `seshi capture status` read that copy, never the network. The list in force is the server's
entries followed by this machine's own `capture.exclude`: an entry in either keeps a session on
the machine, so a person's config can add to the org's list, never take from it.
`seshi capture status` names the entry that decided and where it came from (`the org excludes
acme/payroll (https://seshi.acme.dev's [capture] exclude)`, or `(capture.exclude)`; in `--json`,
`excluded: { entry, from: "server" | "config", server? }`; such a session's state is `not sent`). The copy keeps the list already read
for this machine (`~` expanded, folders' links resolved), so hooks do not read it again. The
server's tool-call redaction list comes in the same copy and is applied the same way
([Tool calls redacted](#tool-calls-redacted)); a server older than that list serves none.

- **Before its first copy** from the server it uploads to, the uploader sends that server
  nothing: what it would send may be on the list. It asks again with backoff, the uploads wait
  with their place kept, and the status line says `upload failing` with the reason at once. A copy
  of another server's list (before `seshi login` to a new one) is not this server's, so it is
  fetched first too; hooks go on applying the last copy meanwhile.
- **When a later fetch fails**, the copy it has stays in force. A copy that cannot be written
  (a full disk, a permission) is no copy: uploads wait, and the uploader says why.
- **A server older than the route** answers 404: it has no list, and only this machine's
  `capture.exclude` applies, as before. The uploader asks again every 5 minutes, so an upgraded
  server's list is picked up.
- **A changed list** applies from the next fetch: a session in a newly listed place sends
  nothing more. What it uploaded before stays on the server (rule changes do not retract). An
  entry taken off the list does not send what it kept off: every session an entry decided stays
  off (`excluded` in `seshi capture status`), as a Cursor Cloud agent's runs made while it was
  excluded are never read ([cursor-cloud.md](cursor-cloud.md#the-orgs-exclude-list)).
  `seshi capture resend --session <id>` sends one by name; `resend --all` passes them over.

In serverless mode the list is the `[capture] exclude` of the server config the laptop runs: the
bucket's shared settings and this machine's `serverless.config`. The uploader keeps a copy of it
the same way, read when the bucket is opened.

### Labels

A session's [labels](config.md#labels) are resolved once, when seshi first sees it, and kept in
the capture state: every upload of it sends the same labels, even after the session moves to
another folder or the environment changes.

- **A session a hook saw** is resolved in that hook, which runs in the agent's environment, so
  `{ env = "NAME" }` reads the agent's variables (the background uploader is a process of its
  own and does not have them). The first hook that sees the session decides; later hooks
  resolve nothing.
- **A session only the sweep found** (no hook ran for it) is resolved by the uploader, with the
  uploader's environment and the folder the session's transcript names. So is a session first
  seen before labels existed, at its next upload. A hook that sees the session before it is first
  sent replaces those labels with its own (the sweep can find a session before its hook's entry
  reaches the spool).
- **`seshi upload`** resolves a session it adds with the environment it runs in and the folder
  the transcript names; a session the state already holds keeps its labels.

The server keeps a session's labels from the first upload that carries any: a later upload with
other labels (from another machine, say) does not change them, but a `replace` may
([server.md](server.md#labels)). A label out of the limits is left out, never a reason to fail
a hook; `capture.log` in the capture folder ([Files](#files)) and `seshi doctor` say why.

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

Nothing a rule knows leaves the machine. Before each piece is sent, the uploader replaces its
tool calls' detail when the org lists the session's place in `capture.redact_tool_calls` (see
[Tool calls redacted](#tool-calls-redacted)), then redacts what is left with
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
retracted the same way. `--since` takes the sessions that started within that time: the installed
agents' transcript files, and OpenCode's sessions from its own database (see
[Installing](#installing)). If the background uploader is running it does the work, and this
command waits for it. A session it adds gets its [labels](#labels) from the environment
`seshi upload` runs in and the folder its transcript names.

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

Before the sessions, a **Hooks** section warns about an agent whose hooks are only partly
installed, such as Cursor's installed before seshi kept tool results (`hooks missing for
postToolUse, postToolUseFailure, beforeReadFile`): `seshi capture install <agent>` adds them,
keeping everything else. `seshi capture status` says the same.

`seshi doctor` reads the three views of a session that only this machine has together: the
transcript, the capture state (the decision and why, offsets, a pause's stop, the toggle and
retraction, a waiting rebuild, the spool, errors and retries, the uploader's log lines for it)
and what the server, or the bucket in serverless mode, stored. For a Cursor session the transcript
it checks against is the one uploaded, with the tool results added. Each check says `ok`, `warn`, `fail` or
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
| `capture-rules.json` | your server's capture rules (the org's exclude list) as last fetched, with their ETag and the server they came from ([above](#the-orgs-exclude-list-on-a-laptop)) |
| `capture.log` | errors from hooks and the uploader (hooks never print) |
| `kept/cursor/<conversation>/` | a captured Cursor session's tool results as its hooks kept them (`results/`), and the file uploaded for it, its transcript with the results added (`transcript.jsonl`, `compose.json`) ([above](#tool-results-in-cursor)). Removed when the session is turned off, and a day after the session leaves the state file |
| `transcripts/opencode/` | OpenCode sessions as seshi was handed them, or read them from OpenCode's database in a sweep, one `<id>.json` each, for captured sessions only: OpenCode keeps its own in a database. A session's copy goes when it is turned off, and the folder when OpenCode is uninstalled |
| `serverless/<id>/` | serverless mode, per bucket: the cached shared settings, the storage test's result, this machine's drop and failure records, the daemon's upkeep times ([serverless.md](serverless.md#what-a-laptop-writes-and-keeps)) |

`SESHI_NO_UPLOADER=1` makes hooks spool without starting an uploader (CI, tests).

## Not yet

- Cursor Cloud agents, through Cursor's API (F7).
- Cursor subagents (`agent-transcripts/<id>/subagents/`), and their tool results.
- Tool results for Cursor sessions stored before seshi kept them, from Cursor's database
  ([above](#tool-results-in-cursor)): shell and MCP results only, IDE sessions only.
- Session Capture in Cursor's Agents Window, which shows no extension's status bar item.
- A first-run notice inside Cursor that capture is on.
- Datadog Trajectory's local files.
- A release channel's own `opencode-<channel>.db` in the sweep (a 2.x plugin's hand-over reads
  it; name one with `OPENCODE_DB` for the sweep). OpenCode 2.x's own `opencode session export`
  is not an upload format: seshi tells it from 1.x's and leaves it out.
- An OpenCode 2.x fork carries a copy of its source session's messages, uploaded with both.
- pi's forks Oh My Pi and OpenClaw: their session files upload by hand; whether they load pi's
  extensions from the same folder is not checked.
