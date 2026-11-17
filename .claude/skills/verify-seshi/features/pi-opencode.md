# pi and OpenCode capture

pi and OpenCode run no shell hooks, so `seshi capture install pi opencode` writes a pi extension
and an OpenCode plugin that run `seshi hook pi|opencode <event>`. A pi session is uploaded from
its session file after each agent run, and pi's footer shows `Session Capture ◉/⏸`. An OpenCode
session is handed to seshi whole after each turn, written to the capture folder only when it is
captured, and uploaded whole; a toast says whether a new session is captured. `/seshi off|on|status`
works in both. Driven here with the real agents against a fake model, so no model is paid for.

## Sub-features

- `po-install`: `capture install pi opencode` writes `~/.pi/agent/extensions/seshi.ts`,
  `~/.config/opencode/plugins/seshi.js` and `~/.config/opencode/command/seshi.md`.
- `po-pi`: a pi session reaches the store, with its secrets redacted.
- `po-pi-tui`: pi's footer shows the status, and `/seshi off` turns the session off before upload.
- `po-oc`: an OpenCode session reaches the store whole, and a second turn re-uploads it whole.
- `po-oc-off`: `/seshi off` in OpenCode turns the session off, retracts it, and the model gets
  seshi's answer instead of the command.

## How to get to it (user POV)

- Run `seshi capture install pi opencode` (or `seshi capture install`, which finds both), then
  restart pi and OpenCode.
- Work in pi or OpenCode as usual. In pi, look at the footer and type `/seshi off`. In OpenCode,
  read the toast when a session starts and type `/seshi off`.
- Check with `seshi capture status`, `seshi sessions ls` and `seshi sessions show`.

## Driving it with control-seshi

Preconditions:

- A ready `--server` run (`$C up --server`; local mode's bucket is not set up for serverless
  writes). `pi` and `opencode` on the PATH (checked with pi 0.99.2 and OpenCode 1.18.31).
- The fake model running: `bun .claude/skills/verify-seshi/scripts/fake-model.ts 8799 &`.
- `R=$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/home`, and the agents pointed at the fake model:
  - `mkdir -p $R/.pi/agent $R/.config/opencode`
  - `$R/.pi/agent/models.json`: `{"providers":{"fake":{"baseUrl":"http://127.0.0.1:8799/v1","api":"openai-completions","apiKey":"fake","models":[{"id":"fake-1"}]}}}`
  - `$R/.config/opencode/opencode.json`: `{"provider":{"fake":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:8799/v1","apiKey":"fake"},"models":{"fake-1":{"name":"Fake 1","tool_call":false}}}},"model":"fake/fake-1","autoupdate":false,"share":"disabled"}`

Each agent command runs in the run's environment and its app folder:
`( eval "$($C env)"; cd $HOME/../app; <command> )`.

- **Install.** Run `$C cli --name install -- capture install pi opencode`. It lists the three
  files above, and `$C cli --name status -- capture status` shows `opencode installed` and
  `pi installed`.
- **pi session.** Run `PI_OFFLINE=1 pi -p --provider fake --model fake-1 --no-tools "Where is the
  login handler? AKIAIOSFODNN7EXAMPLE is in my env"`, then `$C cli --name flush -- daemon --once
  --json` (`"uploaded": 1`). `sessions ls` lists `pi/<id>` with 3 records in `app (main)`, and
  the stored trace (`gzcat` the bucket's `trace.*.json.gz`) has `[redacted:aws-access-key]`.
- **pi footer and /seshi.** Run pi's TUI under `script` (no tmux needed): `( sleep 4; printf
  'Where is the logout handler?'; sleep 0.5; printf '\r'; sleep 5; printf '/seshi off'; sleep 0.5;
  printf '\r'; sleep 6 ) | script -q $E/pi-tui.typescript pi --provider fake --model fake-1
  --no-tools`, then send the `pi` process `SIGHUP`. With the escapes stripped (`perl -pe
  's/\e\[[0-9;?]*[ -\/]*[@-~]//g'`), the typescript has `Session Capture ◉` and then
  `Session Capture ⏸ · turned off for this session; nothing of it was uploaded`. After a flush,
  `sessions ls` does not list that session, and the run's `state.json` has it with
  `"toggle":"off"`.
- **OpenCode session.** Run `opencode run -m fake/fake-1 "Where is the login handler? My token
  is ghp_abcdefghijklmnopqrstuvwxyz0123456789 btw"`. The run's
  `home/.local/state/seshi/transcripts/opencode/ses_<id>.json` exists, mode `0600`. After a flush,
  `sessions ls` lists `opencode/ses_<id>` with 3 records, and its trace has
  `[redacted:github-token]`.
- **Second turn.** Run `opencode run -m fake/fake-1 -s ses_<id> "And the logout handler?"` and
  flush: the same session now has 5 records.
- **/seshi off in OpenCode.** Run `opencode run -m fake/fake-1 -s ses_<id> --command seshi
  "off"` and flush: the daemon reports `"retracted": 1` and `sessions ls` shows the session as
  `deleted`. `opencode export --pure ses_<id>` ends with a user message that starts
  `Session Capture ⏸ · turned off for this session`.

## Gotchas

- The server filters sessions under 2,000 characters (`filtered` in `state.json`, nothing in
  `sessions ls`): the fake model's replies are long for that reason. Do not shorten them.
- Piping `pi -p` into `head` makes pi crash with EPIPE on its own output; capture is not at fault.
  Let it write in full.
- OpenCode downloads `@ai-sdk/openai-compatible` into the run's cache the first time.
- Two Ctrl-Cs do not quit pi's TUI under `script`; `SIGHUP` (a closed terminal) does, and pi
  still sends `SessionEnd`.
- pi started from a shell another agent started inherits `SESHI_SESSION_ID`; the extension and
  plugin ignore it and always name their own session.
